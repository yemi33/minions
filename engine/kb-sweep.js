/**
 * engine/kb-sweep.js — Knowledge base sweep: dedup, compress, normalize.
 *
 * Replaces the inline sweep that lived in dashboard.js. Three passes:
 *   1. Hash-based dedup    — cheap, catches cross-batch duplicates
 *   2. LLM batch sweep     — finds remaining dupes + reclassify + stale-remove
 *   3. Compress & normalize — per-entry LLM rewrite, flagged via _swept frontmatter
 *
 * Returns a rich summary so the dashboard can show before/after byte counts.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const shared = require('./shared');
const queries = require('./queries');
const { safeRead, safeWrite, safeUnlink, log, ts } = shared;
const { MINIONS_DIR, ENGINE_DIR } = queries;

const KB_DIR = path.join(MINIONS_DIR, 'knowledge');
const SWEPT_DIR = path.join(KB_DIR, '_swept');
const SWEPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const COMPRESS_THRESHOLD_BYTES = 5000;
const LLM_BATCH_SIZE = 30;
const NORMALIZE_CONCURRENCY = 5;
const SWEPT_FLAG_KEY = '_swept'; // frontmatter key — entries with this skip the rewrite pass

function _hashEntry(content) {
  const normalized = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  return crypto.createHash('sha256').update(normalized + ':' + (content?.length || 0)).digest('hex');
}

/**
 * Parse YAML-ish frontmatter at the top of a markdown file.
 * Returns { fm: {key:value}, body: string }.
 */
function _parseFrontmatter(content) {
  const m = String(content || '').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: content || '' };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const lm = line.match(/^([\w-]+):\s*(.*)$/);
    if (lm) fm[lm[1]] = lm[2].trim();
  }
  return { fm, body: m[2].replace(/^\n+/, '') };
}

function _serializeFrontmatter(fm, body) {
  const keys = Object.keys(fm);
  if (keys.length === 0) return body;
  const lines = keys.map(k => `${k}: ${fm[k]}`);
  return `---\n${lines.join('\n')}\n---\n\n${body.replace(/^\n+/, '')}`;
}

function _archiveKbFile(filePath, reason) {
  if (!fs.existsSync(filePath)) return false;
  if (!fs.existsSync(SWEPT_DIR)) fs.mkdirSync(SWEPT_DIR, { recursive: true });
  const destPath = shared.uniquePath(path.join(SWEPT_DIR, path.basename(filePath)));
  try {
    const content = safeRead(filePath);
    if (content === null) return false;
    safeWrite(destPath, `<!-- swept: ${new Date().toISOString()} | reason: ${reason} -->\n${content}`);
    safeUnlink(filePath);
    return true;
  } catch (e) { log('warn', `[kb-sweep] archive ${path.basename(filePath)}: ${e.message}`); return false; }
}

