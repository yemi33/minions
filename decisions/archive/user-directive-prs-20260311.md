### 2026-03-11: User directive — mandatory PRs for all changes
**By:** yemishin (via Claude Code)
**What:** All features and bug fixes MUST go through a pull request for review. No direct commits to main. Use `mcp__azure-ado__repo_create_pull_request` to create PRs. After creating, add the PR to `.squad/pull-requests.json` so it appears on the dashboard.
**Why:** User directive — enforce code review for all changes
