/**
 * engine/llm.js — Shared LLM utilities for Minions engine + dashboard
 * Provides callLLM() (with optional session resume) and trackEngineUsage().
 */

const path = require('path');
const shared = require('./shared');
const { safeRead, safeWrite, safeUnlink, uid, runFile, cleanChildEnv, parseStreamJsonOutput } = shared;

const MINIONS_DIR = path.resolve(__dirname, '..');
const ENGINE_DIR = __dirname;

function trackEngineUsage(category, usage) {
  if (!usage) return;
  try {
    const metricsPath = path.join(ENGINE_DIR, 'metrics.json');
    const raw = safeRead(metricsPath);
    const metrics = raw ? JSON.parse(raw) : {};

    if (!metrics._engine) metrics._engine = {};
    if (!metrics._engine[category]) {
      metrics._engine[category] = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 };
    }
    const cat = metrics._engine[category];
    cat.calls++;
    cat.costUsd += usage.costUsd || 0;
    cat.inputTokens += usage.inputTokens || 0;
    cat.outputTokens += usage.outputTokens || 0;
    cat.cacheRead += usage.cacheRead || 0;
    cat.cacheCreation = (cat.cacheCreation || 0) + (usage.cacheCreation || 0);

    const today = new Date().toISOString().slice(0, 10);
    if (!metrics._daily) metrics._daily = {};
    if (!metrics._daily[today]) metrics._daily[today] = { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, tasks: 0 };
    const daily = metrics._daily[today];
    daily.costUsd += usage.costUsd || 0;
    daily.inputTokens += usage.inputTokens || 0;
    daily.outputTokens += usage.outputTokens || 0;
    daily.cacheRead += usage.cacheRead || 0;

    safeWrite(metricsPath, metrics);
  } catch (e) { console.error('metrics update:', e.message); }
}

// ── Core LLM Call ───────────────────────────────────────────────────────────

function callLLM(promptText, sysPromptText, { timeout = 120000, label = 'llm', model = 'sonnet', maxTurns = 1, allowedTools = '', sessionId = null } = {}) {
  return new Promise((resolve) => {
    const id = uid();
    const tmpDir = path.join(ENGINE_DIR, 'tmp');
    if (!require('fs').existsSync(tmpDir)) require('fs').mkdirSync(tmpDir, { recursive: true });
    const promptPath = path.join(tmpDir, `${label}-prompt-${id}.md`);
    const sysPath = path.join(tmpDir, `${label}-sys-${id}.md`);
    safeWrite(promptPath, promptText);
    safeWrite(sysPath, sysPromptText || '');

    const spawnScript = path.join(ENGINE_DIR, 'spawn-agent.js');
    const args = [
      spawnScript, promptPath, sysPath,
      '--output-format', 'stream-json', '--max-turns', String(maxTurns), '--model', model,
      '--verbose',
    ];
    if (allowedTools) args.push('--allowedTools', allowedTools);
    args.push('--permission-mode', 'bypassPermissions');

    if (sessionId) args.push('--resume', sessionId);

    const proc = runFile(process.execPath, args, { cwd: MINIONS_DIR, stdio: ['pipe', 'pipe', 'pipe'], env: cleanChildEnv() });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* process may be dead */ } }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      safeUnlink(promptPath);
      safeUnlink(sysPath);
      const parsed = parseStreamJsonOutput(stdout);
      resolve({ text: parsed.text || '', usage: parsed.usage, sessionId: parsed.sessionId || null, code, stderr, raw: stdout });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      safeUnlink(promptPath);
      safeUnlink(sysPath);
      resolve({ text: '', usage: null, sessionId: null, code: 1, stderr: err.message, raw: '' });
    });
  });
}

/**
 * After a --resume call fails (non-zero exit or empty text), determine whether
 * the underlying session still exists (e.g. a tool timeout mid-turn) vs the
 * session is truly dead (expired, invalid ID, etc.).
 *
 * When the session still exists we should preserve it so the user can retry
 * with "try again" and resume into the same conversation.
 */
function isResumeSessionStillValid(result) {
  if (!result) return false;
  // If the CLI returned a session_id in the parsed output or raw stream,
  // the session is alive — the call just failed mid-execution.
  if (result.sessionId) return true;
  if (result.raw && result.raw.includes('"session_id"')) return true;
  return false;
}

/**
 * Streaming variant of callLLM — emits text chunks via onChunk callback.
 * Returns the same result object as callLLM when the process completes.
 * onChunk(text) is called for each assistant text block as it arrives.
 */
function callLLMStreaming(promptText, sysPromptText, { timeout = 120000, label = 'llm', model = 'sonnet', maxTurns = 1, allowedTools = '', sessionId = null, onChunk = () => {}, onToolUse = null } = {}) {
  return new Promise((resolve) => {
    const id = uid();
    const tmpDir = path.join(ENGINE_DIR, 'tmp');
    if (!require('fs').existsSync(tmpDir)) require('fs').mkdirSync(tmpDir, { recursive: true });
    const promptPath = path.join(tmpDir, `${label}-prompt-${id}.md`);
    const sysPath = path.join(tmpDir, `${label}-sys-${id}.md`);
    safeWrite(promptPath, promptText);
    safeWrite(sysPath, sysPromptText || '');

    const spawnScript = path.join(ENGINE_DIR, 'spawn-agent.js');
    const args = [
      spawnScript, promptPath, sysPath,
      '--output-format', 'stream-json', '--max-turns', String(maxTurns), '--model', model,
      '--verbose',
    ];
    if (allowedTools) args.push('--allowedTools', allowedTools);
    args.push('--permission-mode', 'bypassPermissions');
    if (sessionId) args.push('--resume', sessionId);

    const proc = runFile(process.execPath, args, { cwd: MINIONS_DIR, stdio: ['pipe', 'pipe', 'pipe'], env: cleanChildEnv() });

    let stdout = '';
    let stderr = '';
    let lineBuf = '';

    let lastTextSent = '';
    proc.stdout.on('data', d => {
      const chunk = d.toString();
      stdout += chunk;
      lineBuf += chunk;
      // Parse complete lines for streaming text
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop(); // keep incomplete line in buffer
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj.type === 'assistant' && obj.message?.content) {
            for (const block of obj.message.content) {
              if (block.type === 'text' && block.text && block.text !== lastTextSent) {
                lastTextSent = block.text;
                onChunk(block.text);
              }
            }
          }
        } catch { /* incomplete JSON or non-JSON line */ }
      }
      // Also emit tool_use events so the frontend can show "Using tool: Read..."
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj.type === 'assistant' && obj.message?.content) {
            for (const block of obj.message.content) {
              if (block.type === 'tool_use' && block.name && onToolUse) {
                onToolUse(block.name, block.input);
              }
            }
          }
        } catch {}
      }
    });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      safeUnlink(promptPath);
      safeUnlink(sysPath);
      const parsed = parseStreamJsonOutput(stdout);
      resolve({ text: parsed.text || '', usage: parsed.usage, sessionId: parsed.sessionId || null, code, stderr, raw: stdout });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      safeUnlink(promptPath);
      safeUnlink(sysPath);
      resolve({ text: '', usage: null, sessionId: null, code: 1, stderr: err.message, raw: '' });
    });
  });
}

module.exports = {
  callLLM,
  callLLMStreaming,
  trackEngineUsage,
  isResumeSessionStillValid,
};

