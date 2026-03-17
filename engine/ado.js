/**
 * engine/ado.js — Azure DevOps integration for Squad engine.
 * Extracted from engine.js: ADO token management, PR status polling, human comment polling.
 */

const shared = require('./shared');
const { exec, getAdoOrgBase } = shared;
const { getPrs } = require('./queries');

// Lazy require to avoid circular dependency
let _engine = null;
function engine() {
  if (!_engine) _engine = require('../engine');
  return _engine;
}

// ─── ADO Token Cache ─────────────────────────────────────────────────────────

let _adoTokenCache = { token: null, expiresAt: 0 };

function getAdoToken() {
  if (_adoTokenCache.token && Date.now() < _adoTokenCache.expiresAt) {
    return _adoTokenCache.token;
  }
  try {
    const token = exec('azureauth ado token --mode broker --output token --timeout 10', {
      timeout: 30000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true    }).trim();
    if (token && token.startsWith('eyJ')) {
      _adoTokenCache = { token, expiresAt: Date.now() + 30 * 60 * 1000 };
      return token;
    }
  } catch (e) {
    engine().log('warn', `Failed to get ADO token: ${e.message}`);
  }
  return null;
}

async function adoFetch(url, token, _retryCount = 0) {
  const MAX_RETRIES = 1;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`ADO API ${res.status}: ${res.statusText}`);
  const text = await res.text();
  if (!text || text.trimStart().startsWith('<')) {
    if (_retryCount < MAX_RETRIES) {
      _adoTokenCache = { token: null, expiresAt: 0 };
      const freshToken = getAdoToken();
      if (freshToken) {
        engine().log('info', 'ADO token expired mid-session — refreshed and retrying');
        return adoFetch(url, freshToken, _retryCount + 1);
      }
    }
    throw new Error(`ADO returned HTML instead of JSON (likely auth redirect) for ${url.split('?')[0]}`);
  }
  return JSON.parse(text);
}

// ─── Shared PR Polling Loop ──────────────────────────────────────────────────

/**
 * Iterate active PRs across all projects. Calls `callback(project, pr, prNum, orgBase)`
 * for each active PR. If callback returns truthy, the PR file is saved after the project loop.
 */
async function forEachActivePr(config, token, callback) {
  const projects = shared.getProjects(config);
  let totalUpdated = 0;

  for (const project of projects) {
    if (!project.adoOrg || !project.adoProject || !project.repositoryId) continue;

    const prs = getPrs(project);
    const activePrs = prs.filter(pr => pr.status === 'active');
    if (activePrs.length === 0) continue;

    let projectUpdated = 0;

    for (const pr of activePrs) {
      const prNum = (pr.id || '').replace('PR-', '');
      if (!prNum) continue;

      try {
        const orgBase = getAdoOrgBase(project);
        const updated = await callback(project, pr, prNum, orgBase);
        if (updated) projectUpdated++;
      } catch (err) {
        try { engine().log('warn', `Failed to poll status for ${pr.id}: ${err.message}`); } catch {}
      }
    }

    if (projectUpdated > 0) {
      shared.safeWrite(shared.projectPrPath(project), prs);
      totalUpdated += projectUpdated;
    }
  }

  return totalUpdated;
}

// ─── PR Status Polling ───────────────────────────────────────────────────────

