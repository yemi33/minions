/**
 * engine/consolidation.js — Inbox note consolidation for Minions engine.
 * Extracted from engine.js: LLM-powered and regex fallback consolidation,
 * knowledge base classification, inbox archival.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const shared = require('./shared');
const { safeRead, safeWrite, safeUnlink, runFile, cleanChildEnv,
  parseStreamJsonOutput, classifyInboxItem, KB_CATEGORIES, log, ts, dateStamp } = shared;
const { trackEngineUsage } = require('./llm');
const queries = require('./queries');
const { getInboxFiles, getNotes, INBOX_DIR, ENGINE_DIR, MINIONS_DIR,
  NOTES_PATH, KNOWLEDGE_DIR, ARCHIVE_DIR } = queries;

// Track in-flight LLM consolidation to prevent concurrent runs
let _consolidationInFlight = false;
let _consolidationStartedAt = 0;
const _processingFiles = new Set(); // files currently being consolidated (race guard)

function consolidateInbox(config) {

  const { ENGINE_DEFAULTS } = shared;
  const threshold = config.engine?.inboxConsolidateThreshold || ENGINE_DEFAULTS.inboxConsolidateThreshold;
  const files = getInboxFiles().filter(f => !_processingFiles.has(f));
  if (files.length < threshold) return;
  // Auto-reset stale flag if consolidation has been running for >5 minutes (process died without cleanup)
  if (_consolidationInFlight && (Date.now() - _consolidationStartedAt) > 300000) {
    log('warn', 'Consolidation flag was stale (>5m) — resetting');
    _consolidationInFlight = false;
    _processingFiles.clear();
  }
  if (_consolidationInFlight) return;

  log('info', `Consolidating ${files.length} inbox items into notes.md`);

  const items = files.map(f => ({
    name: f,
    content: safeRead(path.join(INBOX_DIR, f)) || ''
  }));

  const existingNotes = getNotes() || '';
  consolidateWithLLM(items, existingNotes, files, config);
}

// ─── LLM-Powered Consolidation ──────────────────────────────────────────────

function buildConsolidationPrompt(items, existingNotes, kbPaths) {

  const kbRefBlock = kbPaths.map(p => `- \`${p.file}\` \u2192 \`${p.kbPath}\``).join('\n');
  const notesBlock = items.map(item =>
    `<note file="${item.name}">\n${(item.content || '').slice(0, 8000)}\n</note>`
  ).join('\n\n');
  const existingTail = existingNotes.length > 2000
    ? '...\n' + existingNotes.slice(-2000)
    : existingNotes;

  return `You are a knowledge manager for a software engineering minions. Your job is to consolidate agent notes into team memory.

## Inbox Notes to Process

${notesBlock}

## Existing Team Notes (for deduplication — do NOT repeat what's already here)

<existing_notes>
${existingTail}
</existing_notes>

## Instructions

Read every inbox note carefully. Produce a consolidated digest following these rules:

1. **Extract actionable knowledge only**: patterns, conventions, gotchas, warnings, build results, architectural decisions, review findings. Skip boilerplate (dates, filenames, task IDs).

2. **Deduplicate aggressively**: If an insight already exists in the existing team notes, skip it entirely. If multiple agents report the same finding, merge into one entry and credit all agents.

3. **Write concisely**: Each insight should be 1-2 sentences max. Use **bold key** at the start of each bullet.

4. **Group by category**: Use these exact headers (only include categories that have content):
   - \`#### Patterns & Conventions\`
   - \`#### Build & Test Results\`
   - \`#### PR Review Findings\`
   - \`#### Bugs & Gotchas\`
   - \`#### Architecture Notes\`
   - \`#### Action Items\`

5. **Attribute sources**: End each bullet with _(agentName)_ or _(agent1, agent2)_ if multiple.

6. **Write a descriptive title**: First line must be a single-line title summarizing what was learned. Do NOT use generic text like "Consolidated from N items".

7. **Reference the knowledge base**: Each note is being filed into the knowledge base at these paths. After each insight bullet, add a reference link so readers know where to find the full detail:
${kbRefBlock}
   Format: \`\u2192 see knowledge/category/filename.md\` on a new line after the insight, indented.

## Output Format

Respond with ONLY the markdown below — no preamble, no explanation, no code fences:

### YYYY-MM-DD: <descriptive title>
**By:** Engine (LLM-consolidated)

#### Category Name
- **Bold key**: insight text _(agent)_
  \u2192 see \`knowledge/category/filename.md\`

_Processed N notes, M insights extracted, K duplicates removed._

Use today's date: ${dateStamp()}`;
}

function consolidateWithLLM(items, existingNotes, files, config) {

  _consolidationInFlight = true;
  _consolidationStartedAt = Date.now();
  for (const f of files) _processingFiles.add(f);

  // ─── Content-hash circuit breaker: skip LLM if >80% items are near-duplicates
  const dupCheck = checkDuplicateHash(items);
  if (dupCheck.isDuplicate) {
    log('info', `Skipped LLM consolidation: ${dupCheck.count}/${dupCheck.total} items are duplicates (hash: ${dupCheck.hash.slice(0, 8)})`);
    // Archive duplicate files directly
    if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    for (const f of files) {
      try {
        fs.renameSync(path.join(INBOX_DIR, f), shared.uniquePath(path.join(ARCHIVE_DIR, `${dateStamp()}-${f}`)));
      } catch (err) { log('warn', `Inbox archive (dup skip): ${err.message}`); }
    }
    for (const f of files) _processingFiles.delete(f);
    _consolidationInFlight = false;
    _consolidationStartedAt = 0;
    return;
  }


  const kbPaths = items.map(item => {
    const cat = classifyInboxItem(item.name, item.content);
    const agentMatch = item.name.match(/^(\w+)-/);
    const agent = agentMatch ? agentMatch[1] : 'unknown';
    const titleMatch = (item.content || '').match(/^#\s+(.+)/m);
    const titleSlug = titleMatch ? titleMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50) : item.name.replace(/\.md$/, '');
    return { file: item.name, category: cat, kbPath: path.join('knowledge', cat, `${dateStamp()}-${agent}-${titleSlug}.md`) };
  });

  const prompt = buildConsolidationPrompt(items, existingNotes, kbPaths);

  const tmpDir = path.join(ENGINE_DIR, 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const promptPath = path.join(tmpDir, 'consolidate-prompt.md');
  safeWrite(promptPath, prompt);

  const sysPrompt = 'You are a concise knowledge manager. Output only markdown. No preamble. No code fences around your output.';
  const sysPromptPath = path.join(tmpDir, 'consolidate-sysprompt.md');
  safeWrite(sysPromptPath, sysPrompt);

  const spawnScript = path.join(ENGINE_DIR, 'spawn-agent.js');
  const args = [
    '--output-format', 'stream-json',
    '--max-turns', '1',
    '--model', 'haiku',
    '--permission-mode', 'bypassPermissions',
    '--verbose',
  ];

  log('info', 'Spawning Haiku for LLM consolidation...');

  const proc = runFile(process.execPath, [spawnScript, promptPath, sysPromptPath, ...args], {
    cwd: MINIONS_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: cleanChildEnv()
  });

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', d => { stdout += d.toString(); if (stdout.length > 100000) stdout = stdout.slice(-50000); });
  proc.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 50000) stderr = stderr.slice(-25000); });

  const timeout = setTimeout(() => {
    log('warn', 'LLM consolidation timed out after 3m — killing and falling back to regex');
    shared.killGracefully(proc, 10000);
    setTimeout(() => {
      if (_consolidationInFlight) {
        _consolidationInFlight = false;
        _processingFiles.clear();
        log('warn', 'Consolidation flag force-reset after SIGKILL');
      }
    }, 10000);
  }, 180000);

  function _clearProcessingState() {
    for (const f of files) _processingFiles.delete(f);
    _consolidationInFlight = false;
  }

  proc.on('close', (code) => {
    clearTimeout(timeout);
    try { safeUnlink(promptPath); } catch (err) { log('warn', `Temp file cleanup failed: ${promptPath} — ${err.message}`); }
    try { safeUnlink(sysPromptPath); } catch (err) { log('warn', `Temp file cleanup failed: ${sysPromptPath} — ${err.message}`); }

    const parsed = parseStreamJsonOutput(stdout);
    const extractedText = parsed.text;
    trackEngineUsage('consolidation', parsed.usage);

    if (code === 0 && (extractedText || stdout).trim().length > 50) {
      let digest = (extractedText || stdout).trim();
      digest = digest.replace(/^\`\`\`\w*\n?/gm, '').replace(/\n?\`\`\`$/gm, '').trim();

      if (!digest.startsWith('### ')) {
        const sectionIdx = digest.indexOf('### ');
        if (sectionIdx >= 0) {
          digest = digest.slice(sectionIdx);
        } else {
          log('warn', 'LLM consolidation output missing expected format — falling back to regex');
          consolidateWithRegex(items, files);
          _clearProcessingState();
          return;
        }
      }

      const entry = '\n\n---\n\n' + digest;
      // Wrap read-modify-write in file lock to prevent race with concurrent consolidation or manual edits
      shared.withFileLock(NOTES_PATH + '.lock', () => {
        const current = getNotes() || '';
        let newContent = current + entry;

        if (newContent.length > 50000) {
          // Truncate on section boundary — scan backward for last \n# before byte limit
          // Never cut mid-section to preserve readability
          const limit = 50000;
          const lastSectionBoundary = newContent.lastIndexOf('\n---\n\n### ', limit);
          if (lastSectionBoundary > 0) {
            newContent = newContent.slice(0, lastSectionBoundary);
            log('info', `Pruned notes.md at section boundary (pos ${lastSectionBoundary}) to stay under ${limit} bytes`);
          } else {
            // Fallback: use the old section-count approach
            const sections = newContent.split('\n---\n\n### ');
            if (sections.length > 10) {
              const header = sections[0];
              const recent = sections.slice(-8);
              newContent = header + '\n---\n\n### ' + recent.join('\n---\n\n### ');
              log('info', `Pruned notes.md: removed ${sections.length - 9} old sections`);
            }
          }
        }

        safeWrite(NOTES_PATH, newContent);
      });
      classifyToKnowledgeBase(items);
      archiveInboxFiles(files);
      log('info', `LLM consolidation complete: ${files.length} notes processed by Haiku`);
    } else {
      log('warn', `LLM consolidation failed (code=${code}) — falling back to regex`);
      if (stderr) log('debug', `LLM stderr: ${stderr.slice(0, 500)}`);
      consolidateWithRegex(items, files);
    }
    _clearProcessingState();
  });

  proc.on('error', (err) => {
    clearTimeout(timeout);
    log('warn', `LLM consolidation spawn error: ${err.message} — falling back to regex`);
    try { safeUnlink(promptPath); } catch (unlinkErr) { log('warn', `Temp file cleanup failed: ${promptPath} — ${unlinkErr.message}`); }
    try { safeUnlink(sysPromptPath); } catch (unlinkErr) { log('warn', `Temp file cleanup failed: ${sysPromptPath} — ${unlinkErr.message}`); }
    consolidateWithRegex(items, files);
    _clearProcessingState();
  });
}

// ─── Regex Fallback Consolidation ────────────────────────────────────────────

function consolidateWithRegex(items, files) {

  const allInsights = [];
  for (const item of items) {
    const content = item.content || '';
    const agentMatch = item.name.match(/^(\w+)-/);
    const agent = agentMatch ? agentMatch[1] : 'unknown';
    const lines = content.split('\n');
    const titleLine = lines.find(l => /^#\s/.test(l));
    const noteTitle = titleLine ? titleLine.replace(/^#+\s*/, '').trim() : item.name;

    const nameLower = item.name.toLowerCase();
    const contentLower = content.toLowerCase();
    let category = 'learnings';
    if (nameLower.includes('review') || nameLower.includes('pr-') || nameLower.includes('pr4')) category = 'reviews';
    else if (nameLower.includes('feedback')) category = 'feedback';
    else if (nameLower.includes('build') || nameLower.includes('bt-')) category = 'build-results';
    else if (nameLower.includes('explore')) category = 'exploration';
    else if (contentLower.includes('bug') || contentLower.includes('fix')) category = 'bugs-fixes';

    const numberedPattern = /^\d+\.\s+\*\*(.+?)\*\*\s*[\u2014\u2013:-]\s*(.+)/;
    const bulletPattern = /^[-*]\s+\*\*(.+?)\*\*[:\s]+(.+)/;
    const sectionPattern = /^###+\s+(.+)/;
    const importantKeywords = /\b(must|never|always|convention|pattern|gotcha|warning|important|rule|tip|note that)\b/i;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || sectionPattern.test(trimmed)) continue;
      let insight = null;
      const numMatch = trimmed.match(numberedPattern);
      if (numMatch && numMatch[1] && numMatch[2]) insight = `**${numMatch[1].trim()}**: ${numMatch[2].trim()}`;
      if (!insight) {
        const bulMatch = trimmed.match(bulletPattern);
        if (bulMatch && bulMatch[1] && bulMatch[2]) insight = `**${bulMatch[1].trim()}**: ${bulMatch[2].trim()}`;
      }
      if (!insight && importantKeywords.test(trimmed) && !trimmed.startsWith('#') && trimmed.length > 30 && trimmed.length < 500) {
        insight = trimmed;
      }
      if (insight) {
        if (insight.length > 300) insight = insight.slice(0, 297) + '...';
        const fp = insight.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
        allInsights.push({ text: insight, source: item.name, noteTitle, category, agent, fingerprint: fp });
      }
    }
    if (!allInsights.some(i => i.source === item.name)) {
      allInsights.push({ text: `See full note: ${noteTitle}`, source: item.name, noteTitle, category, agent,
        fingerprint: noteTitle.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) });
    }
  }

  // Dedup
  const existingNotes = (getNotes() || '').toLowerCase();
  const seen = new Map();
  const deduped = [];
  for (const insight of allInsights) {
    const fpWords = insight.fingerprint.split(' ').filter(w => w.length > 4 && w.length <= 200).slice(0, 5);
    // Use word-boundary regex to avoid substring false positives (e.g. 'fix' matching 'prefix')
    // Cap word length at 200 chars to prevent ReDoS on pathological input
    if (fpWords.length >= 3 && fpWords.every(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(existingNotes))) continue;
    const existing = seen.get(insight.fingerprint);
    if (existing) { if (!existing.sources.includes(insight.agent)) existing.sources.push(insight.agent); continue; }
    let isDup = false;
    for (const [fp, entry] of seen) {
      // Filter to meaningful words (>4 chars) to avoid short-word false positives like 'fix' vs 'prefix'
      const a = new Set(fp.split(' ').filter(w => w.length > 2)), b = new Set(insight.fingerprint.split(' ').filter(w => w.length > 2));
      // Require at least 3 meaningful words in both fingerprints for similarity check
      if (a.size >= 3 && b.size >= 3 && [...a].filter(w => b.has(w)).length / Math.max(a.size, b.size) > 0.7) {
        if (!entry.sources.includes(insight.agent)) entry.sources.push(insight.agent); isDup = true; break;
      }
    }
    if (isDup) continue;
    seen.set(insight.fingerprint, { insight, sources: [insight.agent] });
    deduped.push({ ...insight, sources: seen.get(insight.fingerprint).sources });
  }

  const agents = [...new Set(items.map(i => { const m = i.name.match(/^(\w+)-/); return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : 'Unknown'; }))];
  const catLabels = { reviews: 'PR Review Findings', feedback: 'Review Feedback', 'build-results': 'Build & Test Results', exploration: 'Codebase Exploration', 'bugs-fixes': 'Bugs & Gotchas', learnings: 'Patterns & Conventions' };
  const topicHints = [...new Set(deduped.map(i => i.category))].map(c => ({ reviews: 'PR reviews', feedback: 'review feedback', 'build-results': 'build/test results', exploration: 'codebase exploration', 'bugs-fixes': 'bug findings' }[c] || 'learnings'));
  const title = `${agents.join(', ')}: ${topicHints.join(', ')} (${deduped.length} insights from ${items.length} notes)`;

  const grouped = {};
  for (const item of deduped) { if (!grouped[item.category]) grouped[item.category] = []; grouped[item.category].push(item); }

  let entry = `\n\n---\n\n### ${dateStamp()}: ${title}\n`;
  entry += '**By:** Engine (regex fallback)\n\n';
  for (const [cat, catItems] of Object.entries(grouped)) {
    entry += `#### ${catLabels[cat] || cat} (${catItems.length})\n`;
    for (const item of catItems) {
      const src = item.sources.length > 1 ? ` _(${item.sources.join(', ')})_` : ` _(${item.agent})_`;
      entry += `- ${item.text}${src}\n`;
    }
    entry += '\n';
  }
  const dupCount = allInsights.length - deduped.length;
  if (dupCount > 0) entry += `_Deduplication: ${dupCount} duplicate(s) removed._\n`;

  // Wrap read-modify-write in file lock to prevent race with concurrent consolidation or manual edits
  shared.withFileLock(NOTES_PATH + '.lock', () => {
    const current = getNotes() || '';
    let newContent = current + entry;
    if (newContent.length > 50000) {
      const limit = 50000;
      const lastBoundary = newContent.lastIndexOf('\n---\n\n### ', limit);
      if (lastBoundary > 0) {
        newContent = newContent.slice(0, lastBoundary);
      } else {
        const sections = newContent.split('\n---\n\n### ');
        if (sections.length > 10) { newContent = sections[0] + '\n---\n\n### ' + sections.slice(-8).join('\n---\n\n### '); }
      }
    }
    safeWrite(NOTES_PATH, newContent);
  });
  classifyToKnowledgeBase(items);
  archiveInboxFiles(files);
  log('info', `Regex fallback: consolidated ${files.length} notes \u2192 ${deduped.length} insights into notes.md`);
}

