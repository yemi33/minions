---
name: sync-to-personal
description: Syncs a sanitized copy of the squad repo to the personal GitHub remote, stripping all logs, history, and decisions. Use when the user says "sync to personal", "update personal repo", or "push clean to personal".
allowed-tools: Bash, Read, Edit, Write, Glob
---

# Sync to Personal Skill

Pushes a sanitized version of the squad repo to the `personal` remote, stripping all session-specific logs and history while preserving the core framework.

## When to Use

- User says "sync to personal", "update personal repo", "push clean to personal"
- User wants to distribute a clean copy of the squad framework

## Workflow

### 1. Ensure personal remote exists

```bash
git remote get-url personal 2>/dev/null || echo "ERROR: no 'personal' remote configured. Add one with: git remote add personal https://github.com/<user>/squad.git"
```

### 2. Create a temporary sanitized branch

```bash
git checkout -b dist-clean
```

### 3. Remove ephemeral/session files from the index

These files contain runtime logs, session history, and machine-specific state:

```bash
# Agent history files
git rm --cached agents/*/history.md 2>/dev/null

# Decision archives and inbox
git rm -r --cached decisions/archive/ decisions/inbox/ 2>/dev/null

# Runtime state files
git rm --cached decisions.md work-items.json 2>/dev/null

# Notes (session-specific exploration artifacts)
git rm -r --cached notes/ 2>/dev/null
```

### 4. Ensure .gitignore excludes these on the clean branch

The `.gitignore` on the dist-clean branch should include:

```
# Session logs and history (stripped for distribution)
agents/*/history.md
decisions/archive/
decisions/inbox/
decisions.md
work-items.json
notes/
```

If these lines are not already present, add them. If they are (from a previous sync), skip this step.

### 5. Check for hardcoded values

Before committing, scan for machine/user-specific values that shouldn't be distributed:

```bash
# Check for hardcoded usernames or absolute paths in distributable files
grep -rn "C:/Users/\|C:\\\\Users\\\\" --include="*.js" --include="*.html" --include="*.md" \
  --exclude-dir=decisions --exclude-dir=.claude | grep -v config.json | grep -v node_modules
```

If found, replace with dynamic alternatives:
- Hardcoded usernames → `os.userInfo().username` (JS) or `<your-user>` placeholder (docs)
- Absolute paths → relative paths or config-driven values
- Org-specific URLs → config-driven values

**Note:** `config.json` is expected to have machine-specific paths (users re-link via `squad.js add`). `config.template.json` exists as the distributable reference.

### 6. Preserve empty directories with .gitkeep

```bash
touch decisions/archive/.gitkeep decisions/inbox/.gitkeep
git add -f decisions/archive/.gitkeep decisions/inbox/.gitkeep
```

### 7. Commit and force push to personal

```bash
git add .gitignore
git commit -m "Strip logs, history, and decisions for clean distribution"
git push personal dist-clean:master --force
```

### 8. Switch back to master and clean up

```bash
git checkout master
git branch -D dist-clean
```

### 9. Handle auth if push fails

If push fails due to Enterprise Managed User restrictions:
```bash
gh auth login --hostname github.com --web
# Authenticate as personal account, push, then re-auth as org account
```

## Files Stripped

| Category | Pattern | Reason |
|----------|---------|--------|
| Agent history | `agents/*/history.md` | Session-specific conversation logs |
| Decision archive | `decisions/archive/*` | Historical decision records |
| Decision inbox | `decisions/inbox/*` | Pending session decisions |
| Decisions summary | `decisions.md` | Synthesized runtime decisions |
| Work items | `work-items.json` | Runtime dispatch tracking |
| Notes | `notes/*` | Session-specific exploration artifacts |

## Files Preserved

- `agents/*/charter.md` — Agent role definitions (core framework)
- `engine/` code — The engine scripts and CLI
- `identity/` templates — Identity and role definitions
- `CLAUDE.md`, `README.md` — Documentation
- All `.js` files — Engine implementation

## Hardcoded Values to Watch

| File | What | Fix |
|------|------|-----|
| `dashboard.js` | Default author in decisions | Use `os.userInfo().username` |
| `dashboard.html` | Author field in forms | Leave empty (server fills in) |
| `README.md` | Clone URLs | Use `<your-user>` placeholder |
| `config.json` | Absolute paths, repo IDs, org URLs | Expected — users reconfigure via `squad.js add` |

## Important Notes

- Always force push to personal since the history is rewritten each time
- Never modify the `origin` remote or `master` branch during this process
- The `.gitignore` changes only apply to the dist-clean branch, not master
- The personal remote URL is read from git config — never hardcode it in this skill
