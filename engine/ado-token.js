/**
 * Shared Azure DevOps token acquisition.
 *
 * Prefer Azure CLI because it is the most common authenticated tool in agent
 * environments; keep azureauth as the non-interactive fallback for corp setups.
 */

const { exec, execSync } = require('child_process');

const ADO_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';
const AZ_CLI_ADO_TOKEN_COMMAND = `az account get-access-token --resource ${ADO_RESOURCE_ID} --query accessToken -o tsv`;
const AZUREAUTH_ADO_TOKEN_COMMAND = 'azureauth ado token --mode iwa --mode broker --output token --timeout 1';
const DEFAULT_ADO_TOKEN_TIMEOUT_MS = 30000;

const ADO_TOKEN_PROVIDERS = Object.freeze([
  Object.freeze({ source: 'az', command: AZ_CLI_ADO_TOKEN_COMMAND }),
  Object.freeze({ source: 'azureauth', command: AZUREAUTH_ADO_TOKEN_COMMAND }),
]);

function normalizeAdoToken(value) {
  return String(value || '').trim();
}

function isLikelyAdoToken(token) {
  return typeof token === 'string' && token.startsWith('eyJ');
}

function _commandOptions({ timeout = DEFAULT_ADO_TOKEN_TIMEOUT_MS, encoding = 'utf8', windowsHide = true } = {}) {
  return { encoding, timeout, windowsHide };
}

function _attemptMessage(attempt) {
  return `${attempt.source}: ${attempt.error}`;
}

function _buildAdoTokenError(attempts) {
  const err = new Error(`Failed to get ADO token via az CLI or azureauth: ${attempts.map(_attemptMessage).join('; ')}`);
  err.attempts = attempts;
  return err;
}

function _recordInvalidToken(attempts, provider) {
  attempts.push({ source: provider.source, command: provider.command, error: 'invalid token output' });
}

function acquireAdoTokenSync({ execSync: run = execSync, timeout, encoding, windowsHide } = {}) {
  const opts = _commandOptions({ timeout, encoding, windowsHide });
  const attempts = [];
  for (const provider of ADO_TOKEN_PROVIDERS) {
    try {
      const token = normalizeAdoToken(run(provider.command, opts));
      if (isLikelyAdoToken(token)) {
        return { token, source: provider.source, command: provider.command };
      }
      _recordInvalidToken(attempts, provider);
    } catch (e) {
      attempts.push({ source: provider.source, command: provider.command, error: e.message });
    }
  }
  throw _buildAdoTokenError(attempts);
}

function _defaultExecAsync(command, opts) {
  return new Promise((resolve, reject) => {
    exec(command, opts, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

async function acquireAdoToken({ execAsync: run = _defaultExecAsync, timeout, encoding, windowsHide } = {}) {
  const opts = _commandOptions({ timeout, encoding, windowsHide });
  const attempts = [];
  for (const provider of ADO_TOKEN_PROVIDERS) {
    try {
      const token = normalizeAdoToken(await run(provider.command, opts));
      if (isLikelyAdoToken(token)) {
        return { token, source: provider.source, command: provider.command };
      }
      _recordInvalidToken(attempts, provider);
    } catch (e) {
      attempts.push({ source: provider.source, command: provider.command, error: e.message });
    }
  }
  throw _buildAdoTokenError(attempts);
}

module.exports = {
  ADO_RESOURCE_ID,
  AZ_CLI_ADO_TOKEN_COMMAND,
  AZUREAUTH_ADO_TOKEN_COMMAND,
  DEFAULT_ADO_TOKEN_TIMEOUT_MS,
  ADO_TOKEN_PROVIDERS,
  acquireAdoToken,
  acquireAdoTokenSync,
  isLikelyAdoToken,
  normalizeAdoToken,
};
