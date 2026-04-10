/**
 * engine/github.js — GitHub integration for Minions engine.
 * Parallel to ado.js: PR status polling, comment polling, reconciliation for GitHub-hosted projects.
 * Uses `gh` CLI for all GitHub API calls.
 */

const shared = require('./shared');
const { exec, execAsync, getProjects, projectPrPath, projectWorkItemsPath, safeJson, safeWrite, mutateJsonFileLocked, MINIONS_DIR, addPrLink, getPrLinks, log, ts, dateStamp, PR_STATUS } = shared;
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

// ─── Per-Repo Poll Backoff ──────────────────────────────────────────────────
// Tracks consecutive poll failures per repo slug to avoid spamming logs when
// a repo is inaccessible. Backoff doubles each failure: 2min, 4min, 8min, 16min, max 30min.
const _ghPollBackoff = new Map(); // slug → { failures, backoffUntil }
const GH_POLL_BACKOFF_BASE_MS = 2 * 60 * 1000; // 2 minutes (one poll cycle)
const GH_POLL_BACKOFF_MAX_MS = 30 * 60 * 1000;  // 30 minutes cap

/** Check if a repo slug is currently in backoff. Returns true if should skip. */
function isSlugInBackoff(slug) {
  const entry = _ghPollBackoff.get(slug);
  if (!entry) return false;
  return Date.now() < entry.backoffUntil;
}

/** Record a poll failure for a repo slug, applying exponential backoff. */
function recordSlugFailure(slug) {
  const existing = _ghPollBackoff.get(slug);
  const failures = (existing?.failures || 0) + 1;
  const backoffMs = Math.min(GH_POLL_BACKOFF_BASE_MS * Math.pow(2, failures - 1), GH_POLL_BACKOFF_MAX_MS);
  _ghPollBackoff.set(slug, { failures, backoffUntil: Date.now() + backoffMs });
  if (failures === 1) {
    log('warn', `GitHub poll: repo ${slug} failed — will retry in ${Math.round(backoffMs / 1000)}s`);
  } else {
    log('warn', `GitHub poll: repo ${slug} failed ${failures} times — backoff ${Math.round(backoffMs / 1000)}s`);
  }
}

/** Reset backoff for a repo slug after a successful poll. */
function resetSlugBackoff(slug) {
  if (_ghPollBackoff.has(slug)) {
    const entry = _ghPollBackoff.get(slug);
    if (entry.failures > 0) {
      log('info', `GitHub poll: repo ${slug} recovered after ${entry.failures} failure(s)`);
    }
    _ghPollBackoff.delete(slug);
  }
}

/** Run a `gh api` call and parse JSON result. Returns null on failure. */
async function ghApi(endpoint, slug) {
  try {
    const cmd = `gh api "repos/${slug}${endpoint}"`;
    const result = await execAsync(cmd, { timeout: 30000, encoding: 'utf-8' });
    return JSON.parse(result);
  } catch (e) {
    log('warn', `GitHub API error (${endpoint}): ${e.message}`);
    return null;
  }
}

/**
 * Run a `gh api` call with per-slug backoff tracking. Returns null on failure.
 * On success, resets the slug's backoff. On failure, increments it.
 */
async function ghApiWithBackoff(endpoint, slug) {
  const result = await ghApi(endpoint, slug);
  if (result === null) {
    recordSlugFailure(slug);
  } else {
    resetSlugBackoff(slug);
  }
  return result;
}

const BUILD_ERROR_LOG_MAX_LINES = 150;

/**
 * Fetch actual build/compiler error logs from GitHub when a check run fails.
 * Tries annotations first (structured error messages), then falls back to the
 * Actions job log. Returns truncated log text or null if unavailable.
 */