function _pruneOldSwept() {
  if (!fs.existsSync(SWEPT_DIR)) return 0;
  let pruned = 0;
  try {
    for (const f of fs.readdirSync(SWEPT_DIR)) {
      const fp = path.join(SWEPT_DIR, f);
      try {
        if (Date.now() - fs.statSync(fp).mtimeMs > SWEPT_RETENTION_MS) { safeUnlink(fp); pruned++; }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return pruned;
}

/** Group entries by content hash, keep most-recent per group. Cheap, no LLM. */
function _hashDedup(manifest, opts = {}) {
  const groups = new Map(); // hash → entries[]
  for (const e of manifest) {
    const h = _hashEntry(e.content);
    if (!groups.has(h)) groups.set(h, []);
    groups.get(h).push(e);
  }
  let archived = 0;
  const survivors = [];
  for (const [, group] of groups) {
    if (group.length === 1) { survivors.push(group[0]); continue; }
    // Keep most recent (by date frontmatter, then mtime)
    group.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.mtimeMs - a.mtimeMs);
    survivors.push(group[0]);
    for (const dup of group.slice(1)) {
      if (opts.dryRun) { archived++; continue; }
      const fp = path.join(KB_DIR, dup.category, dup.file);
      if (_archiveKbFile(fp, `hash-duplicate of ${group[0].category}/${group[0].file}`)) archived++;
    }
  }
  return { survivors, archived };
}

/** Batched LLM sweep — finds within-batch dupes, reclassifies, removes stale. */
async function _llmBatchSweep(manifest, callLLM, trackEngineUsage, opts = {}) {
  const plan = { duplicates: [], reclassify: [], remove: [] };
  const batches = [];
  for (let i = 0; i < manifest.length; i += LLM_BATCH_SIZE) {
    batches.push(manifest.slice(i, i + LLM_BATCH_SIZE));
  }
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const offset = b * LLM_BATCH_SIZE;
    const prompt = `You are a knowledge base curator. Analyze these ${batch.length} entries (batch ${b + 1}/${batches.length}, indices ${offset}-${offset + batch.length - 1}) and produce a cleanup plan.

## Entries

${batch.map((m, i) => `[${offset + i}] ${m.category}/${m.file} | ${m.title} | ${m.date} | ${m.agent || '?'} | ${(m.content || '').slice(0, 200).replace(/\n/g, ' ')}`).join('\n')}

## Instructions

1. **Find duplicates**: entries with substantially the same content (same findings, different agents/runs). List pairs by index. Prefer keeping the more recent entry.
2. **Find misclassified**: entries in the wrong category.
3. **Find stale/empty**: entries with no actionable content (boilerplate, bail-out notes, "no changes needed").

Respond with ONLY valid JSON: { "duplicates": [{ "keep": N, "remove": [N], "reason": "..." }], "reclassify": [{ "index": N, "from": "cat", "to": "cat", "reason": "..." }], "remove": [{ "index": N, "reason": "..." }] }
If nothing to do: { "duplicates": [], "reclassify": [], "remove": [] }`;

    let result;
    try {
      result = await callLLM(prompt, 'Output only JSON.', {
        timeout: 120000, label: 'kb-sweep', model: 'haiku', maxTurns: 1, direct: true,
        engineConfig: opts.engineConfig,
      });
      trackEngineUsage('kb-sweep', result.usage);
    } catch (e) { log('warn', `[kb-sweep] batch ${b + 1} LLM error: ${e.message}`); continue; }

    let batchPlan;
    try {
      let jsonStr = (result.text || '').trim();
      const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fence) jsonStr = fence[1].trim();
      batchPlan = JSON.parse(jsonStr);
    } catch { log('warn', `[kb-sweep] batch ${b + 1} returned invalid JSON, skipping`); continue; }
    if (batchPlan.duplicates) plan.duplicates.push(...batchPlan.duplicates);
    if (batchPlan.reclassify) plan.reclassify.push(...batchPlan.reclassify);
    if (batchPlan.remove) plan.remove.push(...batchPlan.remove);
  }
  return plan;
}

/**
 * Per-entry rewrite pass: compress large entries + normalize structure into
 * a fixed template. Only runs on entries lacking the `_swept` frontmatter flag.
 * Concurrency-limited via Promise pool.
 */
async function _rewritePass(survivors, callLLM, trackEngineUsage, opts = {}) {
  const REWRITE_PROMPT = (entry, body) => `You are restructuring a knowledge-base entry so future agents can scan it quickly.

Reshape the content into this exact template, preserving ALL actionable findings, file:line references, and code snippets. Compress to <=800 words by dropping boilerplate (dates, full file paths that aren't actionable, agent IDs in the body, narrative scaffolding).

Template:
## Summary
2-3 sentence overview.

## Key Findings
- Bullet 1 (specific, includes file:line where relevant)
- Bullet 2

## Action Items
- Bullet (omit section entirely if none)

## References
- file:line citations or doc links (omit section if none)

Output ONLY the template body — no frontmatter, no markdown code fence, no preamble.

Original entry (category: ${entry.category}, agent: ${entry.agent || '?'}, date: ${entry.date}):

${body}`;

  const candidates = [];
  for (const e of survivors) {
    const fp = path.join(KB_DIR, e.category, e.file);
    const content = safeRead(fp);
    if (content == null) continue;
    const { fm, body } = _parseFrontmatter(content);
    // Skip already-processed unless the file was modified after the sweep flag was set
    if (fm[SWEPT_FLAG_KEY]) {
      try {
        const mtime = fs.statSync(fp).mtimeMs;
        const sweptAt = Date.parse(fm[SWEPT_FLAG_KEY]);
        if (Number.isFinite(sweptAt) && mtime <= sweptAt + 1000) continue;
      } catch { /* ignore — re-process */ }
    }
    candidates.push({ entry: e, fp, fm, body, originalSize: content.length });
  }

  if (candidates.length === 0) return { processed: 0, bytesBefore: 0, bytesAfter: 0 };

  let processed = 0, bytesBefore = 0, bytesAfter = 0;
  // Simple promise pool — NORMALIZE_CONCURRENCY at a time
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const c = candidates[cursor++];
      try {
        const result = await callLLM(REWRITE_PROMPT(c.entry, c.body), 'Output ONLY the template body.', {
          timeout: 120000, label: 'kb-rewrite', model: 'haiku', maxTurns: 1, direct: true,
          engineConfig: opts.engineConfig,
        });
        trackEngineUsage('kb-sweep', result.usage);
        let newBody = (result.text || '').trim();
        // Strip accidental code fence
        const fence = newBody.match(/^```(?:markdown|md)?\s*([\s\S]*?)```$/);
        if (fence) newBody = fence[1].trim();
        if (!newBody || newBody.length < 50) continue; // suspicious — skip
        const newFm = { ...c.fm, [SWEPT_FLAG_KEY]: new Date().toISOString() };
        const newContent = _serializeFrontmatter(newFm, newBody);
        if (!opts.dryRun) safeWrite(c.fp, newContent);
        bytesBefore += c.originalSize;
        bytesAfter += newContent.length;
        processed++;
      } catch (e) { log('warn', `[kb-sweep] rewrite ${c.entry.category}/${c.entry.file}: ${e.message}`); }
    }
  }
  const workers = Array.from({ length: NORMALIZE_CONCURRENCY }, worker);
  await Promise.all(workers);
  return { processed, bytesBefore, bytesAfter };
}

