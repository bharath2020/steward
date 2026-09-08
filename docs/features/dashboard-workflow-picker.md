# Dashboard workflow picker and run mode

Status: feature proposal, 2026-09-07. This report does not adopt a new decision or claim implementation or release validation.

Let an operator choose a workflow in the dashboard, review its input and execution mode, and start a new durable run. For example, choose “Parallel review,” load its example input, select **Simulate**, and watch review lead to two parallel agents. The group repeats until both succeed in the same iteration, then the next agent starts. The operator can later start a separate run using the workflow's declared providers.

## Current behavior and gap

The dashboard starts the single workflow and input configured through `YAMLFLOW_WORKFLOW` and `YAMLFLOW_INPUT`. Its toolbar has Simulated / Real Codex, pace, and Run again controls, but no workflow or input picker. `POST /api/runs` accepts mode and delay; the server loads the configured files. The CLI already accepts workflow and input paths through the same loader and start client. Build can preview and export YAML; a draft is not executable authority.

There is also a provider-routing distinction: the current interpreter passes the run-wide mode to every agent Activity. YAML contains node/default provider declarations, but choosing “Real Codex” currently overrides them. A new “Use workflow providers” choice must implement and test that routing explicitly; renaming the dropdown is insufficient. Supported execution providers today are `simulated` and `codex`. Claude support in authoring does not imply Claude execution support.

Sources: [toolbar](../../ui/templates/components/toolbar.html), [browser actions](../../ui/assets/app.js), [server routes](../../src/server/index.ts), [CLI start](../../src/cli/start.ts), [shared start client](../../src/client.ts), [interpreter](../../src/workflows.ts).

## Proposed MVP

Use a **server-configured catalog of local workflows**, initially containing selected bundled examples and explicitly configured local entries. Each entry has an opaque ID, display name, YAML source, and optional example JSON input. Operators add their own workflows by adding approved local paths and prompt dependencies to server configuration, then restarting the dashboard server; UI registration is later. The browser selects an ID, not an arbitrary server path. This makes existing `prompt_file` workflows usable through the authoritative loader and keeps the first feature small.

Allow input JSON to be edited or uploaded as bounded text data. Defer arbitrary browser YAML uploads: a YAML file alone cannot resolve its relative prompt files, and a browser filename does not identify a server directory. A later upload feature can define a complete dependency bundle and its loading rules. Build-to-run integration is also later; export remains available.

1. **Choose workflow.** Show its name, description when available, and source label. Keep the selected historical run visible until a new run starts.
2. **Set input and mode.** Load the catalog's example JSON when present, with an editor/upload option. Use `{}` only when it passes the applicable checks. Default mode to Simulate. Offer “Use workflow providers” separately; show the resolved provider for every agent, including nested agents and mapped templates. If every declaration is simulated, say so rather than label the run real. Show pace only for simulation.
3. **Validate and preview.** Load the YAML and prompt files on the server, parse JSON, and show the graph, input, provider summary, human gates, and loop limits. Surface errors with node/field context before start. The review describes the prepared definition and input, not a mutable filename alone.
4. **Start new run.** One explicit Start action submits that reviewed intent through the shared start boundary. Disable repeat submission while pending. Reuse the same start identity when reconciling a lost response; do not create a new run merely because the browser timed out. After acceptance, open that run and follow durable snapshots.

Changing workflow, input, or mode invalidates the preview. The server must start the exact prepared definition, loaded prompt contents, input, and resolved mode that were reviewed, or require a new preview if its prepared data expired. It must not silently reread changed files into a different run. A narrowly scoped prepared-start identity is sufficient for this feature; it does not require the broader production control-plane redesign.

## Execution and validation contract

**Simulation is an explicit override.** It runs the real Temporal interpreter with simulated agent execution and labels the entire run, history entry, and output view as simulated. Existing `demo_outputs` and typed simulated defaults supply agent data. Fixtures must support the intended loop path; fixtures that never satisfy `until` should reach the declared exhaustion outcome, not receive fabricated success. Human gates still wait for operator input. Simulation does not establish provider quality or permissions.

**Use workflow providers honors declarations.** Resolve each leaf's explicit provider, then the workflow default, according to the compiler contract. Validate supported/configured capabilities and explain unavailable providers before starting where detectable. Do not launch a paid model call to validate a selection, install providers, or expand permissions. Actual execution retains the current read-only executor boundary. Provider failures after start enter the existing recovery flow. Introduce routing without silently changing legacy run-wide CLI behavior or replay of persisted runs; settle and record that semantic change before implementation.

**Validation reports its limits.** Reuse [the authoritative loader](../../src/definition.ts), not a browser-only YAML parser. Check syntax, dependency structure, loop bounds, exported bindings, JSON validity, and statically resolvable initial-input references and mapped arrays. There is no general workflow-level initial-input JSON Schema today; do not promise exhaustive input validation or validation of outputs that do not yet exist. Runtime-dependent checks remain runtime checks. Loading and previewing do not start Temporal work or provider processes.

