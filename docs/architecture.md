# Steward architecture

Status: current implementation, reviewed 2026-09-05. For the target, read the [vision](vision.md), [decisions](decisions.md), [technical design](technical-design.md), and [production roadmap](production-roadmap.md).

For component ownership and the current-file extraction map, read the [software architecture](software-architecture.md).

## Components in one repository

The project remains one TypeScript package. **Steward CLI**, **Steward Server**, **Steward Console** (the browser UI), and the Temporal worker are separate roles, with the existing runtime core shared where needed. [ADR-010](decisions.md#adr-010--one-repository-with-cli-server-and-ui-template-boundaries) records this component extraction and the presentation boundary.

| Component | Current files | Responsibility |
|---|---|---|
| Steward CLI | `src/cli/start.ts`, `src/cli/answer.ts` | Parse arguments, load the requested definition/input, and call the shared Temporal client. Each exports `main`; importing it does not issue commands. |
| Local launcher | `src/cli/launcher.ts` | Start local Temporal, worker, and dashboard processes and optionally request a demo run. Resource creation and signal handlers begin when `main` is invoked. |
| Steward Server | `src/server/index.ts` | Serve snapshots/SSE, accept the existing start/input/recovery requests, and serve Steward Console. `createDashboardServer` constructs the server; `main` binds it to loopback. |
| UI templates | `src/server/templates.ts`, `ui/templates/` | Compose a shell from known toolbar, run-list, graph, inspector, and timeline fragments. Resolve application-owned UI files relative to the server module and serve an explicit asset allowlist. |
| Steward Console | `ui/assets/` | Share one graph/event/action implementation across layouts and themes. Appearance code owns browser preferences; CSS owns layout and color. |
| Temporal worker and core | `src/worker.ts`, `src/workflows.ts`, `src/activities.ts`, and the existing flat shared modules | Poll Temporal, advance the graph deterministically, execute node work, and persist evidence. Legacy runtime exports and behavior remain in place. |

Root `src/start.ts`, `src/answer.ts`, `src/launcher.ts`, and `src/server.ts` are compatibility entrypoints. Existing root npm commands and recovery-harness paths continue to work. The CLI connects to Temporal through `src/client.ts` directly; it does not require the HTTP server. This extraction does not yet implement the target `ControlPlane`, transactional stores, or reconciled read service: the HTTP server still reads disk projections and forwards commands through the shared client.

The UI provides **Board** and **Review** layouts with **Dark**, **Light**, and **System** themes. Preferences are stored in browser `localStorage`; appearance changes update attributes/CSS without reloading the page or replacing the current inspector form. Both layouts retain the same runtime event stream and command handlers. The `r` shortcut ignores editable inputs, textareas, selects and their editable descendants, modified/repeated keys, and an already pending start request. `startRun` also rejects a second invocation while its request is in flight. This browser guard does not provide durable start-command deduplication.

`ui/brand.json` supplies escaped display text to Steward Console using the approved Steward name. Repository relocation and publication are still in progress. UI templates are reusable presentation fragments, layouts, and themes; this change does not establish a GitHub starter-template repository.

The display-name change preserves compatibility: existing `YAMLFLOW_*` settings, `yamlflow-<runId>` workflow IDs, the `yamlflow-agent-nodes` task queue, and the `yamlAgentWorkflow`/`yamlAgentWorkflowV2` workflow types retain their established spelling. Existing schema names, persisted identities, and historical provenance are unchanged.

## Execution flow

Steward separates orchestration from agent work.

1. The control plane loads and validates the YAML, hashes it, and starts one Temporal workflow with the immutable definition and initial input.
2. The Temporal workflow computes ready nodes only from committed dependency results. A ready set is a wave; its members execute concurrently up to global and named-group `max_parallelism` limits.
3. Each node runs as an Activity. In `simulated` mode it emits deterministic demo output. In `codex` mode it launches an isolated, read-only `codex exec` process with a generated JSON Schema and resolved inputs. The Activity parses `thread.started`, immediately heartbeats the provider session, and uses `codex exec resume` on a matching automatic retry.
4. Agent output validation and receipt commit happen before the result becomes available to downstream nodes. Human nodes wait for a validated `submitHumanInput` Update and record an `{answer}` result through the event path. That human path does not yet create the same output artifact and receipt; closing this gap is a production hardening requirement.
5. A node may define a bounded `loop`. Its last output is carried into the next iteration under `carry_as`; the loop exits only when `until` passes or its explicit exhaustion policy applies. Arbitrary graph cycles remain invalid.
6. Before an Activity returns, its schema-valid output is bound into an immutable completion receipt containing the Workflow Run ID, one-time dispatch token, node/iteration identity, provider session, and prompt/schema/output hashes. A second immutable copy is written under `receipts/`. On retry, matching evidence can restore a missing copy or output projection without invoking the provider again; invalid or disagreeing evidence is rejected.
7. Temporal stores replayable execution history in `runtime/temporal.db`. The application also writes `definition.json`, `input.json`, `state.json`, `events.jsonl`, and per-node prompt/input/schema/output artifacts under `runtime/runs/<run-id>/`. Each node also owns a deduplicated `messages.jsonl` containing only human-readable agent messages.
8. Retryable provider failures receive the YAML-defined automatic attempt budget. After exhaustion, the V2 Workflow waits durably for a validated `submitAgentRecovery` Update. The operator may resume the checkpointed session, start fresh, or abort. Parallel siblings that already committed are not rerun.
9. The dashboard reads only those durable artifacts and receives snapshots over SSE. It never decides workflow state.

The root Codex agent is an operator: start, inspect, retry through Temporal, and report. It does not answer node prompts. That boundary is also recorded in `AGENTS.md`.

## Durability boundary

The bundled Temporal development server uses persistent SQLite so workflows survive worker or launcher restarts. The browser's EventSource reconnects after a network interruption and reloads the latest disk projection. Production should use Temporal Cloud or a production Temporal deployment, external artifact storage, authenticated APIs, idempotent side effects, secrets management, and workload-specific sandbox policies.

Run `npm run resume` after stopping the local stack. It opens the same Temporal database, starts a worker, and does not create a duplicate workflow. New executions use `yamlAgentWorkflowV2`; `yamlAgentWorkflow` remains registered so pre-upgrade V1 histories can replay without a command-sequence mismatch.

Run `npm run verify:recovery` for a destructive-to-its-own-temp-directory test that:

1. kills a worker after the primary completion receipt is committed;
2. deletes the output and redundant receipt projection;
3. restarts the worker and requires receipt reconciliation with zero provider reruns;
4. exhausts two injected network attempts in one parallel branch;
5. resumes its heartbeated session through a Workflow Update; and
6. requires the workflow to finish without rerunning already-completed siblings or duplicating transition IDs.

Application events use stable IDs. On an Activity retry, the store detects an existing transition, replays `events.jsonl`, and reconstructs `state.json`. Temporal history remains the scheduling authority; the JSONL timeline is the readable audit projection.

Both receipt copies and SQLite live on the same host in this demo. Whole-host or disk loss is therefore outside its durability boundary; externally replicated storage is required for that failure class.

## Current production gaps

The dashboard currently reads disk projections without reconciling Temporal lifecycle, and `/health` checks the runtime directory rather than complete service readiness. Event/message locks are process-local. Start requests lack a stable caller command ID; HTTP control is always enabled on loopback. Receipt storage paths omit recovery cycle even though validation includes it, which can prevent fresh recovery when earlier receipt evidence is invalid. Whole definitions and outputs are repeatedly included in history, and the scheduler waits on whole waves.

The launcher also remains tied to the repository working directory. `src/cli/launcher.ts` hardcodes `runtime/temporal.db` and `runtime/services`, and probes Temporal at port 7233, while `src/store.ts` honors `YAMLFLOW_RUNTIME_DIR` and the client/worker honor `TEMPORAL_ADDRESS`. Overriding these variables does not relocate the launcher's database/logs or configure its Temporal probe. A future shared runtime profile must align these settings; moving source files into components has not fixed this limitation.

These are source-reviewed gaps, not repaired behavior. The [technical design](technical-design.md) specifies the replacement contracts, including common human/final commits, transactional evidence, isolated dispatches, status reconciliation, bounded history, safe control, and preserved legacy replay.

The browser in `ui/assets/app.js` also re-evaluates loop conditions with fewer operators than the runtime (`contains` and `truthy` are missing), so its loop result label can drift. The target assigns predicate evaluation to the interpreter and carries an explicit outcome into shared presentation.

## Component-change validation

On 2026-09-05, `npm run build` completed with exit 0. `node --import tsx --test tests/cli.test.ts tests/ui-templates.test.ts` completed with exit 0 and 7/7 tests passing. These cover import-time CLI behavior, template mount points, the public asset allowlist, preference normalization, system-theme selection, and the shortcut's typing/modifier guards. The root start/answer compatibility entrypoints also retained their invalid-input diagnostics and exit code 1.

The full `npm run verify` passed with exit 0 and 25/25 tests. Isolated simulated recovery passed with zero provider reruns and zero repeated completed siblings. Browser checks covered Board/Review, light/dark/system themes, preference persistence, retained unsent input, and a 390px viewport. See [retained validation notes](validation/component-ui-2026-09-05.md). These checks do not mark a release gate passed or establish production, full replay, or relocation compatibility.
