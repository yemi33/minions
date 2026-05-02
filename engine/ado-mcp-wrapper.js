#!/usr/bin/env node
/**
 * Wrapper for @azure-devops/mcp that fetches an ADO token via the shared
 * az-first provider chain and sets AZURE_DEVOPS_EXT_PAT before launching the
 * MCP server.
 */
const { spawn } = require('child_process');
const { acquireAdoTokenSync } = require('./ado-token');

let token;
try {
  token = acquireAdoTokenSync().token;
} catch (e) {
  process.stderr.write('ado-mcp-wrapper: ADO auth failed: ' + e.message + '\n');
  process.stderr.write('ado-mcp-wrapper: Run "az login" or refresh azureauth manually, then retry\n');
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
  env: { ...process.env, AZURE_DEVOPS_EXT_PAT: token, AZURE_DEVOPS_EXT_AZURE_RM_PAT: token },
  windowsHide: true,
  shell: false,
});

child.on('exit', (code) => process.exit(code || 0));
child.on('error', (err) => {
  process.stderr.write('ado-mcp-wrapper: ' + err.message + '\n');
  process.exit(1);
});
