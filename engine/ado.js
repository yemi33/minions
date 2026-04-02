/**
 * engine/ado.js — Azure DevOps integration for Minions engine.
 * Extracted from engine.js: ADO token management, PR status polling, human comment polling.
 */

const path = require('path');
const shared = require('./shared');
const { exec, getAdoOrgBase, addPrLink, deduplicatePrs, log, dateStamp } = shared;
const { getPrs } = require('./queries');

// Lazy require to avoid circular dependency — only needed for engine().handlePostMerge
let _engine = null;
function engine() {
  if (!_engine) _engine = require('../engine');
  return _engine;
}

// ─── ADO Token Cache ─────────────────────────────────────────────────────────

let _adoTokenCache = { token: null, expiresAt: 0 };
let _adoTokenFailedUntil = 0; // backoff: skip azureauth calls until this timestamp

function getAdoToken() {
  if (_adoTokenCache.token && Date.now() < _adoTokenCache.expiresAt) {
    return _adoTokenCache.token;
  }
  // If recent fetch failed, don't retry until backoff expires (avoids repeated browser popups)
  if (Date.now() < _adoTokenFailedUntil) return null;
  try {
    // azureauth supports multiple --mode flags as an ordered fallback chain:
    // tries IWA (Integrated Windows Auth) first, falls back to broker if unavailable.
    const token = exec('azureauth ado token --mode broker --mode iwa --output token --timeout 5', {
      timeout: 15000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true    }).trim();
    if (token && token.startsWith('eyJ')) {
      _adoTokenCache = { token, expiresAt: Date.now() + 30 * 60 * 1000 };
      _adoTokenFailedUntil = 0;
      return token;
    }
  } catch (e) {
    log('warn', `Failed to get ADO token: ${e.message}`);
  }
  // Back off for 10 minutes to avoid spamming browser auth popups
  _adoTokenFailedUntil = Date.now() + 10 * 60 * 1000;
  return null;
}

