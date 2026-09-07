# Composable scopes and repeat — implementation evidence

User outcome: group a graph, repeat review plus parallel agents until both succeed in the same iteration, and release the next agent once. The root task orchestrated; worker agents authored the red tests, implementation, presentation/docs, and independent review. ADR-019 adopts these semantics ahead of the remaining P4 work, under ADR-002/003/009/016 ownership and compatibility boundaries.

## Final frozen validation

`rtk proxy sh -c 'npm run verify:all > /tmp/steward-scope-verify-final.log 2>&1; result=$?; tail -65 /tmp/steward-scope-verify-final.log; exit "$result"'` completed with **exit 0**. The invocation ran with approved local loopback/IPC access; no production or test files changed during this final run.

- Installer contract: passed; 8/8 installer tests.
- TypeScript: `tsc --noEmit` passed.
- Unit/integration: 99/99 tests, including supported-history replay, immutable scope acceptance, flat V1 compatibility, and Console/authoring checks.
- CLI/real-Temporal end-to-end: 69/69 tests.
- No skipped, cancelled, or failing tests in any TAP stage. Installer tests are also included in the unit glob; these counts are stage counts, not unique-test totals.
- Recovery: `ok: true`; worker death after provider completion recovered deleted receipt/output/prompt snapshots with zero provider reruns. Network recovery reran zero committed siblings; queued waits released capacity; corrupt superseded dispatches remained retained while fresh recovery completed; invalid mapped input closed Temporal as FAILED.
- `rtk git diff --check`: exit 0.

The complete output is [scope-loops-final-2026-09-07.tap](scope-loops-final-2026-09-07.tap). The tested source manifest covers 91 source/test/UI/skill/package files, based on git `b8fcaffa123b478aaeb5c5ffb53d5a598c6c3d5f`, with snapshot SHA-256 `e8d855a852279941beb7ed593d48345caefb12bcb7cc3cb10d5a34174e1c9af3`: [manifest](scope-loops-source-manifest-2026-09-07.json). Documentation and validation reports are excluded from that code snapshot.

An earlier broad run also passed, but a final flat-literal compatibility correction landed after its unit/E2E stages. It is not used as final snapshot evidence; the frozen run above supersedes it.

## Red-first and independent review

The original [red acceptance report](scope-loops-red-2026-09-07.md) records a healthy baseline and two parser failures before implementation. Those original scope tests remain unchanged. They now prove explicit state carry and three review/parallel rounds `(true,false)`, `(false,true)`, `(true,true)` without accumulating successes between iterations; every accepted provider receipt is schema/hash checked and the final consumer runs once.

Additional observed red-to-green slices:

- [Nested human restart](scope-human-red-2026-09-07.tap): missing immutable answer artifact after a real worker restart; now unique iteration-qualified gates resume the same Temporal run, reject stale answers, preserve draft receipts, and commit immutable answers.
- [Scope array composition](scope-composition-red-2026-09-07.tap): a scope-exported array was rejected as a `for_each` source; inferred export schemas now support downstream mapping.
- [Ordinary loop outcome](loop-outcome-red-2026-09-07.tap): absent runtime outcome; now new executions publish an interpreter outcome through a Temporal patch marker.
- [Nested provenance corruption](scope-artifacts-red-2026-09-07.tap), [terminal receipt substitution](scope-artifacts-terminal-red-2026-09-07.tap), and [superseded corrupt receipt](scope-artifacts-superseded-red-2026-09-07.tap): immutable commits now validate exact accepted descriptors. A corrupt accepted artifact fails; rejected older dispatches cannot block valid fresh recovery or replace terminal evidence.
- [Flat literal compatibility](scope-literal-red-2026-09-07.tap): flat `$state.value`/`$output` literals were accidentally rejected; flat V1 compilation and history resolution retain literal behavior. Invalid-state tests target a non-loop executable scope, where strict scoped references apply.

[Independent review](scope-review-2026-09-07.md) records resolved findings and no outstanding actionable issues. [Presentation evidence](scope-presentation-2026-09-07.md) records live read-only inspection of nested outputs; the human UI check used an explicitly labelled historical projection fixture.

## Durable contracts exercised

