/**
 * engine/github.js — GitHub integration for Minions engine.
 * Parallel to ado.js: PR status polling, comment polling, reconciliation for GitHub-hosted projects.
 * Uses `gh` CLI for all GitHub API calls.
 */

const shared = require('./shared');
const { exec, getProjects, projectPrPath, projectWorkItemsPath, safeJson, safeWrite, mutateJsonFileLocked, MINIONS_DIR, addPrLink, getPrLinks, log, ts, dateStamp, PR_STATUS } = shared;
const { getPrs } = require('./queries');
const path = require('path');

// Lazy require to avoid circular dependency — only needed for engine().handlePostMerge
let _engine = null;
function engine() {
  if (!_engine) _engine = require('../engine');
  return _engine;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isGitHub(project) {
  return project?.repoHost === 'github';
}

/** Get GitHub owner/repo slug from project config (e.g. "x3-design/Bebop_Workspaces") */
function getRepoSlug(project) {
  const org = project.adoOrg || '';
  const repo = project.repoName || '';
  if (!org || !repo) return null;
  return `${org}/${repo}`;
}

/** Run a `gh api` call and parse JSON result. Returns null on failure. */
function ghApi(endpoint, slug) {
  try {
    const cmd = `gh api "repos/${slug}${endpoint}"`;
    const result = exec(cmd, { timeout: 30000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return JSON.parse(result);
  } catch (e) {
    log('warn', `GitHub API error (${endpoint}): ${e.message}`);
    return null;
  }
}

// ─── Shared PR Polling Loop ─────────────────────────────────────────────────

async function forEachActiveGhPr(config, callback) {
  const projects = getProjects(config).filter(isGitHub);
  let totalUpdated = 0;

  for (const project of projects) {
    const slug = getRepoSlug(project);
    if (!slug) continue;

    const prs = getPrs(project);
    const activePrs = prs.filter(pr => pr.status === PR_STATUS.ACTIVE);
    if (activePrs.length === 0) continue;

    let projectUpdated = 0;

    for (const pr of activePrs) {
      const prNum = (pr.id || '').replace('PR-', '');
      if (!prNum) continue;

      try {
        const updated = await callback(project, pr, prNum, slug);
        if (updated) projectUpdated++;
      } catch (err) {
        log('warn', `GitHub: failed to poll PR ${pr.id}: ${err.message}`);
      }
    }

    if (projectUpdated > 0) {
      mutateJsonFileLocked(projectPrPath(project), (currentPrs) => {
        // Only merge back PRs that the callback actually modified
        for (const updatedPr of activePrs) {
          const idx = currentPrs.findIndex(p => p.id === updatedPr.id);
          if (idx >= 0) currentPrs[idx] = updatedPr;
        }
        return currentPrs;
      }, { defaultValue: [] });
      totalUpdated += projectUpdated;
    }
  }

  // Also poll manually-linked PRs from central pull-requests.json (extract slug from URL)
  const centralPath = path.join(MINIONS_DIR, 'pull-requests.json');
  const centralPrs = safeJson(centralPath) || [];
  const activeCentral = centralPrs.filter(pr => pr.status === PR_STATUS.ACTIVE && pr.url);
  let centralUpdated = 0;
  for (const pr of activeCentral) {
    const ghMatch = pr.url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!ghMatch) continue;
    const slug = ghMatch[1];
    const prNum = ghMatch[2];
    try {
      const updated = await callback(null, pr, prNum, slug);
      if (updated) {
        // Also update title/author/branch if still placeholder
        if (pr.title.includes('polling...') || pr.agent === 'human') {
          const prData = ghApi(`/pulls/${prNum}`, slug);
          if (prData) {
            if (pr.title.includes('polling...')) pr.title = (prData.title || pr.title).slice(0, 120);
            if (pr.agent === 'human' && prData.user?.login) pr.agent = prData.user.login;
            if (!pr.branch && prData.head?.ref) pr.branch = prData.head.ref;
          }
        }
        centralUpdated++;
      }
    } catch (err) {
      log('warn', `GitHub: failed to poll central PR ${pr.id}: ${err.message}`);
    }
  }
  if (centralUpdated > 0) {
    mutateJsonFileLocked(centralPath, (currentPrs) => {
      // Only merge back central PRs that the callback actually modified
      for (const updatedPr of activeCentral) {
        const idx = currentPrs.findIndex(p => p.id === updatedPr.id);
        if (idx >= 0) currentPrs[idx] = updatedPr;
      }
      return currentPrs;
    }, { defaultValue: [] });
    totalUpdated += centralUpdated;
  }

  return totalUpdated;
}

// ─── PR Status Polling ──────────────────────────────────────────────────────

async function pollPrStatus(config) {
  const totalUpdated = await forEachActiveGhPr(config, async (project, pr, prNum, slug) => {
    const prData = ghApi(`/pulls/${prNum}`, slug);
    if (!prData) return false;

    let updated = false;

    // Map GitHub PR state to minions status
    let newStatus = pr.status;
    if (prData.merged) newStatus = PR_STATUS.MERGED;
    else if (prData.state === 'closed') newStatus = PR_STATUS.ABANDONED;
    else if (prData.state === 'open') newStatus = PR_STATUS.ACTIVE;

    // Track head SHA changes to detect new pushes (used for review re-dispatch gating)
    if (prData.head?.sha && pr.headSha !== prData.head.sha) {
      pr.headSha = prData.head.sha;
      pr.lastPushedAt = new Date().toISOString();
      updated = true;
    }

    if (pr.status !== newStatus) {
      log('info', `PR ${pr.id} status: ${pr.status} → ${newStatus}`);
      pr.status = newStatus;
      updated = true;

      if (newStatus === PR_STATUS.MERGED || newStatus === PR_STATUS.ABANDONED) {
        // Resolve stale 'waiting' review status — won't be polled again after this
        if (pr.reviewStatus === 'waiting') {
          pr.reviewStatus = newStatus === PR_STATUS.MERGED ? 'approved' : 'pending';
          log('info', `PR ${pr.id} reviewStatus: waiting → ${pr.reviewStatus} (${newStatus})`);
        }
        // Clear stale build status — checks won't be polled after close
        if (pr.buildStatus && pr.buildStatus !== 'none') {
          delete pr.buildStatus;
          delete pr.buildFailReason;
          delete pr._buildFailNotified;
        }
        await engine().handlePostMerge(pr, project, config, newStatus);
      }
    }

    // Review status from GitHub reviews
    const reviews = ghApi(`/pulls/${prNum}/reviews`, slug);
    if (reviews && Array.isArray(reviews)) {
      // Get latest review per user
      const latestByUser = new Map();
      for (const r of reviews) {
        const user = r.user?.login || '';
        if (r.state === 'COMMENTED') continue; // Skip plain comments
        latestByUser.set(user, r.state);
      }
      const states = [...latestByUser.values()];

      // Store human reviewer names who approved or requested changes
      const reviewedBy = [...latestByUser.entries()]
        .filter(([, state]) => state === 'APPROVED' || state === 'CHANGES_REQUESTED')
        .map(([user]) => user)
        .filter(Boolean);
      // Fallback: if PR was merged and no decisive reviews, use merged_by
      if (!reviewedBy.length && prData.merged && prData.merged_by?.login) {
        reviewedBy.push(prData.merged_by.login);
      }
      if (JSON.stringify(pr.reviewedBy || []) !== JSON.stringify(reviewedBy)) {
        pr.reviewedBy = reviewedBy; updated = true;
      }

      let newReviewStatus = pr.reviewStatus || 'pending';
      if (states.some(s => s === 'CHANGES_REQUESTED')) newReviewStatus = 'changes-requested';
      else if (states.some(s => s === 'APPROVED')) newReviewStatus = 'approved';
      else if (states.length > 0) newReviewStatus = 'pending';
      // If all reviews were COMMENTED (filtered out), states is empty but reviews exist.
      // Set to 'waiting' instead of leaving as 'pending' to prevent infinite review re-dispatch.
      else if (states.length === 0 && reviews.length > 0 && newReviewStatus === 'pending') newReviewStatus = 'waiting';

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
              mutateJsonFileLocked(metricsPath, (metrics) => {
                if (!metrics[authorId]) metrics[authorId] = {};
                if (newReviewStatus === 'approved') metrics[authorId].prsApproved = (metrics[authorId].prsApproved || 0) + 1;
                else metrics[authorId].prsRejected = (metrics[authorId].prsRejected || 0) + 1;
              });
            } catch (err) { log('warn', `Metrics update: ${err.message}`); }
          }
        }
      }
    }

    // Check status / checks
    if (prData.state === 'open' && prData.head?.sha) {
      const checksData = ghApi(`/commits/${prData.head.sha}/check-runs`, slug);
      if (checksData && checksData.check_runs) {
        const runs = checksData.check_runs;
        let buildStatus = 'none';
        let buildFailReason = '';

        if (runs.length > 0) {
          const hasFailed = runs.some(r => r.conclusion === 'failure' || r.conclusion === 'timed_out');
          const allDone = runs.every(r => r.status === 'completed');
          const allPassed = runs.every(r => r.conclusion === 'success' || r.conclusion === 'skipped' || r.conclusion === 'neutral');

          if (hasFailed) {
            buildStatus = 'failing';
            const failed = runs.find(r => r.conclusion === 'failure' || r.conclusion === 'timed_out');
            buildFailReason = failed?.name || 'Check failed';
          } else if (allDone && allPassed) {
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
      }
    }

    return updated;
  });

  if (totalUpdated > 0) {
    log('info', `GitHub PR status poll: updated ${totalUpdated} PR(s)`);
  }
}