async function adoFetch(url, token, _retryCount = 0) {
  const MAX_RETRIES = 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error(`ADO API timeout (30s) for ${url.split('?')[0]}`);
    throw err;
  }
  clearTimeout(timer);
  if (!res.ok) throw new Error(`ADO API ${res.status}: ${res.statusText}`);
  const text = await res.text();
  if (!text || text.trimStart().startsWith('<')) {
    // Invalidate cached token — it's likely expired
    _adoTokenCache = { token: null, expiresAt: 0 };
    if (_retryCount < MAX_RETRIES) {
      const freshToken = getAdoToken();
      if (freshToken) {
        log('info', 'ADO token expired mid-session — refreshed and retrying');
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
        log('warn', `Failed to poll status for ${pr.id}: ${err.message}`);
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
  const token = getAdoToken();
  if (!token) {
    log('warn', 'Skipping PR status poll — no ADO token available');
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
      log('info', `PR ${pr.id} status: ${pr.status} → ${newStatus}`);
      pr.status = newStatus;
      updated = true;

      if (newStatus === 'merged' || newStatus === 'abandoned') {
        if (pr.reviewStatus === 'waiting') {
          pr.reviewStatus = newStatus === 'merged' ? 'approved' : 'pending';
          log('info', `PR ${pr.id} reviewStatus: waiting → ${pr.reviewStatus} (${newStatus})`);
        }
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
      log('info', `PR ${pr.id} reviewStatus: ${pr.reviewStatus} → ${newReviewStatus}`);
      pr.reviewStatus = newReviewStatus;
      updated = true;
      // Update author metrics when verdict changes to approved/rejected
      if (newReviewStatus === 'approved' || newReviewStatus === 'changes-requested') {
        const authorId = (pr.agent || '').toLowerCase();
        if (authorId) {
          try {
            const metricsPath = path.join(__dirname, 'metrics.json');
            const metrics = shared.safeJson(metricsPath) || {};
            if (!metrics[authorId]) metrics[authorId] = {};
            if (newReviewStatus === 'approved') metrics[authorId].prsApproved = (metrics[authorId].prsApproved || 0) + 1;
            else metrics[authorId].prsRejected = (metrics[authorId].prsRejected || 0) + 1;
            shared.safeWrite(metricsPath, metrics);
          } catch (err) { log('warn', `Metrics update: ${err.message}`); }
        }
      }
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
      log('info', `PR ${pr.id} build: ${pr.buildStatus || 'none'} → ${buildStatus}${buildFailReason ? ' (' + buildFailReason + ')' : ''}`);
      pr.buildStatus = buildStatus;
      if (buildFailReason) pr.buildFailReason = buildFailReason;
      else delete pr.buildFailReason;
      if (buildStatus !== 'failing') delete pr._buildFailNotified;
      updated = true;
    }

    return updated;
  });

  if (totalUpdated > 0) {
    log('info', `PR status poll: updated ${totalUpdated} PR(s)`);
  }
}

// ─── Poll Human Comments on PRs ──────────────────────────────────────────────

async function pollPrHumanComments(config) {
  const token = getAdoToken();
  if (!token) return;

  const totalUpdated = await forEachActivePr(config, token, async (project, pr, prNum, orgBase) => {
    const threadsUrl = `${orgBase}/${project.adoProject}/_apis/git/repositories/${project.repositoryId}/pullrequests/${prNum}/threads?api-version=7.1`;
    const threadsData = await adoFetch(threadsUrl, token);
    const threads = threadsData.value || [];

    const cutoff = pr.humanFeedback?.lastProcessedCommentDate || pr.created || '1970-01-01';

    // Collect ALL human comments on the PR for full context
    const allHumanComments = [];
    const newHumanComments = [];

    for (const thread of threads) {
      for (const comment of (thread.comments || [])) {
        if (!comment.content || comment.commentType === 'system') continue;
        if (/\bMinions\s*\(/i.test(comment.content)) continue; // skip minions's own comments

        const entry = {
          threadId: thread.id,
          commentId: comment.id,
          author: comment.author?.displayName || 'Human',
          content: comment.content,
          date: comment.publishedDate
        };
        allHumanComments.push(entry);

        // Track which comments are new (for triggering — any new comment triggers a fix)
        if (comment.publishedDate && comment.publishedDate > cutoff) {
          newHumanComments.push(entry);
        }
      }
    }

    if (newHumanComments.length === 0) return false;

    // Sort all comments chronologically and build full context for the fix agent
    allHumanComments.sort((a, b) => a.date.localeCompare(b.date));
    newHumanComments.sort((a, b) => a.date.localeCompare(b.date));
    const latestDate = newHumanComments[newHumanComments.length - 1].date;

    // Provide ALL comments as context — the agent needs full thread context to fix properly
    const feedbackContent = allHumanComments
      .map(c => {
        const isNew = c.date > cutoff;
        return `${isNew ? '**[NEW]** ' : ''}**${c.author}** (${c.date}):\n${c.content.replace(/@minions\s*/gi, '').trim()}`;
      })
      .join('\n\n---\n\n');

    pr.humanFeedback = {
      lastProcessedCommentDate: latestDate,
      pendingFix: true,
      feedbackContent
    };

    log('info', `PR ${pr.id}: ${newHumanComments.length} new comment(s), ${allHumanComments.length} total — full thread context provided`);
    return true;
  });

  if (totalUpdated > 0) {
    log('info', `PR comment poll: found human feedback on ${totalUpdated} PR(s)`);
  }
}

// ─── PR Reconciliation Sweep ─────────────────────────────────────────────────

/**
 * Reconcile PRs: find active ADO PRs created by the minions that aren't tracked
 * in pull-requests.json, and add them. Matches PRs to work items by branch name.
 */
async function reconcilePrs(config) {
  const token = getAdoToken();
  if (!token) {
    log('warn', 'Skipping PR reconciliation — no ADO token available');
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
      log('warn', `PR reconciliation failed for ${project.name}: ${err.message}`);
      continue;
    }

    const adoPrs = (prData.value || []).filter(pr => {
      const ref = pr.sourceRefName || '';
      return branchPatterns.some(pat => pat.test(ref));
    });

    if (adoPrs.length === 0) continue;

    const prPath = shared.projectPrPath(project);
    const existingPrs = shared.safeJson(prPath) || [];
    deduplicatePrs(existingPrs); // clean up any pre-existing duplicates
    const existingIds = new Set(existingPrs.map(p => String(p.id).toUpperCase()));
    let projectAdded = 0;

    // Load work items to match branches to work item IDs
    const wiPath = shared.projectWorkItemsPath(project);
    const workItems = shared.safeJson(wiPath) || [];
    const centralWiPath = path.join(shared.MINIONS_DIR, 'work-items.json');
    const centralItems = shared.safeJson(centralWiPath) || [];
    const allItems = [...workItems, ...centralItems];

    let projectUpdated = 0;
    for (const adoPr of adoPrs) {
      const prId = `PR-${adoPr.pullRequestId}`;
      const branch = (adoPr.sourceRefName || '').replace('refs/heads/', '');
      const title = adoPr.title || '';
      // Extract item ID from branch name or PR title (e.g., feat(P-2cafdc2a): ...)
      const branchMatch = branch.match(/(P-[a-z0-9]{6,})/i) || branch.match(/(PL-W\d+)/i);
      const titleMatch = title.match(/\((P-[a-z0-9]{6,})\)/) || title.match(/\((PL-W\d+)\)/);
      const linkedItemId = branchMatch?.[1] || titleMatch?.[1] || null;
      const linkedItem = linkedItemId ? allItems.find(i => i.id === linkedItemId) : null;
      const confirmedItemId = linkedItem ? linkedItemId : null;

      const normPrId = prId.toUpperCase();
      if (existingIds.has(normPrId)) {
        // PR already tracked — write link to pr-links.json if we can extract an ID
        if (confirmedItemId) {
          addPrLink(prId, confirmedItemId);
          const existing = existingPrs.find(p => String(p.id).toUpperCase() === normPrId);
          if (existing && !(existing.prdItems || []).includes(confirmedItemId)) {
            existing.prdItems = Array.isArray(existing.prdItems) ? existing.prdItems : [];
            existing.prdItems.push(confirmedItemId);
          }
          projectUpdated++;
        }
        continue;
      }

      const prUrl = project.prUrlBase ? project.prUrlBase + adoPr.pullRequestId : '';
      existingPrs.push({
        id: prId,
        title: (adoPr.title || `PR #${adoPr.pullRequestId}`).slice(0, 120),
        agent: (linkedItem?.dispatched_to || adoPr.createdBy?.displayName || 'unknown').toLowerCase(),
        branch,
        reviewStatus: 'pending',
        status: 'active',
        created: (adoPr.creationDate || '').slice(0, 10) || dateStamp(),
        url: prUrl,
        prdItems: confirmedItemId ? [confirmedItemId] : [],
      });
      if (confirmedItemId) addPrLink(prId, confirmedItemId);
      existingIds.add(normPrId);
      projectAdded++;
      log('info', `PR reconciliation: added ${prId} (branch: ${branch}${confirmedItemId ? ', linked to ' + confirmedItemId : ''}) to ${project.name}`);
    }

    if (projectAdded > 0 || projectUpdated > 0) {
      shared.safeWrite(prPath, existingPrs);
      totalAdded += projectAdded;
      if (projectUpdated > 0) log('info', `PR reconciliation: linked ${projectUpdated} existing PR(s) to PRD items in ${project.name}`);
    }
  }

  if (totalAdded > 0) {
    log('info', `PR reconciliation: added ${totalAdded} missing PR(s) across projects`);
  }
}

module.exports = {
  getAdoToken,
  adoFetch,
  pollPrStatus,
  pollPrHumanComments,
  reconcilePrs,
};

