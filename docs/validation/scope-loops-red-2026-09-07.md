# Scope loop RED evidence — 2026-09-07

User outcome: execute grouped graphs repeatedly, carrying explicit state until a predicate passes, including review → parallel agents → repeat until both succeed in the same iteration → next agent once. Applicable decisions: ADR-002, ADR-003, ADR-009, ADR-016; new scope semantics require the implementation decision record.

## Tests written before implementation

`tests/e2e/scope-loops.test.ts` SHA-256: `2313205ff194f158f73111ea4c0c0b06e938aba8076402823916213c9cad9c4f`.

- Healthy baseline exercises CLI → real isolated Temporal → simulated provider → committed receipts → Temporal closure.
- Draft/review scope requires two complete iterations, verifies initial and carried inputs from persisted input artifacts, retains both drafts and all five provider receipts, and releases the downstream agent once.
- Review/parallel nested scope requires three rounds: success pairs `(true,false)`, `(false,true)`, `(true,true)`. This prevents incorrectly accumulating successes across iterations. It asserts ten receipts, state feedback to review, both starts before either completion in each round, review-before-branches, both commits before the next review, and downstream only after the final round.
- Every provider receipt is checked for body/output hashes, run identity, provider, schema validity, and matching persisted output. Completion reconciles Temporal result and persisted finalOutputs. The helper loads each receipt's committed schema artifact so nested identities are never skipped through a flat definition lookup.

## Commands and observed results

`rtk npm run build`: exit 0 (`tsc --noEmit`).

`rtk proxy sh -c 'node --import tsx --test --test-concurrency=1 tests/e2e/scope-loops.test.ts > /tmp/steward-scope-red.log 2>&1; result=$?; cat /tmp/steward-scope-red.log; exit "$result"'`: final exit 1. Executed with approved escalation to permit isolated loopback listeners. Final TAP retained in `scope-loops-red-2026-09-07.log`.

Real Temporal evidence directory: `/var/folders/1c/wkzr1t1945v0tg_882wwqshh0000gn/T/steward-cli-e2e-DtDbiw`.

Observed baseline PASS. Both requested feature cases FAIL in the public start CLI before runtime submission:

- `Invalid workflow: node improve requires exactly one of prompt or prompt_file`
- `Invalid workflow: node resolve requires exactly one of prompt or prompt_file`

TAP reports 1 passing subtest and 2 failing feature subtests (3 failures including enclosing suite). The failures demonstrate that executable scopes are missing, rather than a Temporal or fixture environment problem.

An earlier sandboxed run failed with `listen EPERM ... 127.0.0.1`; that is environmental and is NOT the feature RED evidence. The isolated database and run directories are retained. Repository `runtime/temporal.db` and `runtime/runs/` were untouched.

## Implementation handoff

Tests use approved `depends_on`; preserve existing `needs` and add the alias with conflicts rejected. Scope `outputs` are exported bindings; agent `outputs` remain schemas. Implement explicit `$state` and scope-local `$input`, terminal `$output` for `next`, nested scopes without repetition, composite `all`, and qualified identities that preserve every iteration's artifacts/events.

Fixture convention: loop-free simulated agents select `demo_outputs` using the nearest enclosing active loop iteration (passing through scopes without loops). Agents with their own loops select by their own iteration. Keep this fixture selection distinct from the full nested instance identity. This convention must be recorded in the new language/simulation documentation.

The final assertions after CLI start remain RED-unreached until implementation exists; no claim is made that those assertions passed. Follow-on coverage remains necessary for exhaustion, invalid references/operands, nested loop counters, expansion bounds, human gates, restart/recovery, and UI projection. No production implementation or commits were performed during this RED phase.
