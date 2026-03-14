---
source: ripley-2026-03-14.md
agent: ripley
category: conventions
date: 2026-03-14
---

# Ripley Learnings — 2026-03-14

## Loop Page Access from SharePoint URLs

### Finding: SharePoint `:fl:` URLs require manual ID extraction
SharePoint Loop page URLs use `:fl:/g/contentstorage/CSP_xxx/IQxxx` format which is not parseable by the Loop MCP `decode_url` tool (which expects `/p/` or `/join/` format). The nav parameter is a base64-encoded query string containing `d` (driveId), `f` (itemId), `s` (site path), and `a` (app type).

**Extraction method:**
1. URL-decode the `nav` parameter
2. Base64-decode the result
3. Parse as query string: `d=<driveId>&f=<itemId>&s=<sitePath>&a=LoopApp`
4. Build pageId: `base64(domain + ',' + driveId + ',' + itemId)`
5. Build workspaceId: `ODSP|` + `base64(domain + ',' + driveId)`

(source: Manual testing against `https://microsoft.sharepoint-df.com/:fl:/g/contentstorage/CSP_96f34ace-...`)

### Finding: CSP containers remain inaccessible via all available tools
Confirmed that the known CSP access limitation (documented by Ralph) applies to all three access methods: Loop MCP API (403), WebFetch (401), and URL decoder (format mismatch). No workaround exists without browser-based auth or SharePoint delegated permissions.

(source: Loop API 403 response with `errorType: authorizationError, innerMostErrorCode: accessDenied`)

### Convention: SharePoint-df.com is the dogfood SharePoint domain
The URL uses `sharepoint-df.com` which is the Microsoft dogfood (internal pre-production) SharePoint environment. This may affect API endpoint selection — standard Loop API endpoints (prod/SDF/EU) may not route correctly for dogfood content.

(source: URL domain `microsoft.sharepoint-df.com`)