**Sources remain bounded.** Catalog configuration authorizes its YAML and prompt dependencies. Resolve canonical paths and reject escapes through traversal or symlinks outside approved sources; never interpret an uploaded JSON filename as a path. Preserve relative `prompt_file` resolution and immutable prompt snapshots. The general loader also supports explicit absolute prompt paths; the picker exposes only dependencies authorized by its catalog configuration, without changing the existing CLI contract. Missing, unreadable, invalid UTF-8, or disallowed dependencies fail preview with an actionable error. Apply request-size limits to input and prepared data.

**The runtime remains the authority.** The dashboard submits and observes. It does not schedule nodes, evaluate loop predicates, merge parallel outputs, or manufacture completion. Existing qualified node IDs address nested human and recovery requests. Scope exports release downstream work only through the existing accepted-output path. An HTTP acceptance means a run was started, not that it completed; completion reporting follows reconciled Temporal status and persisted evidence.

## New runs, history, and status

Workflow/input/mode selection is draft UI state, separate from the historical run being inspected. Reloading or switching history never starts work. Opening a waiting run reconnects to that run; human answers and recovery choices act on its existing identity.

Replace ambiguous Run again behavior with **New run from this run**: prefill the saved definition/input/mode for review and create a new identity only after Start. This is distinct from choosing the latest catalog version and from resuming existing work. A new run starts with fresh runtime state. `scope.loop.agent_sessions: resume` retains sessions only within its documented repeated-scope activation; it does not inherit sessions from a previous run or replace explicit `loop.next` data.

Show selection states separately from execution: unvalidated, validating, ready, validation error, starting, and start outcome unknown. For an unknown start outcome, reconcile the submitted identity before offering another start. Once started, use existing runtime statuses and pending human/recovery requests. Preserve explicit loop outcomes, including accepted and failed exhaustion; the UI must not infer “condition met” from completion alone.

## Ownership and design alignment

| Concern | Existing owner and proposed responsibility |
|---|---|
| Picker, input editor, preview and labels | `ui/`: render server validation and durable snapshots; keep draft selection separate from history. |
| Catalog, prepare/start HTTP adapters | `src/server/index.ts`: bounded request handling and catalog lookup; delegate loading and start. |
| YAML, prompt loading and effective provider contract | `src/definition.ts` / compiler boundary: one authoritative definition and validation path. |
| Start identity and Temporal submission | `src/client.ts` shared start boundary: submit/reconcile one reviewed intent; CLI and dashboard share execution. |
| Scheduling, loops and provider dispatch | `src/workflows.ts`: deterministic runtime decisions; `src/activities.ts` and receipt/scope-artifact owners retain execution and acceptance. |
| History and artifact projections | `src/store.ts`: existing read models; no browser scheduling authority. |

This follows [the vision](../vision.md), [module ownership](../software-architecture.md), and [the technical design](../technical-design.md). Applicable [decisions](../decisions.md) are ADR-001/010 (shared core and adapters), ADR-002/011 (immutable intent and prompt snapshots), ADR-003/005 (execution authority and command identity), ADR-006 (executor capabilities), ADR-013/014 (authoring/export boundary), and ADR-015/019/020 (maps, scopes, session policy). Current behavior is described in [architecture](../architecture.md); this proposal does not pass any [roadmap](../production-roadmap.md) gate. Installer packaging is outside this feature.

Before implementation, confirm the catalog-first source choice and record the new prepared-start/provider-routing semantics, including compatibility behavior. No broader architecture decision is needed to write or review this report.

## Acceptance criteria and evidence

Start with red end-to-end tests, then implement against these observable outcomes:

- Choose between at least two catalog workflows and supply different JSON input. The started run persists the exact reviewed definition, prompt contents, input, and execution mode.
- Invalid YAML/input, missing prompts, disallowed paths, and unsupported providers show actionable errors and start no run. Editing after preview requires validation again. A source change cannot silently alter the reviewed run.
- Repeated clicks and a lost start response resolve to one submitted run identity. Reloading or browsing history creates no run; resuming a waiting run does not create a replacement.
- A simulation runs on a real Temporal test service with zero real-provider launches. The parallel-review example repeats until both branches succeed in the same iteration, then starts the downstream agent once. Include human-gate and exhaustion paths with truthful badges/outcomes.
- Provider-routing tests use deterministic fake provider executables through the actual adapter boundary to prove declared providers are honored, nested/map dispatch is correct, and simulation explicitly overrides them. These tests prove routing and durability, not a live provider run.
- Existing human/recovery controls work from the newly started run, including nested qualified IDs. New-run-from-history requires review and has independent identity and session state.
- A live-provider qualification, if performed separately with configured credentials and an authorized workflow, records its real run ID and accepted artifacts. Report simulation, adapter tests, and actual provider evidence separately; never call the feature live-verified solely from mocks or fixtures.

Later additions can include YAML/dependency uploads, Build draft handoff, richer catalog management, saved input presets, and additional execution providers. They are not prerequisites for choosing a known workflow and starting a reviewed simulated or declared-provider run.
