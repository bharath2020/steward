# Steward architecture

Status: current implementation, reviewed 2026-09-07. For the target, read the [vision](vision.md), [decisions](decisions.md), [technical design](technical-design.md), and [production roadmap](production-roadmap.md).

For component ownership and the current-file extraction map, read the [software architecture](software-architecture.md).

## Components in one repository

The project remains one TypeScript package. **Steward CLI**, **Steward Server**, **Steward Console** (the browser UI), and the Temporal worker are separate roles, with the existing runtime core shared where needed. [ADR-010](decisions.md#adr-010--one-repository-with-cli-server-and-ui-template-boundaries) records this component extraction and the presentation boundary.

| Component | Current files | Responsibility |
|---|---|---|
| Steward CLI | `src/cli/start.ts`, `src/cli/answer.ts` | Parse arguments, load the requested definition/input, and call the shared Temporal client. Each exports `main`; importing it does not issue commands. |
| Local launcher | `src/cli/launcher.ts` | Start local Temporal, worker, and dashboard processes and optionally request a demo run. Resource creation and signal handlers begin when `main` is invoked. |
| Steward Server | `src/server/index.ts`, `src/authoring.ts` | Serve snapshots/SSE, accept the existing start/input/recovery requests, mediate bounded read-only Codex/Claude authoring, and serve Steward Console. `createDashboardServer` constructs the server; `main` binds it to loopback. |
| UI templates | `src/server/templates.ts`, `ui/templates/` | Compose a shell from known toolbar, run-list, graph, inspector, and timeline fragments. Resolve application-owned UI files relative to the server module and serve an explicit asset allowlist. |
| Steward Console | `ui/assets/` | Share one graph/event/action implementation across layouts and themes. Observe shows durable runs; Build holds browser-session chat/YAML and previews parser-accepted definitions. Appearance code owns browser preferences; CSS owns layout and color. |
| Temporal worker and core | `src/worker.ts`, `src/workflows.ts`, `src/activities.ts`, and the existing flat shared modules | Poll Temporal, advance the graph deterministically through the single `stewardWorkflow` interpreter, execute node work, and persist evidence. |

Root `src/start.ts`, `src/answer.ts`, `src/launcher.ts`, and `src/server.ts` are compatibility entrypoints. Existing root npm commands and recovery-harness paths continue to work. The CLI connects to Temporal through `src/client.ts` directly; it does not require the HTTP server. This extraction does not yet implement the target `ControlPlane`, transactional stores, or reconciled read service: the HTTP server still reads disk projections and forwards commands through the shared client.

The UI provides **Board** and **Review** layouts with **Dark**, **Light**, and **System** themes. Preferences are stored in browser `localStorage`; appearance changes update attributes/CSS without reloading the page or replacing the current inspector form. Both layouts retain the same runtime event stream and command handlers. The `r` shortcut ignores editable inputs, textareas, selects and their editable descendants, modified/repeated keys, and an already pending start request. `startRun` also rejects a second invocation while its request is in flight. This browser guard does not provide durable start-command deduplication.

Console responsive CSS stacks panels below 700 CSS pixels and uses a horizontal run picker with two work columns at 700–1180 pixels. Board pairs graph/inspector; Review pairs inspector/timeline below a full-width graph. Wider viewports retain desktop composition. Runner/Pace remain visible on phones, and touch controls have 44-pixel minimum targets. See [responsive behavior and validation](../ui/README.md#phone-and-ipad-layouts). This is presentation-only work under ADR-010.

Build mode places an agent chat rail beside the existing SVG graph on desktop and stacks them on narrow screens. Selecting a preview node reveals its exact prompt or human question, configuration, bindings, and declared outputs in a graph-local detail drawer. `src/authoring.ts` supplies the V1 contract to either the installed Codex or Claude Code CLI, requires structured reply/YAML output, and invokes the same pure `parseWorkflow` function used by authored files. Invalid YAML receives one parser-diagnostic repair attempt and is otherwise shown as an error without replacing the last valid graph. A parser-accepted draft enables an explicit browser YAML download; the server does not choose or write a path. The endpoint is bounded and same-loopback-origin, and providers run without write permission. Chatting and exporting cannot start Temporal; see ADR-013 and ADR-014.

`ui/brand.json` supplies escaped display text to Steward Console using the approved Steward name. Repository relocation and publication are still in progress. UI templates are reusable presentation fragments, layouts, and themes; this change does not establish a GitHub starter-template repository.

Some pre-adoption local identifiers still use the YAMLFlow working name. ADR-016 replaces the old Workflow registrations with the single `stewardWorkflow` type. Existing runtime files and historical provenance are preserved, but removed-type executions are not supported by the current worker.

## Execution flow

Steward separates orchestration from agent work.

1. The control plane loads and validates the YAML, hashes it, and starts one Temporal workflow with the immutable definition and initial input.
2. The Temporal workflow computes ready nodes only from committed dependency results. A ready set is a wave; its work queue executes concurrently up to global, named-group, and node-local `for_each.max_parallelism` limits.
3. Each node runs as an Activity. In `simulated` mode it emits deterministic demo output. In `codex` mode it launches an isolated, read-only `codex exec` process with a generated JSON Schema and resolved inputs. The Activity parses `thread.started`, immediately heartbeats the provider session, and uses `codex exec resume` on a matching automatic retry.
4. Agent output validation and receipt commit happen before the result becomes available to downstream nodes. Human nodes wait for a validated `submitHumanInput` Update and record an `{answer}` result through the event path. That human path does not yet create the same output artifact and receipt; closing this gap is a production hardening requirement.
5. A node may define a bounded `loop`. Its last output is carried into the next iteration under `carry_as`; the loop exits only when `until` passes or its explicit exhaustion policy applies. Arbitrary graph cycles remain invalid.
6. An agent node may define `for_each` over an input or dependency array. The interpreter expands that array into source-ordered work items, injects one item under `as`, drains them with the strictest applicable concurrency cap, and aggregates committed item outputs back into source order. Each item has its own Activity iteration, provider session, artifacts, recovery request, and completion receipt. Empty arrays commit without provider work. `for_each` and `loop` are mutually exclusive.
7. Before an Activity returns, its schema-valid output is bound into an immutable completion receipt containing the Workflow Run ID, one-time dispatch token, recovery cycle, node/iteration identity, provider session, and prompt/schema/output hashes. Candidate evidence and the primary receipt live in a dispatch-scoped directory; a token/cycle-specific mirror is written under `receipts/`, while the accepted logical output has a stable path. On retry, matching evidence can restore a missing copy or output projection without invoking the provider again. Invalid evidence is retained but rejected, and fresh recovery writes a distinct dispatch.
8. Temporal stores replayable execution history in `runtime/temporal.db`. The application also writes `definition.json`, `input.json`, `state.json`, `events.jsonl`, and per-node prompt/input/schema/output artifacts under `runtime/runs/<run-id>/`. Queued item artifacts live under `nodes/<node-id>/items/<index>/`. Each node also owns a deduplicated `messages.jsonl` containing only human-readable agent messages.
9. Retryable provider failures receive the YAML-defined automatic attempt budget. After exhaustion, the Workflow releases its execution permit and waits durably for a validated `submitAgentRecovery` Update. Every failed queue item has an independently addressable request; sibling completion or retry events cannot hide another pending request. The operator may resume the checkpointed session, start fresh, or abort. Parallel siblings and queued items that already committed are not rerun.
10. The dashboard reads only those durable artifacts and receives snapshots over SSE. It never decides workflow state.

The root Codex agent is an operator: start, inspect, retry through Temporal, and report. It does not answer node prompts. That boundary is also recorded in `AGENTS.md`.

## Prompt source loading

Agent nodes accept exactly one of `prompt` or `prompt_file` ([ADR-011](decisions.md#adr-011--file-prompts-are-resolved-before-workflow-start)). Both CLI and server use `loadWorkflow` in `src/definition.ts` to load UTF-8 file contents relative to the YAML directory before starting Temporal. The pure `parseWorkflow` API accepts preloaded content as an optional third argument; it never reads a file itself.

Compiled nodes always contain assignment text in `prompt`. File sources also carry the declared path and content SHA-256 in `promptSource`, and the definition hash binds their loaded content. The definition passed to Temporal and saved in `definition.json` is the snapshot reused by Activities and recovery. No live prompt-file read occurs inside Workflow or Activity execution. Existing inline hashes and runtime contracts remain unchanged.

## Durability boundary

The bundled Temporal development server uses persistent SQLite so workflows survive worker or launcher restarts. The browser's EventSource reconnects after a network interruption and reloads the latest disk projection. Production should use Temporal Cloud or a production Temporal deployment, external artifact storage, authenticated APIs, idempotent side effects, secrets management, and workload-specific sandbox policies.

Run `npm run resume` after stopping the local stack. It opens the same Temporal database, starts a worker, and does not create a duplicate workflow. New executions use `stewardWorkflow`. Pre-adoption runs under removed `yamlAgentWorkflow*` types remain stored but require their matching historical bundle to resume.

Run `npm run verify:recovery` for a destructive-to-its-own-temp-directory test that:

1. kills a worker after the primary completion receipt is committed;
2. deletes the output and redundant receipt projection;
3. restarts the worker and requires receipt reconciliation with zero provider reruns;
4. exhausts two injected network attempts in one parallel branch;
5. resumes its heartbeated session through a Workflow Update; and
6. requires the workflow to finish without rerunning already-completed siblings or duplicating transition IDs;
7. exposes two concurrent item-level recovery requests under a permit cap of one;
8. retains a corrupt dispatch while a fresh cycle commits separately; and
9. verifies that a resolved non-array queue source closes Temporal as `FAILED`.

Application events use stable IDs. On an Activity retry, the store detects an existing transition, replays `events.jsonl`, and reconstructs `state.json`. Temporal history is the scheduling and recovery authority; the JSONL timeline is an operator-readable projection serialized within the supported single Steward worker process. The implementation intentionally adds no second queue or distributed-lock authority. Multi-worker projection requires a Temporal-native redesign before that topology is supported.

Both receipt copies and SQLite live on the same host in this demo. Whole-host or disk loss is therefore outside its durability boundary; externally replicated storage is required for that failure class.

## Current production gaps

The dashboard currently reads disk projections without reconciling Temporal lifecycle, and `/health` checks the runtime directory rather than complete service readiness. Start requests lack a stable caller command ID; HTTP control is always enabled on loopback. Authoring checks same-loopback Origin but does not yet use the target local session credential. Whole definitions and outputs are repeatedly included in history. The current disk projection supports one worker process; adding worker replicas without moving projection events behind Temporal-owned coordination is unsupported.

The launcher also remains tied to the repository working directory. `src/cli/launcher.ts` hardcodes `runtime/temporal.db` and `runtime/services`, and probes Temporal at port 7233, while `src/store.ts` honors `YAMLFLOW_RUNTIME_DIR` and the client/worker honor `TEMPORAL_ADDRESS`. Overriding these variables does not relocate the launcher's database/logs or configure its Temporal probe. A future shared runtime profile must align these settings; moving source files into components has not fixed this limitation.

These are source-reviewed gaps, not repaired behavior. The [technical design](technical-design.md) specifies the replacement contracts, including common human/final commits, transactional evidence, isolated dispatches, status reconciliation, bounded history, and safe control.

The browser in `ui/assets/app.js` also re-evaluates loop conditions with fewer operators than the runtime (`contains` and `truthy` are missing), so its loop result label can drift. The target assigns predicate evaluation to the interpreter and carries an explicit outcome into shared presentation.

## Component-change validation

On 2026-09-05, `npm run build` completed with exit 0. `node --import tsx --test tests/cli.test.ts tests/ui-templates.test.ts` completed with exit 0 and 7/7 tests passing. These cover import-time CLI behavior, template mount points, the public asset allowlist, preference normalization, system-theme selection, and the shortcut's typing/modifier guards. The root start/answer compatibility entrypoints also retained their invalid-input diagnostics and exit code 1.

The full `npm run verify` passed with exit 0 and 25/25 tests. Isolated simulated recovery passed with zero provider reruns and zero repeated completed siblings. Browser checks covered Board/Review, light/dark/system themes, preference persistence, retained unsent input, and a 390px viewport. See [retained validation notes](validation/component-ui-2026-09-05.md). These checks do not mark a release gate passed or establish production, full replay, or relocation compatibility.


## One-click local setup

Under ADR-012, `Setup Steward.command` and `scripts/setup.sh` bootstrap macOS prerequisites and invoke `src/cli/setup.ts`. The catalog in `src/cli/examples.ts` binds four bundled YAML files to their input JSON. `src/cli/readiness.ts` checks both Temporal poller types and dashboard health. The setup starts the existing launcher detached only when services need attention, then submits the first simulated example or reconnects to saved runs. Example-specific `.command` files explicitly submit new runs. Bootstrap/setup locks serialize clicks; a start-intent record prevents automatic retries after an uncertain submission. None of these records accept node output or define workflow completion.

The supervisor remains local and does not start at login. Setup prints its PID and logs to `runtime/services/`; SIGTERM cleans up its owned services. Existing services and their dashboard example settings are reused. The fixed database/log path and task queue remain; setup rejects runtime-directory and Temporal-address overrides. See the README for prerequisite installation, restart, and uncertain-start behavior.

Validation on 2026-09-06: typecheck and 50 tests passed with exit 0; shell syntax and all four example/input catalogs passed. The installed-prerequisite setup path restarted Temporal and a single worker from the existing database, then a repeat launch kept the same worker and 22 saved runs. All 181 pre-existing `output.json` hashes were unchanged. The file-prompt example submitted through setup as `2026-09-06T08-30-44-705Z-a5e91b`; Temporal Run ID `01a075d7-61e9-720f-84a1-a591f4b15d70` completed at history event 35, with the matching committed review output and receipt. Missing-prerequisite Homebrew installation was source-checked but not executed on a clean Mac. These checks do not claim production/reboot durability or full P2 qualification.

Installer correction (2026-09-07, ADR-017): the public bootstrap and archive default
follow `main`. Every archive invocation downloads source; existing installations
use `scripts/update-install.mjs` to stop cwd-verified Steward services, replace
managed source, and preserve local runtime/configuration data. Previous source
is retained beside the installation. Source manifests remove upstream-deleted
paths on subsequent updates; legacy installs preserve unknown top-level paths.
The install lock spans setup, and setup declines concurrent direct clicks.
Direct setup remains reconnect-only. Neither entrypoint accepts workflow output.

`npm run verify:installer` checks the published command and exercises fresh and
repeat download behavior; it is included in the push/PR `npm run verify` gate.
The isolated macOS job pins both installs to its candidate SHA and checks durable
completion, receipt integrity, and lack of duplicate runs after update/restart.

Local validation on 2026-09-07: `npm run verify` exited 0 with the installer
publication guard, eight installer checks, typecheck, and 75 tests passing.
`bash -n install.sh scripts/setup.sh` and `git diff --check` passed. Fixture
processes verified SIGTERM shutdown only for the installed workspace. These are
local upgrade checks; the configured clean-macOS CI must complete before claiming
fresh prerequisite installation and durable restart verification for this change.
