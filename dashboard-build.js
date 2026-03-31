/**
 * dashboard-build.js — Standalone dashboard HTML assembler for testing.
 * Exports buildDashboardHtml() so unit tests can verify assembly.
 */
const fs = require('fs');
const path = require('path');
const shared = require('./engine/shared');
const { safeRead } = shared;

const MINIONS_DIR = __dirname;

function buildDashboardHtml() {
  const dashDir = path.join(MINIONS_DIR, 'dashboard');
  const layoutPath = path.join(dashDir, 'layout.html');

  if (!fs.existsSync(layoutPath)) {
    return safeRead(path.join(MINIONS_DIR, 'dashboard.html')) || '';
  }

  const layout = safeRead(layoutPath);
  const css = safeRead(path.join(dashDir, 'styles.css'));

  const pages = ['home', 'work', 'prs', 'plans', 'inbox', 'tools', 'schedule', 'meetings', 'engine'];
  let pageHtml = '';
  for (const p of pages) {
    const content = safeRead(path.join(dashDir, 'pages', p + '.html'));
    const activeClass = p === 'home' ? ' active' : '';
    pageHtml += `    <div class="page${activeClass}" id="page-${p}">\n${content}\n    </div>\n\n`;
  }

  const jsFiles = [
    'utils', 'state', 'detail-panel', 'live-stream',
    'render-agents', 'render-dispatch', 'render-work-items', 'render-prd',
    'render-prs', 'render-plans', 'render-inbox', 'render-kb', 'render-skills',
    'render-other', 'render-schedules', 'render-meetings', 'render-pinned',
    'command-parser', 'command-input', 'command-center', 'command-history',
    'modal', 'modal-qa', 'settings', 'refresh'
  ];
  let jsHtml = '';
  for (const f of jsFiles) {
    const content = safeRead(path.join(dashDir, 'js', f + '.js'));
    jsHtml += `\n// ─── ${f}.js ────────────────────────────────────────\n${content}\n`;
  }

  // Use function replacer to avoid $ special patterns in String.replace
  return layout
    .replace('/* __CSS__ */', () => css)
    .replace('<!-- __PAGES__ -->', () => pageHtml)
    .replace('/* __JS__ */', () => jsHtml);
}

module.exports = { buildDashboardHtml };