// ─── Knowledge Base Classification ───────────────────────────────────────────

function classifyToKnowledgeBase(items) {

  if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });

  const categoryDirs = {};
  // Include 'general' as fallback category even if not in KB_CATEGORIES
  const allCategories = KB_CATEGORIES.includes('general') ? KB_CATEGORIES : [...KB_CATEGORIES, 'general'];
  for (const cat of allCategories) {
    categoryDirs[cat] = path.join(KNOWLEDGE_DIR, cat);
    if (!fs.existsSync(categoryDirs[cat])) fs.mkdirSync(categoryDirs[cat], { recursive: true });
  }

  let classified = 0;
  for (const item of items) {
    const content = item.content || '';
    const rawCategory = classifyInboxItem(item.name, content);
    // Fallback to 'general' if the classified category isn't in our known category map
    const category = categoryDirs[rawCategory] ? rawCategory : 'general';
    if (rawCategory !== category) {
      log('warn', `Unknown KB category '${rawCategory}' for ${item.name} — falling back to 'general'`);
    }

    const agentMatch = item.name.match(/^(\w+)-/);
    const agent = agentMatch ? agentMatch[1] : 'unknown';
    const titleMatch = content.match(/^#\s+(.+)/m);
    const titleSlug = titleMatch
      ? titleMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)
      : item.name.replace(/\.md$/, '');
    const kbFilename = `${dateStamp()}-${agent}-${titleSlug}.md`;
    const kbPath = shared.uniquePath(path.join(categoryDirs[category], kbFilename));

    const frontmatter = `---\nsource: ${item.name}\nagent: ${agent}\ncategory: ${category}\ndate: ${dateStamp()}\n---\n\n`;
    try {
      safeWrite(kbPath, frontmatter + content);
      classified++;
    } catch (err) {
      log('warn', `Failed to classify ${item.name} to knowledge base: ${err.message}`);
    }
  }

  if (classified > 0) {
    log('info', `Knowledge base: classified ${classified} note(s) into knowledge/`);
  }

  // Save KB file count checkpoint so the watchdog can detect unexpected deletions
  try {
    let count = 0;
    for (const cat of KB_CATEGORIES) {
      const dir = path.join(KNOWLEDGE_DIR, cat);
      if (fs.existsSync(dir)) count += fs.readdirSync(dir).length;
    }
    safeWrite(path.join(ENGINE_DIR, 'kb-checkpoint.json'), JSON.stringify({ count, updatedAt: ts() }));
  } catch (err) { log('warn', `KB checkpoint: ${err.message}`); }
}

function archiveInboxFiles(files) {

  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  for (const f of files) {
    try { fs.renameSync(path.join(INBOX_DIR, f), shared.uniquePath(path.join(ARCHIVE_DIR, `${dateStamp()}-${f}`))); } catch (err) { log('warn', `Inbox archive: ${err.message}`); }
  }
}

/**
 * Check if >80% of items share the same content hash (first 200 chars + length).
 * Returns { isDuplicate, hash, count, total } or { isDuplicate: false }.
 * Exported for testing.
 */
function checkDuplicateHash(items) {
  if (!items || items.length === 0) return { isDuplicate: false };
  const hashCounts = new Map();
  for (const item of items) {
    const content = item.content || '';
    const hash = crypto.createHash('sha256').update(content.slice(0, 200) + ':' + content.length).digest('hex');
    hashCounts.set(hash, (hashCounts.get(hash) || 0) + 1);
  }
  for (const [hash, count] of hashCounts) {
    if (count / items.length > 0.8) {
      return { isDuplicate: true, hash, count, total: items.length };
    }
  }
  return { isDuplicate: false };
}

module.exports = {
  consolidateInbox,
  classifyToKnowledgeBase,
  checkDuplicateHash,
};