// ─── Poll Human Comments on PRs ─────────────────────────────────────────────

async function pollPrHumanComments(config) {
  const totalUpdated = await forEachActiveGhPr(config, async (project, pr, prNum, slug) => {
    // Get issue comments (general PR comments)
    const comments = ghApi(`/issues/${prNum}/comments`, slug);
    if (!comments || !Array.isArray(comments)) return false;

    // Also get review comments (inline code comments)
    const reviewComments = ghApi(`/pulls/${prNum}/comments`, slug);
    const allComments = [
      ...(comments || []).map(c => ({ ...c, _type: 'issue' })),
      ...(Array.isArray(reviewComments) ? reviewComments : []).map(c => ({ ...c, _type: 'review' }))
    ];

    // Filter out bot comments and minions's own comments
    const humanComments = allComments.filter(c => {
      if (c.user?.type === 'Bot') return false;
      if (/\bMinions\s*\(/i.test(c.body || '')) return false;
      return true;
    });

    const cutoffStr = pr.humanFeedback?.lastProcessedCommentDate || pr.created || '1970-01-01';
    const cutoffMs = new Date(cutoffStr).getTime() || 0;

    // Collect ALL human comments for full context, track new ones for triggering
    const allCommentEntries = [];
    const newComments = [];

    for (const c of humanComments) {
      const date = c.created_at || c.updated_at || '';
      const entry = {
        commentId: c.id,
        author: c.user?.login || 'Human',
        content: c.body || '',
        date
      };
      allCommentEntries.push(entry);

      // Any new comment triggers a fix — no @minions filter needed
      const dateMs = date ? new Date(date).getTime() : 0;
      if (dateMs && dateMs > cutoffMs) {
        newComments.push(entry);
      }
    }

    if (newComments.length === 0) return false;

    // Sort all comments chronologically and build full context for the fix agent
    allCommentEntries.sort((a, b) => a.date.localeCompare(b.date));
    newComments.sort((a, b) => a.date.localeCompare(b.date));
    const latestDate = newComments[newComments.length - 1].date;

    // Provide ALL comments as context — the agent needs full thread context to fix properly
    const feedbackContent = allCommentEntries
      .map(c => {
        const isNew = (new Date(c.date).getTime() || 0) > cutoffMs;
        return `${isNew ? '**[NEW]** ' : ''}**${c.author}** (${c.date}):\n${c.content.replace(/@minions\s*/gi, '').trim()}`;
      })
      .join('\n\n---\n\n');

    pr.humanFeedback = {
      lastProcessedCommentDate: latestDate,
      pendingFix: true,
      feedbackContent
    };

    log('info', `PR ${pr.id}: ${newComments.length} new comment(s), ${allCommentEntries.length} total — full thread context provided`);
    return true;
  });

  if (totalUpdated > 0) {
    log('info', `GitHub PR comment poll: found human feedback on ${totalUpdated} PR(s)`);
  }
}

// ─── PR Reconciliation ──────────────────────────────────────────────────────

async function reconcilePrs(config) {
  const projects = getProjects(config).filter(isGitHub);
  const branchPatterns = [/^work\//i, /^feat\//i, /^user\/yemishin\//i];
  let totalAdded = 0;

  for (const project of projects) {
    const slug = getRepoSlug(project);
    if (!slug) continue;

    // Fetch open PRs
    const prsData = ghApi('/pulls?state=open&per_page=100', slug);
    if (!prsData || !Array.isArray(prsData)) continue;

    const ghPrs = prsData.filter(pr => {
      const branch = pr.head?.ref || '';
      return branchPatterns.some(pat => pat.test(branch));
    });

    if (ghPrs.length === 0) continue;

    const prPath = projectPrPath(project);
    const existingPrs = safeJson(prPath) || [];
    const existingIds = new Set(existingPrs.map(p => p.id));
    let projectAdded = 0;

    // Load work items to match branches
    const wiPath = projectWorkItemsPath(project);
    const workItems = safeJson(wiPath) || [];
    const centralWiPath = path.join(MINIONS_DIR, 'work-items.json');
    const centralItems = safeJson(centralWiPath) || [];
    const allItems = [...workItems, ...centralItems];

    for (const ghPr of ghPrs) {
      const prId = `PR-${ghPr.number}`;
      const branch = ghPr.head?.ref || '';
      const wiMatch = branch.match(/(P-[a-z0-9]{6,})/i) || branch.match(/(W-[a-z0-9]{6,})/i) || branch.match(/(PL-[a-z0-9]{6,})/i);
      const linkedItemId = wiMatch ? wiMatch[1] : null;
      const linkedItem = linkedItemId ? allItems.find(i => i.id === linkedItemId) : null;
      const confirmedItemId = linkedItem ? linkedItemId : null;

      if (existingIds.has(prId)) {
        if (confirmedItemId) {
          addPrLink(prId, confirmedItemId);
          const existing = existingPrs.find(p => p.id === prId);
          if (existing && !(existing.prdItems || []).includes(confirmedItemId)) {
            existing.prdItems = Array.isArray(existing.prdItems) ? existing.prdItems : [];
            existing.prdItems.push(confirmedItemId);
          }
        }
        continue;
      }

      const prUrl = project.prUrlBase ? project.prUrlBase + ghPr.number : ghPr.html_url || '';

      existingPrs.push({
        id: prId,
        title: (ghPr.title || `PR #${ghPr.number}`).slice(0, 120),
        agent: (linkedItem?.dispatched_to || ghPr.user?.login || 'unknown').toLowerCase(),
        branch,
        reviewStatus: 'pending',
        status: 'active',
        created: ghPr.created_at || ts(),
        url: prUrl,
        prdItems: confirmedItemId ? [confirmedItemId] : [],
      });
      if (confirmedItemId) addPrLink(prId, confirmedItemId);
      existingIds.add(prId);
      projectAdded++;

      log('info', `GitHub PR reconciliation: added ${prId} (branch: ${branch}${confirmedItemId ? ', linked to ' + confirmedItemId : ''}) to ${project.name}`);
    }

    // Backfill prdItems from pr-links for any PR with empty array
    const prLinks = getPrLinks();
    let backfilled = 0;
    for (const pr of existingPrs) {
      const linked = prLinks[pr.id];
      if (linked && !(pr.prdItems || []).includes(linked)) {
        pr.prdItems = Array.isArray(pr.prdItems) ? pr.prdItems : [];
        pr.prdItems.push(linked);
        backfilled++;
      }
    }

    if (projectAdded > 0 || backfilled > 0) {
      mutateJsonFileLocked(prPath, (currentPrs) => {
        for (const pr of existingPrs) {
          const idx = currentPrs.findIndex(p => p.id === pr.id);
          if (idx >= 0) currentPrs[idx] = pr;
          else currentPrs.push(pr);
        }
        return currentPrs;
      }, { defaultValue: [] });
      totalAdded += projectAdded;
    }
  }

  if (totalAdded > 0) {
    log('info', `GitHub PR reconciliation: added ${totalAdded} missing PR(s)`);
  }
}

module.exports = {
  pollPrStatus,
  pollPrHumanComments,
  reconcilePrs,
};