async function fetchGhBuildErrorLog(slug, failedRuns) {
  try {
    const logParts = [];

    for (const run of (failedRuns || []).slice(0, 3)) {
      if (!run?.id) continue;

      // Try annotations for structured compiler/lint errors
      let hasUsefulAnnotations = false;
      try {
        const annotations = await ghApi(`/check-runs/${run.id}/annotations`, slug);
        if (Array.isArray(annotations) && annotations.length > 0) {
          const failures = annotations.filter(a => a.annotation_level === 'failure');
          if (failures.length > 0) {
            const formatted = failures
              .map(a => `${a.path || ''}:${a.start_line || ''} [${a.annotation_level}] ${a.message || ''}`)
              .join('\n');
            logParts.push(`--- ${run.name || 'Check'} (annotations) ---\n${formatted}`);
            hasUsefulAnnotations = true;
          }
        }
      } catch { /* fall through to job log */ }

      // Always fetch job log — annotations alone often lack test failure details
      try {
        const cmd = `gh api "repos/${slug}/actions/jobs/${run.id}/logs" 2>&1`;
        const result = await execAsync(cmd, { timeout: 15000, encoding: 'utf-8' });
        if (result && !result.includes('Not Found')) {
          logParts.push(`--- ${run.name || 'Check'} (log) ---\n${result}`);
        }
      } catch { /* skip individual log fetch failures */ }
    }

    if (logParts.length === 0) return null;

    // Join and truncate to last N lines
    const combined = logParts.join('\n\n');
    const lines = combined.split('\n');
    if (lines.length > BUILD_ERROR_LOG_MAX_LINES) {
      return `... (truncated, showing last ${BUILD_ERROR_LOG_MAX_LINES} lines)\n` +
        lines.slice(-BUILD_ERROR_LOG_MAX_LINES).join('\n');
    }
    return combined;
  } catch (e) {
    log('warn', `Failed to fetch GitHub build error log: ${e.message}`);
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

    // Skip projects in backoff (inaccessible repo)
    if (isSlugInBackoff(slug)) continue;

    const prs = getPrs(project);
    const activePrs = prs.filter(pr => pr.status === PR_STATUS.ACTIVE);
    if (activePrs.length === 0) continue;

    // Probe repo accessibility before iterating PRs — avoids N warnings per inaccessible repo
    const probe = await ghApi('', slug);
    if (probe === null) {
      recordSlugFailure(slug);
      continue;
    }
    resetSlugBackoff(slug);

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
        // Merge back updated PRs and deduplicate
        for (const updatedPr of activePrs) {
          const idx = currentPrs.findIndex(p => p.id === updatedPr.id);
          if (idx >= 0) currentPrs[idx] = updatedPr;
        }
        // Remove duplicates — prefer merged/abandoned over active
        const bestById = new Map();
        const statusRank = { merged: 3, abandoned: 2, closed: 2, active: 1 };
        for (const p of currentPrs) {
          const existing = bestById.get(p.id);
          if (!existing || (statusRank[p.status] || 0) > (statusRank[existing.status] || 0)) {
            bestById.set(p.id, p);
          }
        }
        return [...bestById.values()];
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
    if (isSlugInBackoff(slug)) continue;
    const prNum = ghMatch[2];
    try {
      const updated = await callback(null, pr, prNum, slug);
      if (updated) {
        // Also update title/author/branch if still placeholder
        if (pr.title.includes('polling...') || pr.agent === 'human' || pr.description === undefined) {
          const prData = await ghApi(`/pulls/${prNum}`, slug);
          if (prData) {
            if (pr.title.includes('polling...') || /[{}"\[\]]/.test(pr.title) || /^[0-9a-f-]{8,}$/i.test(pr.title)) {
              pr.title = (prData.title || pr.title).slice(0, 120);
            }
            if (pr.description === undefined) pr.description = (prData.body || '').slice(0, 500);
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
    const prData = await ghApi(`/pulls/${prNum}`, slug);
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
      pr.lastPushedAt = ts();
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
          delete pr.buildErrorLog;
          delete pr._buildFailNotified;
          delete pr.buildFixAttempts;
          delete pr.buildFixEscalated;
        }
        await engine().handlePostMerge(pr, project, config, newStatus);
      }
    }

    // Review status from GitHub reviews
    const reviews = await ghApi(`/pulls/${prNum}/reviews`, slug);
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
      // Once approved, it stays approved permanently
      if (pr.reviewStatus === 'approved') {
        newReviewStatus = 'approved';
      } else if (states.some(s => s === 'CHANGES_REQUESTED')) {
        if (pr.reviewStatus === 'waiting' && pr.minionsReview?.fixedAt && (!pr.lastPushedAt || pr.lastPushedAt <= pr.minionsReview.fixedAt)) {
          newReviewStatus = 'waiting';
        } else {
          newReviewStatus = 'changes-requested';
        }
      }
      else if (states.some(s => s === 'APPROVED')) newReviewStatus = 'approved';
      else if (states.length > 0) newReviewStatus = 'pending';
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
                return metrics;
              });
            } catch (err) { log('warn', `Metrics update: ${err.message}`); }
          }
        }
        // Reset review→fix cycle counter on approval (loop succeeded)
        if (newReviewStatus === 'approved') {
          delete pr._reviewFixCycles;
          delete pr._evalEscalated;
        }
      }
    }

    // Check status / checks
    if (prData.state === 'open' && prData.head?.sha) {
      const checksData = await ghApi(`/commits/${prData.head.sha}/check-runs`, slug);
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
          // Build transitioned — clear grace period and auto-complete flag
          delete pr._buildFixPushedAt;
          if (buildStatus === 'failing') delete pr._autoCompleted; // allow re-merge after fix
          if (buildStatus !== 'failing') {
            delete pr._buildFailNotified;
            delete pr.buildErrorLog;
            // Reset build fix retry counter on recovery — allows fresh auto-fix cycles if build breaks again
            if (pr.buildFixAttempts) { delete pr.buildFixAttempts; delete pr.buildFixEscalated; }
          }
          updated = true;

          // Fetch actual compiler/build error logs when transitioning to failing
          if (buildStatus === 'failing') {
            const failedRuns = runs.filter(r => r.conclusion === 'failure' || r.conclusion === 'timed_out');
            const errorLog = await fetchGhBuildErrorLog(slug, failedRuns);
            if (errorLog) {
              pr.buildErrorLog = errorLog;
              log('info', `PR ${pr.id}: fetched ${errorLog.split('\n').length} lines of build error log`);
            }

            // Teams notification for build failure — non-blocking
            try {
              const teams = require('./teams');
              const prFilePath = shared.projectPrPath(project);
              teams.teamsNotifyPrEvent(pr, 'build-failed', project, prFilePath).catch(() => {});
            } catch {}
          }
        }
      }
    }

    // Merge conflict detection
    if (prData.state === 'open' && prData.mergeable === false) {
      if (!pr._mergeConflict) {
        pr._mergeConflict = true;
        log('info', `PR ${pr.id} has merge conflicts — will dispatch fix if not already in progress`);
        updated = true;
      }
    } else if (pr._mergeConflict) {
      delete pr._mergeConflict;
      updated = true;
    }

    // Auto-complete: merge PR when builds green + review approved
    if (pr.status === PR_STATUS.ACTIVE && pr.reviewStatus === 'approved' && pr.buildStatus === 'passing' && !pr._autoCompleted) {
      const autoComplete = config.engine?.autoCompletePrs === true; // opt-in
      if (autoComplete) {
        try {
          const mergeMethod = ['squash', 'merge', 'rebase'].includes(config.engine?.prMergeMethod) ? config.engine.prMergeMethod : 'squash';
          await execAsync(`gh pr merge ${prNum} --${mergeMethod} --repo ${slug} --delete-branch`, { timeout: 30000, encoding: 'utf-8' });
          pr._autoCompleted = true;
          log('info', `Auto-completed PR ${pr.id}: builds green + review approved → merged (${mergeMethod})`);
          updated = true;
        } catch (e) {
          log('warn', `Auto-complete failed for PR ${pr.id}: ${e.message}`);
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
    const comments = await ghApi(`/issues/${prNum}/comments`, slug);
    if (!comments || !Array.isArray(comments)) return false;

    // Also get review comments (inline code comments)
    const reviewComments = await ghApi(`/pulls/${prNum}/comments`, slug);
    const allComments = [
      ...(comments || []).map(c => ({ ...c, _type: 'issue' })),
      ...(Array.isArray(reviewComments) ? reviewComments : []).map(c => ({ ...c, _type: 'review' }))
    ];

    // Separate: agent comments (included in context, don't trigger fix) vs human comments (trigger fix)
    // All non-bot, non-CI comments go into context. Only non-agent comments trigger pendingFix.
    const ignoredAuthors = new Set((config.engine?.ignoredCommentAuthors || []).map(a => a.toLowerCase()));
    function _isBot(c) {
      if (c.user?.type === 'Bot') return true;
      const login = (c.user?.login || '').toLowerCase();
      if (ignoredAuthors.has(login)) return true;
      if (/\b(bot|codecov|sonar|dependabot|renovate|github-actions|azure-pipelines)\b/i.test(login)) return true;
      const body = c.body || '';
      if (/^#{1,3}\s*(Coverage|Build|Test|Deploy|Pipeline)\s*(Report|Status|Result|Summary)/i.test(body)) return true;
      if (/!\[.*\]\(https?:\/\/.*badge/i.test(body)) return true;
      return false;
    }
    function _isAgentComment(c) {
      const body = c.body || '';
      if (/\bMinions\s*\(/i.test(body)) return true;
      if (/\bby\s+Minions\b/i.test(body)) return true;
      if (/\[minions\]/i.test(body)) return true;
      return false;
    }
    const humanComments = allComments.filter(c => !_isBot(c));

    const cutoffStr = pr.humanFeedback?.lastProcessedCommentDate || pr.created || '1970-01-01';
    const cutoffMs = new Date(cutoffStr).getTime() || 0;

    // Collect ALL human comments for full context, track new ones for triggering
    const allCommentEntries = [];
    const newComments = [];

    for (const c of humanComments) {
      const date = c.created_at || c.updated_at || '';
      const isAgent = _isAgentComment(c);
      const entry = {
        commentId: c.id,
        author: c.user?.login || 'Human',
        content: c.body || '',
        date,
        _isAgent: isAgent
      };
      allCommentEntries.push(entry);

      // Only non-agent new comments trigger a fix (agent reviews trigger via vote, not comment)
      const dateMs = date ? new Date(date).getTime() : 0;
      if (dateMs && dateMs > cutoffMs && !isAgent) {
        newComments.push(entry);
      }
    }

    // Update cutoff even if only agent comments are new (so we don't re-scan them)
    const allNewDates = allCommentEntries.filter(c => (new Date(c.date).getTime() || 0) > cutoffMs).map(c => c.date);
    if (allNewDates.length > 0 && newComments.length === 0) {
      pr.humanFeedback = { ...(pr.humanFeedback || {}), lastProcessedCommentDate: allNewDates.sort().pop() };
      return false; // agent comments only — don't trigger fix
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

    // Skip projects in backoff (inaccessible repo)
    if (isSlugInBackoff(slug)) continue;

    // Skip projects with no tracked PRs and no work items — nothing to reconcile
    const existingPrs = getPrs(project);
    if (existingPrs.length === 0) {
      try {
        const wiPath = projectWorkItemsPath(project);
        const wis = safeJson(wiPath) || [];
        if (wis.length === 0) continue;
      } catch { continue; }
    }

    // Fetch open PRs
    const prsData = await ghApi('/pulls?state=open&per_page=100', slug);
    if (!prsData || !Array.isArray(prsData)) {
      recordSlugFailure(slug);
      continue;
    }
    resetSlugBackoff(slug);

    const ghPrs = prsData.filter(pr => {
      const branch = pr.head?.ref || '';
      return branchPatterns.some(pat => pat.test(branch));
    });

    if (ghPrs.length === 0) continue;

    const prPath = projectPrPath(project);
    const currentPrs = safeJson(prPath) || [];
    const existingIds = new Set(currentPrs.map(p => p.id));
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
        const existing = currentPrs.find(p => p.id === prId);
        // Backfill prNumber for existing records missing it
        if (existing && existing.prNumber == null) {
          existing.prNumber = ghPr.number;
        }
        if (confirmedItemId) {
          addPrLink(prId, confirmedItemId);
          if (existing && !(existing.prdItems || []).includes(confirmedItemId)) {
            existing.prdItems = Array.isArray(existing.prdItems) ? existing.prdItems : [];
            existing.prdItems.push(confirmedItemId);
          }
        }
        continue;
      }

      // Only auto-track PRs linked to a minions work item — skip human-authored PRs
      if (!confirmedItemId) continue;

      const prUrl = project.prUrlBase ? project.prUrlBase + ghPr.number : ghPr.html_url || '';

      currentPrs.push({
        id: prId,
        prNumber: ghPr.number,
        title: (ghPr.title || `PR #${ghPr.number}`).slice(0, 120),
        agent: (linkedItem?.dispatched_to || ghPr.user?.login || 'unknown').toLowerCase(),
        branch,
        reviewStatus: 'pending',
        status: 'active',
        created: ghPr.created_at || ts(),
        url: prUrl,
        prdItems: [confirmedItemId],
      });
      addPrLink(prId, confirmedItemId);
      existingIds.add(prId);
      projectAdded++;

      log('info', `GitHub PR reconciliation: added ${prId} (branch: ${branch}, linked to ${confirmedItemId}) to ${project.name}`);
    }

    // Backfill prNumber from pr.id for any PR missing it (e.g. created before prNumber was stored)
    for (const pr of currentPrs) {
      if (pr.prNumber == null) {
        const derived = parseInt((pr.id || '').replace(/^PR-/, ''), 10);
        if (derived) pr.prNumber = derived;
      }
    }

    // Backfill prdItems from pr-links for any PR with empty array
    const prLinks = getPrLinks();
    let backfilled = 0;
    for (const pr of currentPrs) {
      const linked = prLinks[pr.id];
      if (linked && !(pr.prdItems || []).includes(linked)) {
        pr.prdItems = Array.isArray(pr.prdItems) ? pr.prdItems : [];
        pr.prdItems.push(linked);
        backfilled++;
      }
    }

    if (projectAdded > 0 || backfilled > 0) {
      mutateJsonFileLocked(prPath, (lockedPrs) => {
        for (const pr of currentPrs) {
          const idx = lockedPrs.findIndex(p => p.id === pr.id);
          if (idx >= 0) lockedPrs[idx] = pr;
          else lockedPrs.push(pr);
        }
        return lockedPrs;
      }, { defaultValue: [] });
      totalAdded += projectAdded;
    }
  }

  if (totalAdded > 0) {
    log('info', `GitHub PR reconciliation: added ${totalAdded} missing PR(s)`);
  }
}

/**
 * Fetch live review status for a single PR from GitHub. Returns 'approved', 'changes-requested',
 * 'waiting', or 'pending'. Returns null if the check fails.
 */
async function checkLiveReviewStatus(pr, project) {
  try {
    const slug = getRepoSlug(project);
    if (!slug) return null;
    const prNum = (pr.id || '').replace(/^PR-/, '');
    const reviews = await ghApi(`/pulls/${prNum}/reviews`, slug);
    if (!reviews || !Array.isArray(reviews)) return null;
    const latestByUser = new Map();
    for (const r of reviews) {
      if (r.state === 'COMMENTED') continue;
      latestByUser.set(r.user?.login || '', r.state);
    }
    const states = [...latestByUser.values()];
    if (states.some(s => s === 'CHANGES_REQUESTED')) return 'changes-requested';
    if (states.some(s => s === 'APPROVED')) return 'approved';
    if (states.length > 0) return 'pending';
    return 'pending';
  } catch (e) {
    log('warn', `Live review check for ${pr.id}: ${e.message}`);
    return null;
  }
}

module.exports = {
  pollPrStatus,
  pollPrHumanComments,
  reconcilePrs,
  checkLiveReviewStatus,
  // Exported for testing
  isSlugInBackoff,
  recordSlugFailure,
  resetSlugBackoff,
  _ghPollBackoff,
};