function _applyLlmPlan(plan, manifest, opts = {}) {
  let removed = 0, merged = 0, reclassified = 0;
  for (const r of (plan.remove || [])) {
    const entry = manifest[r.index];
    if (!entry) continue;
    if (opts.dryRun) { removed++; continue; }
    if (_archiveKbFile(path.join(KB_DIR, entry.category, entry.file), `stale: ${r.reason || ''}`)) removed++;
  }
  for (const d of (plan.duplicates || [])) {
    for (const idx of (d.remove || [])) {
      const entry = manifest[idx];
      if (!entry) continue;
      if (opts.dryRun) { merged++; continue; }
      if (_archiveKbFile(path.join(KB_DIR, entry.category, entry.file), `duplicate of index ${d.keep}: ${d.reason || ''}`)) merged++;
    }
  }
  for (const r of (plan.reclassify || [])) {
    const entry = manifest[r.index];
    if (!entry || !shared.KB_CATEGORIES.includes(r.to)) continue;
    if (opts.dryRun) { reclassified++; continue; }
    const srcPath = path.join(KB_DIR, entry.category, entry.file);
    const destDir = path.join(KB_DIR, r.to);
    if (!fs.existsSync(srcPath)) continue;
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    try {
      const stats = fs.statSync(srcPath);
      const content = safeRead(srcPath);
      const updated = (content || '').replace(/^(category:\s*).+$/m, `$1${r.to}`);
      const destPath = path.join(destDir, entry.file);
      safeWrite(destPath, updated);
      fs.utimesSync(destPath, stats.atime, stats.mtime);
      safeUnlink(srcPath);
      reclassified++;
    } catch (e) { log('warn', `[kb-sweep] reclassify ${entry.file}: ${e.message}`); }
  }
  return { removed, merged, reclassified };
}

/**
 * Run the full sweep. Returns a rich summary.
 *
 * @param {object} opts
 * @param {string[]} [opts.pinnedKeys] - extra pinned keys (e.g. from request body)
 * @param {boolean}  [opts.dryRun]      - count actions but don't mutate files
 * @returns {Promise<object>} summary
 */
