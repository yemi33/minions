#!/usr/bin/env node
/**
 * Wrapper for @azure-devops/mcp that fetches an ADO token via azureauth
 * broker (no browser popup) and sets AZURE_DEVOPS_EXT_PAT before launching
 * the MCP server.
 */
const { execSync, spawn } = require('child_process');
const path = require('path');

// Fetch token via azureauth broker (corp tool, no browser)
let token;
try {
  token = execSync('azureauth ado token --mode broker --output token --timeout 1', {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  }).trim();
} catch (e) {
  // Broker failed — do NOT fall back to web mode (opens browser in automated context)
  process.stderr.write('ado-mcp-wrapper: Broker auth failed: ' + e.message + '\n');
  process.stderr.write('ado-mcp-wrapper: Run "azureauth ado token --mode web" manually to refresh\n');
  process.exit(1);
}

// Launch the actual MCP server with the token in env
const args = process.argv.slice(2);
const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
  '-y',
  '--registry=https://registry.npmjs.org/',
  '@azure-devops/mcp@latest',
  ...args
], {
  stdio: 'inherit',
  env: { ...process.env, AZURE_DEVOPS_EXT_PAT: token },
  windowsHide: true,
  shell: false,
});

child.on('exit', (code) => process.exit(code || 0));
child.on('error', (err) => {
  process.stderr.write('ado-mcp-wrapper: ' + err.message + '\n');
  process.exit(1);
});