async function pollPrStatus(config) {
  const e = engine();
  const token = getAdoToken();
  if (!token) {
    e.log('warn', 'Skipping PR status poll — no ADO token available');
    return;
  }

  const totalUpdated = await forEachActivePr(config, token, async (project, pr, prNum, orgBase) => {
    const repoBase = `${orgBase}/${project.adoProject}/_apis/git/repositories/${project.repositoryId}/pullrequests/${prNum}`;
    let updated = false;

    const prData = await adoFetch(`${repoBase}?api-version=7.1`, token);

    let newStatus = pr.status;
    if (prData.status === 'completed') newStatus = 'merged';
    else if (prData.status === 'abandoned') newStatus = 'abandoned';
    else if (prData.status === 'active') newStatus = 'active';

    if (pr.status !== newStatus) {
      e.log('info', `PR ${pr.id} status: ${pr.status} → ${newStatus}`);
      pr.status = newStatus;
      updated = true;

      if (newStatus === 'merged' || newStatus === 'abandoned') {
        await engine().handlePostMerge(pr, project, config, newStatus);
      }
    }

    const reviewers = prData.reviewers || [];
    const votes = reviewers.map(r => r.vote).filter(v => v !== undefined);
    let newReviewStatus = pr.reviewStatus || 'pending';
    if (votes.length > 0) {
      if (votes.some(v => v === -10)) newReviewStatus = 'changes-requested';
      else if (votes.some(v => v >= 5)) newReviewStatus = 'approved';
      else if (votes.some(v => v === -5)) newReviewStatus = 'waiting';
      else newReviewStatus = 'pending';
    }

    if (pr.reviewStatus !== newReviewStatus) {
      e.log('info', `PR ${pr.id} reviewStatus: ${pr.reviewStatus} → ${newReviewStatus}`);
      pr.reviewStatus = newReviewStatus;
      updated = true;
    }

    if (newStatus !== 'active') return updated;

    const statusData = await adoFetch(`${repoBase}/statuses?api-version=7.1`, token);

    const latest = new Map();
    for (const s of statusData.value || []) {
      const key = (s.context?.genre || '') + '/' + (s.context?.name || '');
      if (!latest.has(key)) latest.set(key, s);
    }

    const buildStatuses = [...latest.values()].filter(s => {
      const ctx = ((s.context?.genre || '') + '/' + (s.context?.name || '')).toLowerCase();
      return ctx.includes('codecoverage') || ctx.includes('build') ||
             ctx.includes('deploy') || ctx.includes('ci/');
    });

    let buildStatus = 'none';
    let buildFailReason = '';

    if (buildStatuses.length > 0) {
      const states = buildStatuses.map(s => s.state).filter(Boolean);
      const hasFailed = states.some(s => s === 'failed' || s === 'error');
      const allDone = states.every(s => s === 'succeeded' || s === 'notApplicable');
      const hasQueued = buildStatuses.some(s => !s.state);

      if (hasFailed) {
        buildStatus = 'failing';
        const failed = buildStatuses.find(s => s.state === 'failed' || s.state === 'error');
        buildFailReason = failed?.description || failed?.context?.name || 'Build failed';
      } else if (allDone && !hasQueued) {
        buildStatus = 'passing';
      } else {
        buildStatus = 'running';
      }
    }

    if (pr.buildStatus !== buildStatus) {
      e.log('info', `PR ${pr.id} build: ${pr.buildStatus || 'none'} → ${buildStatus}${buildFailReason ? ' (' + buildFailReason + ')' : ''}`);
      pr.buildStatus = buildStatus;
      if (buildFailReason) pr.buildFailReason = buildFailReason;
      else delete pr.buildFailReason;
      updated = true;
    }

    return updated;
  });

  if (totalUpdated > 0) {
    e.log('info', `PR status poll: updated ${totalUpdated} PR(s)`);
  }
}

// ─── Poll Human Comments on PRs ──────────────────────────────────────────────