async function runKbSweep(opts = {}) {
  const { callLLM, trackEngineUsage } = require('./llm');
  const summary = {
    ok: true,
    entriesBefore: 0,
    entriesAfter: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    hashDuplicatesArchived: 0,
    llmDuplicatesArchived: 0,
    staleRemoved: 0,
    reclassified: 0,
    rewritten: 0,
    rewriteBytesBefore: 0,
    rewriteBytesAfter: 0,
    sweptArchivePruned: 0,
    durationMs: 0,
  };
  const t0 = Date.now();

  const entries = queries.getKnowledgeBaseEntries();
  if (entries.length < 2) { summary.summary = 'nothing to sweep (< 2 entries)'; summary.durationMs = Date.now() - t0; return summary; }

  const requestPinned = Array.isArray(opts.pinnedKeys)
    ? opts.pinnedKeys.filter(k => typeof k === 'string' && k.startsWith('knowledge/'))
    : [];
  const pinned = new Set([
    ...shared.getPinnedItems().filter(k => k.startsWith('knowledge/')),
    ...requestPinned,
  ]);

  // Build manifest with full content + mtime
  const manifest = [];
  for (const e of entries) {
    if (pinned.has(`knowledge/${e.cat}/${e.file}`)) continue;
    const fp = path.join(KB_DIR, e.cat, e.file);
    const content = safeRead(fp);
    if (!content) continue;
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(fp).mtimeMs; } catch { /* ignore */ }
    manifest.push({ category: e.cat, file: e.file, title: e.title, agent: e.agent, date: e.date, content: content.slice(0, 3000), mtimeMs });
    summary.entriesBefore++;
    summary.bytesBefore += content.length;
  }
  if (manifest.length < 2) { summary.summary = 'nothing to sweep (< 2 unpinned entries)'; summary.durationMs = Date.now() - t0; return summary; }

  // 1. Hash-based dedup (cheap, catches cross-batch duplicates)
  const { survivors: afterHash, archived: hashArchived } = _hashDedup(manifest, opts);
  summary.hashDuplicatesArchived = hashArchived;

  // 2. LLM batch sweep — within-batch dupes + reclassify + remove stale
  // Only runs against survivors, but we need indices that match the LIST sent to the LLM
  const llmManifest = afterHash;
  const plan = await _llmBatchSweep(llmManifest, callLLM, trackEngineUsage, opts);
  const llmActions = _applyLlmPlan(plan, llmManifest, opts);
  summary.llmDuplicatesArchived = llmActions.merged;
  summary.staleRemoved = llmActions.removed;
  summary.reclassified = llmActions.reclassified;

  // 3. Per-entry rewrite (compress + normalize)
  // Filter to entries that survived hash + LLM passes (still on disk)
  const stillOnDisk = afterHash.filter(e => fs.existsSync(path.join(KB_DIR, e.category, e.file)));
  const rewriteResult = await _rewritePass(stillOnDisk, callLLM, trackEngineUsage, opts);
  summary.rewritten = rewriteResult.processed;
  summary.rewriteBytesBefore = rewriteResult.bytesBefore;
  summary.rewriteBytesAfter = rewriteResult.bytesAfter;

  // 4. Prune old swept files (>30 days)
  summary.sweptArchivePruned = _pruneOldSwept();

  // Final tallies — re-walk surviving entries for accurate bytesAfter
  const finalEntries = queries.getKnowledgeBaseEntries();
  for (const e of finalEntries) {
    if (pinned.has(`knowledge/${e.cat}/${e.file}`)) continue;
    const fp = path.join(KB_DIR, e.cat, e.file);
    const content = safeRead(fp);
    if (!content) continue;
    summary.entriesAfter++;
    summary.bytesAfter += content.length;
  }

  summary.durationMs = Date.now() - t0;
  summary.summary = `${summary.hashDuplicatesArchived} hash-dup, ${summary.llmDuplicatesArchived} llm-dup, ${summary.staleRemoved} stale, ${summary.reclassified} reclassified, ${summary.rewritten} rewritten (${(summary.bytesBefore - summary.bytesAfter).toLocaleString()} bytes saved)`;

  if (!opts.dryRun) {
    try { safeWrite(path.join(ENGINE_DIR, 'kb-swept.json'), JSON.stringify({ timestamp: ts(), summary: summary.summary, detail: summary })); } catch { /* ignore */ }
    try { queries.invalidateKnowledgeBaseCache(); } catch { /* ignore */ }
  }
  return summary;
}

/** Compute a dynamic stale-guard timeout based on KB size. */
function staleGuardMs(entryCount) {
  // 30 minutes minimum, plus 1 second per entry (for the rewrite pass)
  return Math.max(30 * 60 * 1000, entryCount * 1000);
}

module.exports = {
  runKbSweep,
  staleGuardMs,
  // Exported for tests
  _hashEntry,
  _parseFrontmatter,
  _serializeFrontmatter,
  _hashDedup,
  COMPRESS_THRESHOLD_BYTES,
  SWEPT_FLAG_KEY,
};
