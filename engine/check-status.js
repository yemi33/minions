const fs = require('fs');
const path = require('path');
const dir = path.resolve(__dirname, '..');

console.log('=== Work Items (non-done) ===');
const items = JSON.parse(fs.readFileSync(path.join(dir, 'work-items.json'), 'utf8'));
items.filter(i => i.status !== 'done').forEach(i => {
  console.log(i.id, i.status.padEnd(12), (i.type || '').padEnd(12), (i.title || '').slice(0, 60));
});

console.log('\n=== Agent Status (derived from dispatch) ===');
const { getAgentStatus } = require('./queries');
for (const a of ['ripley', 'dallas', 'lambert', 'rebecca', 'ralph']) {
  const s = getAgentStatus(a);
  console.log(a.padEnd(10), s.status.padEnd(10), (s.task || '-').slice(0, 60));
}

console.log('\n=== Inbox ===');
try {
  const inbox = fs.readdirSync(path.join(dir, 'notes', 'inbox')).filter(f => f.endsWith('.md'));
  console.log(inbox.length + ' files:', inbox.join(', '));
} catch { console.log('empty'); }
