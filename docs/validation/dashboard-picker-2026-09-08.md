# Dashboard picker validation — 2026-09-08

Outcome: fix the existing red browser/HTTP/Temporal acceptance suite without removing assertions. Decisions: ADR-023, preserving ADR-022 repository binding and historical modes.

## Observed red

The pre-implementation run exited 1: configured workflow baseline passed; six picker subtests failed because catalog/prepare endpoints, browser controls, and workflow-provider mode were absent. Isolated evidence directory: `/private/var/folders/1c/wkzr1t1945v0tg_882wwqshh0000gn/T/steward-cli-e2e-02Oxnj`. Existing test calls were updated to supply the newly mandatory working directory.

## Observed green

- `npm run verify`: exit 0; installer checks, TypeScript build, and 124 tests passed, including supported-history replay. An initial sandboxed attempt failed on `ps EPERM`; the permitted rerun passed.
- Full `npm run test:e2e` with the bundled Playwright module: exit 0; 95 tests counted, 93 passed, 2 optional installed-sandbox/live-Codex probes skipped. All picker, CLI, scope, session, restart, and browser workspace scenarios passed.
- Final `node --import tsx --test tests/e2e/dashboard-workflow-picker.test.ts` using repository-installed Playwright: exit 0; 11 counted tests (10 scenarios plus parent) passed. This final run includes the additional missing-input/directory checks and repository-path replacement rejection added after the full suite run.
- Final `npm run build` and `git diff --check`: exit 0.
- `npm run verify:recovery`: exit 0, `ok: true`. Receipt/output/prompt restoration required zero provider reruns; network recovery retained the session; queued recovery exposed both requests; corrupt-receipt fresh recovery completed; invalid array input closed as FAILED.

Final picker evidence: `/private/var/folders/1c/wkzr1t1945v0tg_882wwqshh0000gn/T/steward-cli-e2e-EQz2rd`. Browser screenshots: `dashboard-before-picker.png`, `dashboard-prepared.png`. Browser layout was inspected from the preceding passing run and widened to preserve readable input and preview.

Acceptance reconciles completed Temporal status and result with saved definition/input, provider-specific completion receipts and their hashes, and committed node outputs. Simulation makes no provider calls. Workflow mode launches exactly the declared Codex leaf through a controlled executable. Concurrent starts and retries after completion retain one Temporal run ID. Changing YAML after preview does not alter execution. Reusing a start key for another intent fails. Invalid input, unknown intent, missing repository, and replaced canonical repository paths schedule no work. History browsing preserves the draft.

These are local controlled-provider durability checks, not paid-model reliability, actual testbed platform builds, cross-host recovery, or broader production qualification. Existing runtime data was preserved; each end-to-end harness used isolated temporary services and data.
