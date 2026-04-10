/**
 * engine/teams-cards.js — Adaptive Card templates for Teams notifications.
 * All cards use schema version 1.4 and include fallback text.
 */

const SCHEMA = 'http://adaptivecards.io/schemas/adaptive-card.json';
const VERSION = '1.4';
const DASHBOARD_URL = 'http://localhost:7331';

function wrapCard(body, actions, fallbackText) {
  return {
    type: 'AdaptiveCard',
    $schema: SCHEMA,
    version: VERSION,
    fallbackText: fallbackText || 'Minions notification',
    body,
    actions: actions || [],
  };
}

/**
 * Agent completion card — shows agent name, task title, result, PR link.
 * @param {string} agent — agent name/id
 * @param {object} item — { title, id }
 * @param {string} result — 'success' or 'error'
 * @param {string} [prUrl] — PR URL if available
 */
function buildCompletionCard(agent, item, result, prUrl) {
  const isSuccess = result === 'success';
  const badge = isSuccess ? 'Done' : 'Failed';
  const color = isSuccess ? 'good' : 'attention';
  const title = item?.title || item?.id || 'Unknown task';

  const body = [
    { type: 'TextBlock', text: `${badge} — ${agent}`, weight: 'bolder', size: 'medium', color },
    { type: 'TextBlock', text: title, wrap: true },
  ];

  const actions = [
    { type: 'Action.OpenUrl', title: 'Open Dashboard', url: DASHBOARD_URL },
  ];
  if (prUrl) {
    actions.unshift({ type: 'Action.OpenUrl', title: 'View PR', url: prUrl });
  }

  return wrapCard(body, actions, `${badge}: ${agent} — ${title}`);
}

/**
 * PR lifecycle card — shows PR title, event, author, project.
 * @param {object} pr — { id, title, url, agent }
 * @param {string} event — 'pr-merged', 'pr-abandoned', 'build-failed', etc.
 * @param {object} [project] — { name }
 */
function buildPrCard(pr, event, project) {
  const title = pr?.title || pr?.id || 'Unknown PR';
  const agent = pr?.agent || 'unknown';
  const projectName = project?.name || '';

  const body = [
    { type: 'TextBlock', text: `${event}`, weight: 'bolder', size: 'medium' },
    { type: 'ColumnSet', columns: [
      { type: 'Column', width: 'stretch', items: [
        { type: 'TextBlock', text: title, wrap: true, weight: 'bolder' },
        { type: 'TextBlock', text: `${agent}${projectName ? ' | ' + projectName : ''}`, isSubtle: true, spacing: 'none' },
      ]},
    ]},
  ];

  const actions = [
    { type: 'Action.OpenUrl', title: 'Open Dashboard', url: DASHBOARD_URL },
  ];
  if (pr?.url) {
    actions.unshift({ type: 'Action.OpenUrl', title: 'View PR', url: pr.url });
  }

  return wrapCard(body, actions, `${event}: ${title} (${agent})`);
}

/**
 * Plan lifecycle card — shows plan name, event, item counts.
 * @param {object} plan — { name, file, doneCount, totalCount }
 * @param {string} event — 'plan-completed', 'plan-approved', 'plan-rejected', 'verify-created'
 */
function buildPlanCard(plan, event) {
  const name = plan?.name || plan?.file || 'Unknown plan';
  const hasCounts = plan?.doneCount != null && plan?.totalCount != null;

  const body = [
    { type: 'TextBlock', text: `${event}`, weight: 'bolder', size: 'medium' },
    { type: 'TextBlock', text: name, wrap: true },
  ];

  if (hasCounts) {
    body.push({ type: 'TextBlock', text: `${plan.doneCount}/${plan.totalCount} items completed`, isSubtle: true });
  }

  const actions = [
    { type: 'Action.OpenUrl', title: 'Open Dashboard', url: `${DASHBOARD_URL}/prd` },
  ];

  return wrapCard(body, actions, `${event}: ${name}${hasCounts ? ` (${plan.doneCount}/${plan.totalCount})` : ''}`);
}

/**
 * CC response mirror card — shows user question and CC answer.
 * @param {string} question — user's CC input
 * @param {string} answer — CC response (truncated if needed)
 */
function buildCCResponseCard(question, answer) {
  const maxLen = 3000;
  const truncated = answer.length > maxLen
    ? answer.slice(0, maxLen) + '...'
    : answer;

  const body = [
    { type: 'TextBlock', text: 'Command Center', weight: 'bolder', size: 'medium' },
    { type: 'TextBlock', text: `> ${question.slice(0, 200)}`, wrap: true, isSubtle: true },
    { type: 'TextBlock', text: truncated, wrap: true },
  ];

  const actions = [
    { type: 'Action.OpenUrl', title: 'Open Dashboard', url: DASHBOARD_URL },
  ];

  return wrapCard(body, actions, `CC: ${question.slice(0, 100)} — ${answer.slice(0, 200)}`);
}

module.exports = {
  buildCompletionCard,
  buildPrCard,
  buildPlanCard,
  buildCCResponseCard,
  SCHEMA,
  VERSION,
  DASHBOARD_URL,
};
