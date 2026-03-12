#!/usr/bin/env node
/**
 * spawn-agent.js — Wrapper to spawn claude CLI safely
 * Reads prompt and system prompt from files, avoiding shell metacharacter issues.
 *
 * Usage: node spawn-agent.js <prompt-file> <sysprompt-file> [claude-args...]
 * Task prompt is piped via stdin. System prompt passed as --system-prompt arg.
 */

const { spawn } = require('child_process');
const fs = require('fs');

const [,, promptFile, sysPromptFile, ...extraArgs] = process.argv;

if (!promptFile || !sysPromptFile) {
  console.error('Usage: node spawn-agent.js <prompt-file> <sysprompt-file> [args...]');
  process.exit(1);
}

const prompt = fs.readFileSync(promptFile, 'utf8');
const sysPrompt = fs.readFileSync(sysPromptFile, 'utf8');

const args = ['-p', '--system-prompt', sysPrompt, ...extraArgs];

const proc = spawn('claude', args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
  shell: true
});

proc.stdin.write(prompt);
proc.stdin.end();

// Pass through stdout/stderr to parent
proc.stdout.pipe(process.stdout);
proc.stderr.pipe(process.stderr);

proc.on('close', (code) => process.exit(code || 0));
proc.on('error', (err) => { console.error(err.message); process.exit(1); });
