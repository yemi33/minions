/**
 * engine/llm.js — Shared LLM utilities for Squad engine + dashboard
 * Provides callHaiku() and domain-specific wrappers (triage, doc-chat, steer, ask-about).
 * Both engine.js and dashboard.js require() this module.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const { safeRead, safeWrite, safeUnlink, runFile, cleanChildEnv, parseStreamJsonOutput } = shared;

const SQUAD_DIR = path.resolve(__dirname, '..');
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
  } catch {}
}

// ── Core LLM Call ───────────────────────────────────────────────────────────

function callHaiku(promptText, sysPromptText, { timeout = 60000, label = 'llm' } = {}) {
  return new Promise((resolve) => {
    const id = Date.now();
    const promptPath = path.join(ENGINE_DIR, `${label}-prompt-${id}.md`);
    const sysPath = path.join(ENGINE_DIR, `${label}-sys-${id}.md`);
    safeWrite(promptPath, promptText);
    safeWrite(sysPath, sysPromptText);

    const spawnScript = path.join(ENGINE_DIR, 'spawn-agent.js');
    const proc = runFile(process.execPath, [
      spawnScript, promptPath, sysPath,
      '--output-format', 'stream-json', '--max-turns', '1', '--model', 'haiku',
      '--permission-mode', 'bypassPermissions', '--verbose',
    ], { cwd: SQUAD_DIR, stdio: ['pipe', 'pipe', 'pipe'], env: cleanChildEnv() });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      safeUnlink(promptPath);
      safeUnlink(sysPath);
      const parsed = parseStreamJsonOutput(stdout);
      resolve({ text: parsed.text || '', usage: parsed.usage, code, stderr, raw: stdout });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      safeUnlink(promptPath);
      safeUnlink(sysPath);
      resolve({ text: '', usage: null, code: 1, stderr: err.message, raw: '' });
    });
  });
}

// ── Domain Functions ────────────────────────────────────────────────────────

async function triageCommand(message, sysPrompt) {
  const userPrompt = `Classify this command and return ONLY a JSON object. No explanation, no markdown fences, no conversation.\n\nUser command: ${message}`;
  const result = await callHaiku(userPrompt, sysPrompt, { timeout: 45000, label: 'triage' });
  trackEngineUsage('triage', result.usage);
  if (result.code !== 0 || !result.text) throw new Error('Triage failed (code=' + result.code + ')');
  let output = result.text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  return JSON.parse(output);
}

async function docChat({ message, document, title, filePath, selection, history, isJson }) {
  const canEdit = !!filePath;
  const prompt = `You are a document assistant for a software engineering squad. You can answer questions AND edit documents.

## Document
${title ? '**Title:** ' + title + '\n' : ''}File: ${filePath || '(read-only)'}
${isJson ? 'Format: JSON' : 'Format: Markdown'}

\`\`\`
${document.slice(0, 20000)}
\`\`\`

${selection ? '## Highlighted Selection\n> ' + selection.slice(0, 1500) + '\n' : ''}
${(history && history.length > 0) ? '## Conversation So Far\n\n' + history.map(h => (h.role === 'user' ? 'User: ' : 'Assistant: ') + h.text).join('\n\n') + '\n' : ''}
## User Message

${message}

## Instructions

Determine what the user wants:

**If they're asking a question** (e.g., "what does this mean", "why is this", "explain"):
- Answer concisely with source citations
- Do NOT include the ---DOCUMENT--- delimiter

**If they want to edit the document** (e.g., "change", "remove", "add", "update", "rename", "fix", "reword"):
- Briefly explain what you changed (1-2 sentences)
- Then on a new line write exactly: ---DOCUMENT---
- Then the COMPLETE updated document (full file, not a diff)
${isJson ? '- The document MUST be valid JSON. No markdown code fences.' : ''}
${!canEdit ? '\nNote: This document is READ-ONLY. Answer questions only — do not output ---DOCUMENT---.' : ''}

Be concise. No preamble.`;

  const sysPrompt = 'You are a precise document assistant. Determine intent (question vs edit) from the user message. Follow the output format exactly.';
  const result = await callHaiku(prompt, sysPrompt, { timeout: 90000, label: 'chat' });
  trackEngineUsage('doc-chat', result.usage);
  if (result.code !== 0 || !result.text) throw new Error('Doc chat failed (code=' + result.code + ')');

  const output = result.text;
  const delimIdx = output.indexOf('---DOCUMENT---');
  if (delimIdx < 0) {
    return { answer: output, edited: false };
  }
  const explanation = output.slice(0, delimIdx).trim();
  let newContent = output.slice(delimIdx + '---DOCUMENT---'.length).trim();
  newContent = newContent.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
  return { answer: explanation, edited: true, content: newContent };
}

async function steerDocument({ instruction, filePath, content, selection, isJson }) {
  const prompt = `You are editing a document based on a user instruction.

## Current Document
File: ${filePath}
${isJson ? 'Format: JSON (you MUST output valid JSON)' : 'Format: Markdown'}

\`\`\`
${content.slice(0, 20000)}
\`\`\`

${selection ? '## Context: User highlighted this section\n> ' + selection.slice(0, 1000) + '\n' : ''}

## Instruction

${instruction}

## Output Format

Respond with EXACTLY two sections separated by the delimiter \`---DOCUMENT---\`:

1. First: A brief explanation of what you changed (1-3 sentences)
2. Then the delimiter on its own line: \`---DOCUMENT---\`
3. Then the COMPLETE updated document content (not a diff — the full file)

${isJson ? 'CRITICAL: The document section must be valid JSON. Do not add markdown code fences around it.' : ''}`;

  const sysPrompt = 'You are a precise document editor. Follow the output format exactly. No code fences around the document output.';
  const result = await callHaiku(prompt, sysPrompt, { timeout: 90000, label: 'steer' });
  trackEngineUsage('steer-document', result.usage);
  if (result.code !== 0 || !result.text) throw new Error('Steer failed (code=' + result.code + ')');

  const output = result.text;
  const delimIdx = output.indexOf('---DOCUMENT---');
  if (delimIdx < 0) {
    return { answer: output, updated: false };
  }
  const explanation = output.slice(0, delimIdx).trim();
  let newContent = output.slice(delimIdx + '---DOCUMENT---'.length).trim();
  newContent = newContent.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
  return { answer: explanation, updated: true, content: newContent };
}

async function askAbout({ question, document, title, selection }) {
  const prompt = `You are answering a question about a document from a software engineering squad's knowledge base.

## Document
${title ? '**Title:** ' + title + '\n' : ''}
${document.slice(0, 15000)}

${selection ? '## Highlighted Selection\n\nThe user highlighted this specific part:\n> ' + selection.slice(0, 2000) + '\n' : ''}

## Question

${question}

## Instructions

Answer concisely and directly. Follow these rules:
1. **Cite sources**: When the document includes file paths, line numbers, PR URLs, or code references — include them in your answer.
2. **Quote the document**: Reference the exact text that supports your answer.
3. **Flag missing sources**: If the document makes a claim without a source reference, say: "Note: this claim has no source reference in the document — verify independently."
4. **Be honest**: If the document doesn't contain the answer, say so clearly.
5. Use markdown formatting.`;

  const sysPrompt = 'You are a concise technical assistant. Answer based on the document provided. No preamble.';
  const result = await callHaiku(prompt, sysPrompt, { timeout: 60000, label: 'ask' });
  trackEngineUsage('ask-about', result.usage);
  if (result.code !== 0 || !result.text) throw new Error('Ask failed (code=' + result.code + ')');
  return { answer: result.text };
}

module.exports = {
  callHaiku,
  parseStreamJsonOutput,
  trackEngineUsage,
  triageCommand,
  docChat,
  steerDocument,
  askAbout,
};
