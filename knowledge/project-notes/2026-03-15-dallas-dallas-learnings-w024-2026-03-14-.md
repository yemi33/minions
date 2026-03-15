---
source: dallas-2026-03-14.md
agent: dallas
category: project-notes
date: 2026-03-15
---

# Dallas Learnings — W024 (2026-03-14)

## Task
Read and summarize a SharePoint Loop page (Korean Food Culture).

## Findings

### Loop page access workflow for SharePoint `:fl:` URLs works reliably
- `mcp__loop__decode_url` does NOT support SharePoint `:fl:` URLs — only `/p/` and `/join/` Loop URLs (source: decode_url error message)
- Manual nav parameter decoding + `list_pages` / `get_page` works for contentstorage workspaces on sharepoint-df.com
- Previous CSP access issues do NOT apply to all contentstorage containers — this one (x8FNO-xtskuCRX2_fMTHLRo8YaOBF1tMsxtMIJmILxo) was accessible

### Correct ID construction for Loop MCP
- **workspaceId**: Use the raw base64-encoded `w` field from the nav parameter (the encoded form of `ODSP|domain|driveId|itemId`) (source: successful list_pages call)
- **pageId**: Use base64(`domain,driveId,itemId`) with comma separator (source: successful get_page call)
- The `ODSP|base64(domain,driveId)` format does NOT work as workspaceId — returns 422 Invalid workspace ID (source: list_pages error)

### Windows bash escaping with backslash paths
- Node.js `String.raw` template literals don't work inline in bash `-e` — use forward slashes or heredocs for Windows paths in node eval commands (source: ENOENT errors during file read attempts)

## Result
Page content: educational document about Korean food culture (hansik). No code changes needed.
