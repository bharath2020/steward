# Repository execution: red-first implementation evidence

Local date: 2026-09-07. Base commit: `318af0da2682c119045ef376f4c93e10ed5cba1c`.
Node `22.23.2`, Codex CLI `0.153.3`, Temporal TypeScript SDK `1.23.0`.
This records the ADR-022 feature, not a production release gate.

## Observed red tests

Tests were introduced and run before the corresponding implementation:

| Behavior | Observed failure | Isolated evidence directory suffix |
|---|---|---|
| Require a working directory | Start returned exit 0 and a new Workflow ID; expected rejection | `steward-cli-e2e-L3oLOt` |
| Write inside selected repository | External provider detected the wrong cwd; run entered `waiting_for_recovery` instead of completing | `steward-cli-e2e-JbW6Xy` |
| Reject invalid HTTP input | HTTP 500 instead of 400 | `steward-cli-e2e-HQX4n0` |
| Collect directory in Console | Accessible Working directory field count 0 instead of 1 | `steward-cli-e2e-bgn31K` |
| Reject cross-site writable starts | Foreign-origin request returned 202 instead of 403 | `steward-cli-e2e-PuixZE` |

These directories are beneath `/var/folders/1c/wkzr1t1945v0tg_882wwqshh0000gn/T/`.
Initial sandbox `listen EPERM` errors and a test log-creation race were corrected
before treating assertion failures as red evidence. Node Fetch normalizes Host;
the foreign-Host test uses a raw HTTP client to send the intended header.

## Passing verification

- `rtk npm run verify`: installer publication/installation checks, TypeScript,
  and 124 unit/integration tests, including three persisted-history replay tests.
- `rtk npm run verify:recovery`: receipt/output/prompt restoration with zero
  provider reruns; exhausted-attempt operator recovery without rerunning committed
  siblings; independent mapped-item recovery; corrupt-receipt fresh recovery;
  invalid-array workflow failure. Returned `ok: true`.
- CLI, ordinary-loop, nested-scope, human-input and session-continuity E2E
  regressions passed. One older direct CLI invocation initially omitted the new
  argument; its scope-loop suite was updated and rerun, all four tests passing.
- `rtk npm run test:e2e:workspace`, with browser and sandbox opt-ins enabled:
  required-directory rejection, invalid paths, foreign Origin/Host and non-JSON
  rejection, actual repository writes through the external provider adapter,
  canonical-directory persistence across restart/retry, and browser start.
  Live-provider execution is separately opt-in rather than silently billed.
- The 18-node testbed definition and initial input passed the offline loader.

The workspace tests start real isolated Temporal servers and real workers.
Controlled provider fixtures execute as external processes and write actual files;
they do not stand in for proof of model behavior or the real sandbox.

## Live provider and sandbox evidence

`STEWARD_TEST_LIVE_CODEX=1` ran the live provider test successfully in 45.8 seconds.
A first Codex turn wrote `live-marker.txt` in the selected temporary repository;
the next scope iteration resumed the same observed session and read the file.
Both schema-valid outputs and session affinities were committed. Temporal closed
as COMPLETED and its result matched the projection. No testbed builds were run.

The independent installed-CLI sandbox probe wrote inside the selected directory
and rejected a write into the unrelated Steward checkout. This CLI exposes the
built-in workspace profile as `codex sandbox --permission-profile :workspace`;
the initial legacy probe syntax was rejected, not counted as an enforcement pass.
See the [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
for named profiles. The live worker test separately exercised Steward's actual
`codex exec --sandbox workspace-write` fresh/resume adapter arguments.

The controlled recovery test kills its worker at a human gate, retargets the
original input symlink, and restarts the worker from another directory. A later
provider attempt writes an intent marker, fails, and resumes from its heartbeat
session. The accepted earlier output remains byte-identical, the redirected
directory receives no writes, and the original canonical repository is retained.
Its captured history is checked in as
`tests/fixtures/repository-execution-history.json` for replay regression testing.

The [machine-readable evidence index](repository-execution-2026-09-07.json)
contains observed run/Temporal identities, execution bindings, receipt hashes,
session IDs and local artifact paths for live, controlled-recovery and browser runs.
Temporary host paths are retained evidence for this run, not portable fixtures.

## Reproduce the additional checks

```sh
rtk npm run test:e2e:workspace
rtk proxy env STEWARD_PLAYWRIGHT_MODULE=/absolute/path/to/playwright STEWARD_TEST_CODEX_SANDBOX=1 npm run test:e2e:workspace
rtk proxy env STEWARD_TEST_LIVE_CODEX=1 node --import tsx --test --test-name-pattern='live Codex writes' tests/e2e/working-directory.test.ts
```

The live check requires authentication and consumes provider quota. The local
probe requires a compatible installed Codex CLI/OS. Tests report skipped opt-ins
explicitly. Servers, workers and test repositories are isolated; the user's
`runtime/temporal.db` and `runtime/runs/` are preserved.

## Known unrelated failures and limits

The existing `dashboard-workflow-picker.test.ts` explicitly specifies provisional,
unimplemented catalog/prepare/picker behavior. It still has six failing subtests
(seven failures including the parent), while its configured-workflow HTTP baseline
passes with the new mandatory argument. The same six cases also failed on the
unchanged HEAD archive at `/private/tmp/steward-before-repository-3vk7l47i`, with
evidence under `steward-cli-e2e-XmEqku`. The final checkout's corresponding evidence
is under `steward-cli-e2e-CKLmz8`. Therefore the entire existing `test:e2e` glob is
not green; the repository-execution feature does not implement that separate UI.

Workspace writes do not provide rollback, exactly-once shell effects, or orphaned
build-process reconciliation after abrupt host/worker death. Native caches,
network, devices and protected paths remain subject to host/executor policy.
The platform build/test workflow is authored and validated, not executed.
