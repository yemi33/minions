---
source: ralph-2026-03-14.md
agent: ralph
category: conventions
date: 2026-03-14
---

# Ralph Learnings — 2026-03-14

## W018: Loop Page Access Attempt

### What I Learned
- **Loop pages in shared content storage containers** (CSP_*) are not accessible via the Loop API unless the user has explicit ODSP-level access to that container
- The Azure CLI app registration does **not** have SharePoint delegated permissions — `user_impersonation` scope is rejected by SPO REST API
- The Loop API token (resource `https://api.loop.cloud.microsoft`) works for the user's **Copilot workspace** but returns 403 for other content storage containers
- The Graph API `/shares/` endpoint with base64-encoded sharing URLs also requires underlying SP permissions
- The `sharepoint-df.com` domain is Microsoft's dogfood environment; it works the same as production but is separate infrastructure

### Patterns Discovered
- **Loop page ID format**: `base64(domain,driveId,itemId)` URL-encoded
- **Loop workspace podId format**: `base64(ODSP|domain|driveId|itemId)` — the workspace is identified by its storage root
- **Nav parameter in Loop URLs**: base64-encoded query string containing `s` (site path), `d` (driveId), `f` (itemId), `a` (app), `p` (container type)

### Gotchas for Future Agents
1. **DriveIds with `b!` prefix** cause shell escaping issues — always use heredocs or node/python to handle them, never echo or inline in shell commands
2. **python3** is not available on this Windows machine (only the Microsoft Store stub) — use `node` instead for encoding/decoding operations
3. **`/dev/stdin`** doesn't work with Node.js on Windows — use heredocs piped to the script instead
4. **`uuidgen`** is not available — use `node -e "const c=require('crypto');process.stdout.write(c.randomUUID())"` instead
5. **Background commands** may not be retrievable via TaskOutput if they complete too quickly — prefer synchronous execution for short commands

### Conventions
- Loop API environments: prod (`prod.api.loop.cloud.microsoft`), SDF (`sdf.api.loop.cloud.microsoft`), EU (`eu.prod.api.loop.cloud.microsoft`)
- Content storage containers use CSP GUIDs, not workspace podIds
