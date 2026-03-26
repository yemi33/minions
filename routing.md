# Work Routing

How the engine decides who handles what. Parsed by engine.js — keep the table format exact.

## Routing Table

<!-- FORMAT: | work_type | preferred_agent | fallback | -->
| Work Type | Preferred | Fallback |
|-----------|-----------|----------|
| implement | dallas | ralph |
| implement:large | rebecca | dallas |
| review | ripley | lambert |
| fix | _author_ | dallas |
| plan | ripley | rebecca |
| plan-to-prd | lambert | rebecca |
| explore | ripley | rebecca |
| test | dallas | ralph |
| ask | ripley | rebecca |
| verify | dallas | ralph |
| decompose | ripley | rebecca |

Notes:
- `_author_` means route to the PR author
- `implement:large` is for items with `estimated_complexity: "large"`
- Engine falls back to any idle agent if both preferred and fallback are busy

## Rules

1. **Eager by default** — spawn all agents who can start work, not one at a time
2. **No self-review** — author cannot review their own PR
3. **Exploration gates implementation** — when exploring, finish before implementing
4. **Implementation informs PRD** — Lambert reads build summaries before writing PRD
5. **All rules in `notes.md` apply** — engine injects them into every playbook
