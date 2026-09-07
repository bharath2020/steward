# Consumer CLI coverage

The implemented interface is the npm scripts and root TypeScript entrypoints. There is no installed `steward` binary yet. The commands in `cli-architecture-and-product-spec.md` are a target specification, not the current executable surface.

## Commands available today

| Command | Consumer options / behavior | Verification owner |
| --- | --- | --- |
| `npm run start -- …` | `--workflow`, `--input`, `--mode simulated\|codex`, `--delay-ms`; defaults to product launch and simulated mode; prints `{runId, workflowId}` after submission | `tests/e2e/cli.test.ts` |
| `npm run answer -- …` | Requires `--run`, `--request`, `--answer`; prints acceptance JSON; unknown/already consumed requests reject | E2E human scenarios |
| `npm run demo -- …` | Starts local services and a run; `--mode`, `--delay-ms`, `--no-start`; remains attached | Existing isolated macOS installer job exercises supervisor startup |
| `npm run resume` | Launcher with `--no-start`; starts/reuses local services without submitting another run | Existing isolated setup job verifies reconnection and no duplicate starts |
| `npm run setup -- …` | macOS bootstrap; `--example questions\|product\|privacy\|file\|queue`, `--new-run`, `--check`, `--no-open` | Setup unit checks, E2E rejection checks, isolated macOS installation job |
| `npm run worker`, `npm run dashboard` | Service processes; environment configuration | Real worker in E2E; server and recovery API in recovery suite |
| `npm run verify:recovery` | Developer fault harness, not a consumer recovery command | Worker loss, receipt corruption, retry exhaustion and session recovery |

Relevant environment: `TEMPORAL_ADDRESS`, `YAMLFLOW_RUNTIME_DIR`, `YAMLFLOW_PORT`; the launcher still uses fixed Temporal ports and repository-local database/log paths. Setup refuses custom runtime/address overrides. Recovery is currently an API/UI operation, not an `npm run recover` command.

The start/answer parsers do not implement a comprehensive help/unknown-option contract. Start does not fully prevalidate input bindings or validate the numeric CLI delay override. These are implementation gaps, not passing negative-path guarantees. Do not infer planned validation, cancellation, export, or idempotency commands from this test suite.

## Run the setup

Prerequisites: Node 22 or later, `npm ci`, and `temporal` on PATH. CI installs checksum-verified Temporal CLI 1.8.2. Tests require permission to listen on loopback ports and spawn local processes. No provider credentials are required.

```sh
npm run test:e2e
```

Run all existing checks, the CLI matrix, and fault recovery together:

```sh
npm run verify:all
```

The E2E suite invokes the exact root entrypoints used by npm scripts as separate Node processes, uses a real Temporal development server and real worker, and forces simulated provider execution. Fixed fixture outputs are synthetic test data; this does not qualify live Codex quality, authentication, or permission enforcement.

Each invocation allocates an OS temporary directory and an ephemeral port, writes a private Temporal database, and retains worker/server logs and run artifacts. It prints `E2E evidence: <directory>`. Service shutdown is bounded with a kill fallback. No application `runtime/` files are removed or changed. The launcher/bootstrap is tested in the separate disposable macOS installation because its fixed ports and paths cannot safely share this harness's isolation scheme.

CI runs the matrix in the existing Temporal-equipped Linux job and uploads its temporary evidence on success or failure. The existing macOS job remains responsible for clean-host download/install and repeat setup behavior. Local `verify:all` does not reproduce the clean-host installation job.

## Scenario matrix and assertions

| Family | Happy path | Negative / boundary path |
| --- | --- | --- |
| Shipped YAML inventory | All five `workflows/*.yaml` files run with their example input | Adding a YAML without a mapped scenario fails the inventory check |
| DAG / joins / groups | Product launch, privacy research, multiple-choice fan-in | Dependencies must finish before downstream starts; failed loop blocks its join |
| Human gates | Two and four simultaneous requests; letter and free-text answers through answer CLI | Unknown request, duplicate answer, blank/missing CLI arguments; partial answers cannot finish final brief |
| File prompts | Shipped relative Markdown prompt executes | Missing file and conflicting inline/file declaration; deleted-source snapshot recovery in recovery suite |
| Types | All eight declared output types survive receipt commit | Invalid output type and demo/schema mismatch reject before start |
| Loops | All eight predicate operators; product runs two iterations and privacy runs three | Bounded failure and `accept_last`; unsupported predicate and excessive iteration bound |
| Array queue | Four ordered results with concurrency cap two; single and empty input arrays | Missing/scalar source fails in Temporal; invalid limits, aliases, references, and incompatible human/loop declarations reject |
| Definition / CLI validation | Valid YAML and JSON load through CLI subprocess | Version, empty graph, dependency, cycle, prompt, group, provider, retry/parallelism/delay, malformed YAML/JSON, missing files, setup misuse |
| Recovery (existing suite) | Committed output survives worker loss; same-session/fresh recovery | Lost receipt/output projections, deleted prompt file, automatic retry exhaustion, multiple waiting queue items, corrupt receipt, invalid array source |

Success assertions reconcile Temporal `COMPLETED`, Workflow result, final snapshot, and persisted completion events. Agent receipts are checked for output schema, run identity, provider, receipt/output hashes, and dispatch output content. Queue item receipt count and source order are verified. Human answers and queue aggregate results currently live in transition events; they do not have the agent completion-receipt contract. Loop completion checks use the last iteration's event. Runtime failures must reach Temporal `FAILED`, not merely display a failed snapshot.

Ownership: release/integration harness (`tests/e2e`); no interpreter or execution behavior changes. Applicable decisions: ADR-003 (execution versus evidence), ADR-008 (evidence gates), ADR-010 (CLI entrypoints), ADR-011 (file prompts), ADR-012 (bootstrap), ADR-015 (bounded fan-out), ADR-016 (current interpreter). This coverage improves operator confidence in the current interface; it does not mark a production release gate passed.
