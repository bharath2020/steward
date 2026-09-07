# Bounded queued fan-out validation — 2026-09-07

Scope: the `version: 1` `for_each` node contract, the unified rolling scheduler,
ordered aggregation, item evidence, and recovery through the sole current
`stewardWorkflow` interpreter. This is developer-preview evidence, not a
production release-gate claim.

## Automated verification

- `npm run verify` exited 0 with 70/70 tests passing after independent review.
- Parser tests cover `object[]`, normalized queue declarations, dependency and
  array-source checks, and loop/human exclusions.
- Queue tests independently cover global, group, node-local, empty, rolling-slot,
  and prototype-named node/group selection behavior.
- Projection and receipt tests cover partial item progress, aggregate-only node
  completion, source-ordered output, and distinct item artifact/receipt paths.
- `npm run verify:recovery` exited 0 with retained evidence under
  `runtime/recovery-validation/independent-review-2026-09-07-7`. Receipt
  recovery performed zero provider reruns; same-session network recovery
  exhausted two automatic attempts, resumed the recorded session, and reran
  zero completed siblings. Two failed queue items exposed independent recovery
  requests while a global/node cap of one proved that an operator wait releases
  its execution permit. A deliberately corrupted cycle-0 receipt remained
  preserved while fresh recovery committed a distinct cycle-1 dispatch. A
  resolved scalar `for_each` source closed its Temporal execution as `FAILED`.

## Independent review and replay

- GPT-6 Astra independently verified the retained scenarios and reviewed
  Temporal determinism/recovery behavior. `Worker.runReplayHistory` passed all
  89 events from original run `01a07cf6-7172-7df6-940c-46124b38d086` against
  the remediated Workflow bundle.
- GPT-5.6 Sol independently reviewed the implementation. Its findings led to
  independent recovery-request projection, dispatch-scoped evidence, parser
  restrictions for mapped outputs, retry-idempotent item progress, and
  releasing execution permits during operator waits. A proposed external
  cross-process lock was removed to keep Temporal as the execution authority;
  the supported local topology remains one Steward worker process.
- Follow-up review found an abort race and a projection race. The scheduler now
  checks abort again after permit acquisition, and an automatic sibling failure
  cannot hide an outstanding recovery request. Focused mocked Workflow checks
  confirmed that queued work is not dispatched after abort and human/recovery
  waits do not consume provider capacity. The independent Temporal reviewer
  reported no remaining actionable finding in this scope.

## Temporal execution evidence

Application run: `2026-09-07T18-43-27-320Z-1536c7`

Temporal Run ID: `01a07d2e-b1f5-753b-9310-e73c1c3cbf1a`

Workflow type: `stewardWorkflow`

The execution closed `WORKFLOW_EXECUTION_STATUS_COMPLETED`. The `review` node
returned four per-item objects in the same order as the `plan.tasks` array, and
the `summarize` node received that aggregate.

The durable event stream recorded queue starts for items 1 and 2 at
`18:43:28.102Z` and `.103Z`. They committed at `18:43:28.721Z` and `.723Z`;
only then did items 3 and 4 start at `.740Z` and `.741Z`. The node-level
aggregate committed after items 3 and 4 at `18:43:29.375Z`. This demonstrates
the configured cap of two for this equal-duration simulated run.

A read-only Temporal describe reported
`WORKFLOW_EXECUTION_STATUS_COMPLETED`, workflow type `stewardWorkflow`, close
event 89, and the same ordered final result as the application projection.

Four distinct accepted item outputs exist under `nodes/review/items/0001` through
`0004`. Each item's primary receipt, exact prompt, input, schema, and candidate
output live in a dispatch-scoped directory under:

- `nodes/review/items/0001/dispatches/recovery-0000-<receipt-token>/`
- `nodes/review/items/0002/dispatches/recovery-0000-<receipt-token>/`
- `nodes/review/items/0003/dispatches/recovery-0000-<receipt-token>/`
- `nodes/review/items/0004/dispatches/recovery-0000-<receipt-token>/`

ADR-016 removes the pre-adoption interpreter and Activity compatibility
exports. Both queued and ordinary nodes now use the same rolling scheduler,
`stewardWorkflow` type, and `executeAgent` Activity. Existing runtime data is
preserved, but histories started under removed Workflow types require their
matching historical bundle and are not supported by the current worker.

## Remaining limits

- The end-to-end run used the simulated executor; real Codex quality and
  provider latency were not tested.
- Empty-array behavior and rolling refill selection are covered by deterministic
  unit tests, not a retained Temporal run. The retained recovery run uses equal
  simulated delays; the earlier retained execution demonstrates out-of-order
  completion and source-ordered aggregation but predates the permit refactor.
- Per-item operator recovery was exercised with two failed items and two
  simultaneously actionable requests. Real-provider recovery remains untested.
- Expanded values and aggregate outputs still contribute to Temporal history;
  the current documented payload/history limits remain production gaps.
- The operator-readable disk projection is serialized only within the supported
  single worker process. Multi-worker projection requires a Temporal-native
  redesign rather than an additional queue or lock system.