Scopes execute without provider permits. Nested leaves share existing workflow/group/agent-map limits; nested loops complete at a global capacity of one. Scope iteration output commits only after every child completes. The acceptance Activity validates the inferred export schema, re-resolves export bindings, and verifies exact event-bound provider receipts or immutable child-scope/human artifacts. Atomic publication preserves existing bytes; committed `artifactSha256`, schema hashes, and child evidence hashes detect later corruption.

Full instance IDs contain every ancestor iteration, e.g. `resolve~2.parallel_work~1.validation`. Scope state replaces the declared initial keys on each repeat; loop-free scopes inherit enclosing state, and inner loops have independent state. `all`/`any`/`not` are declarative predicates; invalid/missing operands fail rather than becoming false or accepted exhaustion. Scope terminal outcomes distinguish condition satisfaction, accepted exhaustion, and failed exhaustion. New ordinary loops publish the same outcomes; historical records without an outcome remain unknown in Console.

Scopes require 1–20 iterations, nesting is limited to eight scope levels, and scope-enabled execution has a 1000-step-instance expansion budget including mapped work and leaf loop iterations. The 1001-item top-level map fixture rejects before provider dispatch. Dependencies and exports stay within their graph; scope references may read declared dependency ancestry. Scope exports infer child-output schemas; unconstrained input/object contents still require runtime resolution.

## Supported-history replay

`tests/fixtures/pre-scope-predicate-history.json` was generated by the **unchanged pinned original git revision** `b8fcaffa123b478aaeb5c5ffb53d5a598c6c3d5f` in `/tmp/steward-pre-scope-source`, with a separate Temporal database. Its old missing-path `not_equals` predicate completed as defined by the original interpreter. Origin: [generation record](scope-legacy-history-origin-2026-09-07.txt). The existing checkout was never reset.

`tests/fixtures/pre-outcome-loop-history.json` contains a two-iteration ordinary loop recorded before the outcome patch. Both fixtures replay with the current `stewardWorkflow` bundle in `tests/replay.test.ts`; [replay output](scope-replay-2026-09-07.tap) reports 2/2 pass. New normalized predicates carry version 2; old snapshots keep their original evaluator. The `steward-loop-outcomes-v1` patch preserves old Workflow command histories while emitting outcomes for new work. No removed pre-adoption Workflow type was restored.

## Runnable example and retained runs

Workflow: `/Users/bharath2020/Documents/projects/steward/skills/steward-workflow/assets/scope-loop.yaml`.

Input: `/Users/bharath2020/Documents/projects/steward/skills/steward-workflow/assets/scope-loop-input.json`.

From the repository, with the current worker and Temporal service running:

```sh
npm run start -- --workflow skills/steward-workflow/assets/scope-loop.yaml --input skills/steward-workflow/assets/scope-loop-input.json --mode simulated
```

Final isolated evidence directories (each retains its Temporal database and run artifacts):

- Existing consumer CLI scenarios: `/var/folders/1c/wkzr1t1945v0tg_882wwqshh0000gn/T/steward-cli-e2e-w4CDjw`
- Ordinary outcome: `/var/folders/1c/wkzr1t1945v0tg_882wwqshh0000gn/T/steward-cli-e2e-PZPqY8`
- Boundaries: `/var/folders/1c/wkzr1t1945v0tg_882wwqshh0000gn/T/steward-cli-e2e-IHKVKj`
- Array/admission composition: `/var/folders/1c/wkzr1t1945v0tg_882wwqshh0000gn/T/steward-cli-e2e-4IPdpe`
- Nested human restart: `/var/folders/1c/wkzr1t1945v0tg_882wwqshh0000gn/T/steward-cli-e2e-9gUXeT`
- Original requested examples: `/var/folders/1c/wkzr1t1945v0tg_882wwqshh0000gn/T/steward-cli-e2e-J1NoYn`

All isolated test processes shut down. Existing repository runtime processes and `runtime/temporal.db`/`runtime/runs/` were preserved. The implementation and its evidence remain uncommitted; pre-existing working changes were retained.

## Limits of this evidence

These are local, simulated-provider tests against real Temporal, plus browser presentation checks and two supported-history replay fixtures. They do not qualify live Codex execution, every possible history, power-loss durability, remote deployment, or any production release gate. Scopes use the existing same-host artifact store, not the target transactional evidence backend. Immutable human answer artifacts are added for nested scope gates; flat V1 human execution retains its existing command path. This bounded feature does not implement the remaining P1–P4 roadmap.
