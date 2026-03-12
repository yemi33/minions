# PR Review: #4954969 — feat(dw-hr-agent): DataWorks HR/People Operations agent

**Reviewer:** Ripley (Lead/Explorer)
**Date:** 2026-03-11
**Branch:** feature/m005-dw-hr-agent
**Author:** Yemi Shin
**Verdict:** Approve with nits

## Summary

New DataWorks HR/People Operations agent (M005 high priority). 722 files changed, 52,575 insertions. The vast majority of files are copied skills (docx, pptx, email, email-formatter, enterprise-file-search) and font assets -- the actual new agent code is approximately 6 files totaling ~850 lines.

## Findings

### Positives

1. **Follows established pattern exactly.** The `dw-hr-agent.ts` is a clean adaptation of `dw-marketer-agent.ts` with appropriate HR-specific naming, message types, and scenarios.

2. **Telemetry logging improved over marketer.** The HR agent's `ws-request-manager.ts` and `upload-file-to-share-point-tool.ts` strip user data (file paths, request IDs, JSON payloads) from `logInfo` calls that the marketer agent still logs to telemetry. This is actually the correct behavior per CLAUDE.md rules.

3. **HR-specific RAI guidelines are thorough.** Covers employment law compliance, PII handling, bias/fairness in job descriptions and reviews, and confidentiality of compensation data. Well-done for a v1.0.0.

4. **System prompt is well-structured.** Five clear HR scenarios with detailed workflows, proper workspace/output directory templating, communication subagent integration, and email domain restrictions.

5. **Shared module changes are clean.** `agents.ts` registration, `message-type.ts` enum additions, and `digital-workers.ts` type definitions all follow established patterns.

6. **Flight overrides for Opus 4.5/4.6 included.** More forward-looking than the marketer agent which lacks these.

### Issues (Nits)

1. **email-formatter SKILL.md still says "for legal work products."** This was copied from the paralegal agent without updating the description. Should say "for HR work products" or be made generic.

2. **console.* in scripts.** The `enterprise-fetch.js`, `enterprise-search.js`, and `fetch-user-context.js` scripts use `console.log`/`console.error`. These are Node.js scripts (not production TS code), so ESLint may not catch them. Consistent with other agents' scripts, but worth noting.

3. **Skills are full copies.** The docx, pptx, email, enterprise-file-search skills are verbatim copies from the marketer/paralegal agents (700+ files, 50K+ lines of copied code). This is the established pattern in this repo, but it creates massive maintenance burden. Consider extracting shared skills to a module in the future.

4. **Missing `PowerPointServer` MCP handler case in tool logging.** The marketer agent has a case for `PowerPointServer` MCP operations, but the HR agent omits it. Since pptx is a registered skill, this should be added for logging consistency.

5. **`scenario` field typed as `string` rather than string union.** The `HRAgentRequestPayload.scenario` uses a comment to document allowed values. The marketer does the same, so this is consistent, but a proper union type would be better.

### No Issues Found

- No `console.*` in production TypeScript code
- No user data in `logInfo`/`logWarn`/`logError` (agent TS code)
- Package.json dependencies are correct (workspace:^ linking)
- tsconfig.json follows standard pattern
- jest.config.js follows standard pattern
- index.ts exports are clean
- Message type registration does not conflict with existing types

## Decision

**Approve with nits.** The implementation is solid and follows the established DW agent pattern. The email-formatter description should be fixed before merge (nit #1), and the PowerPointServer logging case should be added (nit #4). The rest are low-priority suggestions.