async function pollPrHumanComments(config) {
  const e = engine();
  const token = getAdoToken();
  if (!token) return;

  const totalUpdated = await forEachActivePr(config, token, async (project, pr, prNum, orgBase) => {
    const threadsUrl = `${orgBase}/${project.adoProject}/_apis/git/repositories/${project.repositoryId}/pullrequests/${prNum}/threads?api-version=7.1`;
    const threadsData = await adoFetch(threadsUrl, token);
    const threads = threadsData.value || [];

    const allHumanAuthors = new Set();
    for (const thread of threads) {
      for (const comment of (thread.comments || [])) {
        if (!comment.content || comment.commentType === 'system') continue;
        if (/\bSquad\s*\(/i.test(comment.content)) continue;
        allHumanAuthors.add(comment.author?.uniqueName || comment.author?.displayName || '');
      }
    }
    const soloReviewer = allHumanAuthors.size <= 1;

    const cutoff = pr.humanFeedback?.lastProcessedCommentDate || pr.created || '1970-01-01';
    const newHumanComments = [];

    for (const thread of threads) {
      for (const comment of (thread.comments || [])) {
        if (!comment.content || comment.commentType === 'system') continue;
        if (/\bSquad\s*\(/i.test(comment.content)) continue;
        if (!(comment.publishedDate && comment.publishedDate > cutoff)) continue;

        if (!soloReviewer && !/@squad\b/i.test(comment.content)) continue;

        newHumanComments.push({
          threadId: thread.id,
          commentId: comment.id,
          author: comment.author?.displayName || 'Human',
          content: comment.content,
          date: comment.publishedDate
        });
      }
    }

    if (newHumanComments.length === 0) return false;

    newHumanComments.sort((a, b) => a.date.localeCompare(b.date));
    const feedbackContent = newHumanComments
      .map(c => `**${c.author}** (${c.date}):\n${c.content.replace(/@squad\s*/gi, '').trim()}`)
      .join('\n\n---\n\n');
    const latestDate = newHumanComments[newHumanComments.length - 1].date;

    pr.humanFeedback = {
      lastProcessedCommentDate: latestDate,
      pendingFix: true,
      feedbackContent
    };

    e.log('info', `PR ${pr.id}: found ${newHumanComments.length} new human comment(s)${soloReviewer ? '' : ' (via @squad)'}`);
    return true;
  });

  if (totalUpdated > 0) {
    e.log('info', `PR comment poll: found human feedback on ${totalUpdated} PR(s)`);
  }
}

// ─── PR Reconciliation Sweep ─────────────────────────────────────────────────

/**
 * Reconcile PRs: find active ADO PRs created by the squad that aren't tracked
 * in pull-requests.json, and add them. Matches PRs to work items by branch name.
 */
async function reconcilePrs(config) {
  const e = engine();
  const token = getAdoToken();
  if (!token) {
    e.log('warn', 'Skipping PR reconciliation — no ADO token available');
    return;
  }

  const projects = shared.getProjects(config);
  const branchPatterns = [/^refs\/heads\/work\//i, /^refs\/heads\/feat\//i, /^refs\/heads\/user\/yemishin\//i];
  let totalAdded = 0;

  for (const project of projects) {
    if (!project.adoOrg || !project.adoProject || !project.repositoryId) continue;

    const orgBase = shared.getAdoOrgBase(project);
    const url = `${orgBase}/${project.adoProject}/_apis/git/repositories/${project.repositoryId}/pullrequests?searchCriteria.status=active&api-version=7.1`;

    let prData;
    try {
      prData = await adoFetch(url, token);
    } catch (err) {
      e.log('warn', `PR reconciliation failed for ${project.name}: ${err.message}`);
      continue;
    }

    const adoPrs = (prData.value || []).filter(pr => {
      const ref = pr.sourceRefName || '';
      return branchPatterns.some(pat => pat.test(ref));
    });

    if (adoPrs.length === 0) continue;

    const prPath = shared.projectPrPath(project);
    const existingPrs = shared.safeJson(prPath) || [];
    const existingIds = new Set(existingPrs.map(p => p.id));
    let projectAdded = 0;

    // Load work items to match branches to work item IDs
    const wiPath = shared.projectWorkItemsPath(project);
    const workItems = shared.safeJson(wiPath) || [];
    const centralWiPath = require('path').join(shared.SQUAD_DIR, 'work-items.json');
    const centralItems = shared.safeJson(centralWiPath) || [];
    const allItems = [...workItems, ...centralItems];

    for (const adoPr of adoPrs) {
      const prId = `PR-${adoPr.pullRequestId}`;
      if (existingIds.has(prId)) continue;

      const branch = (adoPr.sourceRefName || '').replace('refs/heads/', '');
      // Try to extract work item ID from branch name (e.g., feat/P-43e5ac28-lazy-loading or work/PL-W005)
      const wiMatch = branch.match(/(P-[a-f0-9]{6,})/i) || branch.match(/(PL-W\d+)/i);
      const linkedItemId = wiMatch ? wiMatch[1] : null;
      // Validate work item exists — only link if confirmed
      const linkedItem = linkedItemId ? allItems.find(i => i.id === linkedItemId) : null;
      const confirmedItemId = linkedItem ? linkedItemId : null;

      const prUrl = project.prUrlBase ? project.prUrlBase + adoPr.pullRequestId : '';

      existingPrs.push({
        id: prId,
        title: (adoPr.title || `PR #${adoPr.pullRequestId}`).slice(0, 120),
        agent: (adoPr.createdBy?.displayName || 'unknown').toLowerCase(),
        branch,
        reviewStatus: 'pending',
        status: 'active',
        created: (adoPr.creationDate || '').slice(0, 10) || e.dateStamp(),
        url: prUrl,
        prdItems: confirmedItemId ? [confirmedItemId] : [],
      });
      existingIds.add(prId);
      projectAdded++;

      e.log('info', `PR reconciliation: added ${prId} (branch: ${branch}${confirmedItemId ? ', linked to ' + confirmedItemId : ''}) to ${project.name}`);
    }

    if (projectAdded > 0) {
      shared.safeWrite(prPath, existingPrs);
      totalAdded += projectAdded;
    }
  }

  if (totalAdded > 0) {
    e.log('info', `PR reconciliation: added ${totalAdded} missing PR(s) across projects`);
  }
}

module.exports = {
  getAdoToken,
  adoFetch,
  pollPrStatus,
  pollPrHumanComments,
  reconcilePrs,
};
