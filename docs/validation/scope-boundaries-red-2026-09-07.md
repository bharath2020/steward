# Scope boundaries RED handoff — 2026-09-07

Added `tests/e2e/scope-boundaries.test.ts`, SHA-256 `13ce6f949ea156a5ae211aeadb2f09e49b07cef64365e6a22f9ec83416d05a3f`. No production files or shared harness changed.

Coverage: independent nested loop counters at workflow max_parallelism=1; shared leaf concurrency; unique full nested receipt identities and preserved output hashes; fail/accept_last exhaustion outcomes and dependent gating; eager validation of missing nested predicate operands despite false sibling; scoped reference rejection; dependency alias conflict; missing and mistyped expected predicate values; declared expansion limit before runtime submission.

Command: `rtk proxy sh -c 'node --import tsx --test --test-concurrency=1 tests/e2e/scope-boundaries.test.ts > /tmp/steward-scope-boundaries-red.log 2>&1; result=$?; cat /tmp/steward-scope-boundaries-red.log; exit "$result"'` with approved escalation for local Temporal listeners. Final exit 1; TAP retained beside this report.

Final evidence: `/var/folders/1c/wkzr1t1945v0tg_882wwqshh0000gn/T/steward-cli-e2e-EFJFyq`. Eight preflight subtests passed, four runtime subtests failed. Runtime source was actively being implemented during this pass: worker log identifies missing registration for `commitScopeIteration`, available activities being executeAgent, initializeRun, recordTransition. This final result is an implementation-in-progress RED, not evidence of a final implementation defect or infrastructure outage.

An earlier run at `/var/folders/1c/wkzr1t1945v0tg_882wwqshh0000gn/T/steward-cli-e2e-dcpKgY` observed missing scope runtime semantics (root scope returned empty output), undefined exhausted_failed outcome, accept_last failing, and numeric predicate string value incorrectly passing CLI preflight. These failures were sent to the implementation owner before resolution; the numeric predicate rejection was subsequently green. The first run also showed an allocation-assertion cascade after that invalid workflow erroneously submitted; moving that case last isolated the expansion check. Missing-operand assertion was tightened to the exact `details.missing` path to prevent an unrelated runtime failure from passing it.

Implementation owner has the test path and results. Boundary runtime assertions must be rerun against a completed, stable worker bundle. These tests do not claim human/recovery or current-history replay coverage. Repository runtime data was preserved.
