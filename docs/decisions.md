# Steward architecture decision register

Status: adopted design decisions; implementation remains subject to the [release gates](production-roadmap.md). Date: 2026-09-05. Decision owner: repository maintainer.

This register records choices made for the production direction. It does not assert that the choices are implemented. Keep identifiers stable. Supersede a decision with a new numbered record that links back, states the migration, and explains the evidence for changing it. Do not silently rewrite an adopted decision into its opposite.

| ID | Decision | First delivery |
|---|---|---|
| ADR-001 | CLI first, one package, shared application service | Developer preview |
| ADR-002 | YAML compiles into an immutable, versioned execution contract | Developer preview foundation |
| ADR-003 | Temporal owns execution; typed evidence owns accepted output | Hardening |
| ADR-004 | Transactional evidence and immutable artifacts, with explicit deployment tiers | Local first; shared production later |
| ADR-005 | At-least-once execution, fenced acceptance, durable operator commands | Hardening |
| ADR-006 | Policy-bound executors and read-only initial agent work | All releases |
| ADR-007 | Versioned interpreter migration with bounded histories | V3 foundation |
| ADR-008 | Production is an evidence gate, not a feature milestone | All releases |
| ADR-009 | Explicit module ownership and inward dependencies | Architecture definition; P1 enforcement |
| ADR-010 | One repository with CLI, server, and UI template boundaries | Current component extraction; broader control services remain planned |
| ADR-011 | V1 file prompts resolve into immutable assignment text before start | Current loader extension |
| ADR-012 | Local macOS bootstrap and detached example supervisor | Current one-click setup |

## ADR-001 — CLI first with one control service

**Context.** The current starter, demo supervisor, and dashboard duplicate lifecycle responsibilities. A terminal client should not have to keep a browser or child runtime alive.

**Decision.** Keep TypeScript and a single distributable package with internal domain, compiler, control, runtime, executor, store, CLI, TUI, and web boundaries. Use Commander for command parsing and Ink for terminal presentation as already proposed. Make `ControlPlane` the shared application service. The dashboard is optional and read-only by default. Runtime services have an independent supervisor and explicit profiles.

**Alternatives.** A browser-first product makes the CLI secondary; HTTP-only local control adds an unnecessary service dependency; microservices multiply deployment and version coordination before there is a demonstrated need.

**Consequences.** Adapters stay thin and consume the same snapshots/commands. Packaging and detach/reattach are release requirements. Separate worker processes are allowed without splitting the repository into services. Revisit a package split when independent release ownership or measured deployment constraints justify it.

## ADR-002 — Immutable compiled intent

**Context.** Current YAML parsing does not fully validate initial input or reference relationships. Its hash is sensitive to parsed object ordering. The existing proposal also mixes source provenance with semantic plan identity.

**Decision.** Compile outside Temporal. Publish versioned schema, diagnostics, plan, command, event, and result contracts. Separate exact source bytes, canonical semantic plan, input, and run binding hashes. Exclude self-hash and source/compiler provenance fields from the semantic hash payload. Resolve defaults and executor bindings before start. Keep V1 support; reject unsupported V2 constructs explicitly.

**Alternatives.** Interpreting YAML inside a Workflow introduces mutable parsing dependencies. Generating workflow code per YAML file multiplies replay and deployment variants. Hashing raw YAML conflates formatting with execution behavior.

**Consequences.** Formatting-only edits can preserve the semantic plan hash while changing source provenance. The compiler needs golden fixtures and a declared canonicalization algorithm. Plans contain no machine paths or credential values. New execution semantics require contract versioning or an explicitly documented compatible extension.

## ADR-003 — Separate execution authority, evidence, and presentation

**Context.** Temporal schedules work; files support inspection. The current human-input path does not use the agent completion artifact contract, and disk snapshots can disagree with Temporal.

**Decision.** Temporal alone advances the graph. A common commit service validates and durably records outputs for agent steps, human steps, loop/block results, and the final run result. The Workflow accepts a commit descriptor before releasing dependents. `RunStore` snapshots are projections. A result is reportable as successful only when Temporal completion and the final manifest agree.

**Alternatives.** Treating `state.json`, callbacks, terminal text, or process exit as completion creates competing authorities. Storing all result content in Temporal makes evidence expensive to inspect and increases history payloads.

**Consequences.** Snapshots expose lifecycle, evidence integrity, and freshness separately. Hashes detect corruption but do not authenticate a malicious writer; access controls and trusted commit writers establish that boundary. The control plane never synthesizes a missing domain output. Revisit transport/storage implementation without weakening this invariant.

## ADR-004 — Transactional evidence with two deployment tiers

**Context.** Process-local locks cannot sequence multiple worker processes. Two copies on one disk do not protect against host loss.

**Decision.** Introduce `EvidenceStore`, `ArtifactStore`, and projected `RunStore` interfaces. The local profile uses an application-owned SQLite database and immutable filesystem artifacts on one host, separate from Temporal's database. The production team profile uses PostgreSQL for evidence/commands and an S3-compatible object store with conditional create, encryption, version retention, and tested replication/restore. Select Temporal Cloud as the default production orchestration service; a supported self-hosted production cluster is an alternative for a concrete deployment constraint.

**Alternatives.** Shared JSONL retains concurrency races. SQLite on a network share is unsuitable for the chosen WAL model. Starting with PostgreSQL as a mandatory local dependency burdens the developer experience; keeping local disk in production cannot meet the intended host-loss boundary.

**Consequences.** Transactional command, dispatch, and accepted-commit records are durable evidence, not disposable projections. Filesystem JSON exports remain inspectable. No transaction spans Temporal, SQL, and object storage: use immutable objects, compare-and-set acceptance, and reconciliation. SQLite WAL requires processes on the same host. [SQLite WAL documentation](https://www.sqlite.org/wal.html)

The external stores are a target architecture, not an authorization to provision paid infrastructure. Revisit specific vendors after a deployment region, retention policy, operational owner, and cost envelope are selected.

## ADR-005 — Fenced acceptance instead of exactly-once provider claims

**Context.** An Activity can retry after provider work but before receipt acknowledgement. Old receipt paths currently collide with a fresh recovery cycle. A timed-out process may still be alive.

**Decision.** Give each logical step iteration, recovery dispatch, and process attempt separate identities. Isolate attempt workspaces, retain immutable evidence per dispatch, and use an acceptance compare-and-set guarded by a fencing epoch. Deduplicate start, answer, recovery, and cancellation commands across uncertain responses. Return an existing accepted result without reinvoking its provider.

**Alternatives.** Disabling retries loses recoverability. Trusting provider session IDs as an exactly-once mechanism overstates their guarantee. Deleting old evidence to enable fresh recovery loses the audit trail.

**Consequences.** Provider invocation and billing may repeat before acceptance. Late or superseded attempts cannot overwrite accepted output. Fresh-session recovery does not repair corrupted evidence automatically; it records a new authorized dispatch while preserving the damaged evidence. Write-capable executors later need their own idempotency or reconciliation protocol. Revisit stronger execution guarantees only when the provider can enforce them.

## ADR-006 — Operator policy bounds executor capabilities

**Context.** Read-only Codex launches are a useful existing boundary, but inherited environment, session files, network access, and provider credentials require explicit handling.

**Decision.** Ship built-in simulated and Codex executors first. The effective capability set is the intersection of workflow request, executor capability, and operator policy. Preserve read-only domain work initially. Resolve credentials in the execution environment; exclude credential values from Workflow payloads, command arguments, plans, and exported artifacts. Validate the active sandbox and network policy before dispatch.

**Alternatives.** Letting YAML grant authority makes untrusted input a permission system. Loading arbitrary third-party executor code by default expands the trust boundary before it can be enforced.

**Consequences.** Reject capabilities the adapter cannot enforce. Treat model output as data. Redact readable messages before persistence, restrict raw operational logs, and test leakage using synthetic secrets. A provider still receives the task content needed for its job; the run manifest records the selected provider/data destination. New external effects require a separate capability decision, permission model, and failure contract.

## ADR-007 — Versioned runtime migration and bounded history

**Context.** Wave scheduling can stall independent progress. Existing histories depend on the current Workflow and Activity behavior. Large definitions and outputs are repeatedly carried in history.

**Decision.** Keep V1/V2 replayable; introduce `yamlflowInterpreterV3` for the new plan and eager dependency scheduling. Freeze legacy helper/Activity contracts, export representative histories, and replay them against each candidate bundle. Separate the V3 DAG foundation from later nested group/parallel/loop syntax. Store bulk inputs/outputs as immutable references and continue execution in a new Temporal run at a safe drained boundary when history approaches its budget.

**Alternatives.** An in-place scheduler rewrite can break open histories. A single large language rewrite delays correctness work. Raising server history limits only postpones unbounded growth.

**Consequences.** Retain old worker bundles and compatible activity implementations while old work or the supported reset window needs them. Application run identity survives continuation; receipt provenance retains the original Temporal execution identity. Drain active message handlers before continuation; Temporal continuation creates a fresh Run ID in the same Workflow ID chain. [Temporal versioning](https://docs.temporal.io/develop/typescript/workflows/versioning), [Continue-As-New](https://docs.temporal.io/develop/typescript/workflows/continue-as-new)

## ADR-008 — Release by evidence and declared operating envelope

**Context.** Passing unit tests demonstrates selected behavior; it does not establish replay compatibility, shared-store safety, or host-loss recovery.

**Decision.** Release in gated vertical slices. Each release records package/bundle hashes, schema and migration versions, test commands and exit codes, run/execution IDs, artifact hashes, and observed recovery results. Separate developer preview qualification from production qualification. Keep runtime databases and run artifacts through upgrades unless an operator explicitly requests deletion.

**Alternatives.** Declaring production after completing a feature checklist hides durability gaps. A rewrite without a compatibility gate risks losing the strongest part of the existing system.

**Consequences.** A failed integrity, replay, permission, duplicate-start, or restore gate blocks promotion regardless of UI completeness. Use a named release owner and rollback procedure. New durability claims require new fault evidence. The [roadmap](production-roadmap.md) is the acceptance contract.

## ADR-009 — Explicit module ownership and inward dependencies

**Context.** The existing flat modules combine SDK lifecycle, provider protocol, output acceptance and storage. The browser also evaluates loop predicates independently of the interpreter. A target directory list alone does not establish who may make each decision.

**Decision.** Adopt the [software architecture responsibility map](software-architecture.md). Separate deterministic graph decisions, one-attempt execution, provider protocol, semantic output acceptance, and persistence. Keep application services dependent on typed ports, with concrete adapters wired by bootstrap. Share command-ledger rules between control and command Activities, and presentation view models between TUI and web. Only the interpreter evaluates execution predicates; only CommitService selects an accepted output.

**Alternatives.** A single runtime service preserves broad coupling. Moving the existing files into folders without extracting ownership leaves the same problem. Separate network services add operational coordination without improving these code boundaries.

**Consequences.** Remain one package with independently supervised process roles. Add import/contract checks as new modules arrive. Treat per-run scheduling reservations and transactional executor quota leases as separate authorities with explicit compensation. Preserve legacy helpers and histories while new modules are introduced through the roadmap's vertical slices. This refines ADR-001 through ADR-007 without changing their execution or durability promises. Revisit a boundary when a concrete change cannot be owned without a cycle or duplicated rule.

## ADR-010 — One repository with CLI, server, and UI template boundaries

**Context.** The user needs recognizable Steward CLI, Steward Server, and Steward Console components in one repository, plus selectable UI layouts and themes. The original entrypoints executed on import and mixed the browser shell with shared interaction code. Separating these concerns must preserve current npm commands and supported Temporal histories.

**Decision.** Keep one package. Put CLI commands and the current local launcher in `src/cli/`, HTTP composition and UI asset/template serving in `src/server/`, and browser templates/assets in `ui/`. Root entrypoints invoke exported `main` functions for compatibility; importing component modules must not start processes or submit commands. Keep the Temporal worker as a distinct process and leave legacy Workflow/Activity exports and shared runtime behavior in place during this slice. The CLI continues to call the common Temporal client directly; making HTTP mandatory is not part of this change.

Compose the UI from a shell and allowlisted component fragments, with module-relative asset resolution. Keep one browser graph/event/action implementation. Board/Review layouts and Dark/Light/System themes change presentation and retain browser preferences without reloading or replacing an in-progress form. Appearance code may suppress a shortcut while the user types or a request is pending; it may not schedule workflow work or define execution success. The known legacy browser loop-predicate duplication still needs the ADR-009 presentation extraction.

**Alternatives.** Separate packages/services introduce independent release and deployment coordination before it is needed. Duplicating application JavaScript per template allows action and status behavior to diverge. A GitHub starter-template repository addresses a different need; the requested templates here are UI layouts, themes, and composition fragments.

**Consequences.** This refines ADR-001 and ADR-009 without superseding execution semantics, public command payloads, storage authority, or durability promises. The current direct client/store calls and local launcher remain transitional code; their extraction does not claim that the target application services or runtime profiles exist. Preserve the launcher runtime-path limitation until a dedicated configuration change addresses it. Validate import behavior, template contracts, asset lookup, typing safety, live UI state, and existing recovery behavior. Release qualification still follows ADR-008.

**Approved display identity.** The product name is Steward. Its components are Steward CLI, Steward Server, and Steward Console; Console denotes the browser UI. Display branding is isolated in `ui/brand.json`. Repository relocation and publication are in progress and require their own completion evidence.

This naming decision retains existing execution identities: `YAMLFLOW_*` settings, `yamlflow-<runId>` workflow IDs, the `yamlflow-agent-nodes` task queue, `yamlAgentWorkflow`/`yamlAgentWorkflowV2` workflow types, schema names, and persisted run data remain unchanged. Older design proposals also retain lowercase `yamlflow` command/schema identifiers until a separately reviewed contract change adopts different spellings. Branding does not authorize rewriting historical provenance or altering replay behavior.

## ADR-011 — File prompts are resolved before workflow start

**Context.** Authors need to keep long agent assignments in separate files while retaining existing inline V1 workflows. Reading a mutable prompt during an Activity retry would change the assignment and receipt identity.

**Decision.** Extend V1 agent nodes with `prompt_file`, mutually exclusive with `prompt`. This explicitly compatible extension refines ADR-002's source-loading contract and supersedes the inline-only authoring requirement. Existing inline semantics and hashes remain unchanged. Human nodes keep `question` and reject `prompt_file`.

`loadWorkflow` owns filesystem I/O, resolving relative paths against the YAML directory and accepting explicit absolute paths. It reads each resolved path once per load and supplies UTF-8 content as values to the pure parser/compiler. `parseWorkflow(source, sourcePath, promptFiles)` accepts an optional read-only map keyed by the author's literal file references; absent contents produce an actionable error without disk access. These remain the transitional source-loading/compiler functions in `src/definition.ts` under ADR-009.

Compile the loaded text into the existing node `prompt` and add optional `promptSource: { path, sha256 }` provenance. Bind loaded text into the definition hash only for file-backed definitions, preserving legacy inline-only hashes. The current hash remains sensitive to declared file paths and parsed source ordering; this is not the full canonical semantic hash design planned by ADR-002. Exact UTF-8 text is preserved, including line endings and BOM, before the existing worker envelope trims assignment boundaries.

**Execution.** CLI and server already call the common loader before Temporal start. Temporal receives the resolved definition; existing definition projections and Activity inputs carry the snapshot. Retries, loops, and recovery use that content without consulting prompt files. A fresh start reloads files. This changes no Workflow command sequence, Activity API, receipt contract, or runtime history migration requirement. File content has the same literal semantics as inline content; variables remain in `inputs`.

**Validation and boundaries.** Require one non-empty source per agent; reject conflicting fields, invalid paths, read/UTF-8 errors, and empty contents before start. References are literal local paths, with the same host filesystem access as other source loading; no URL retrieval, environment interpolation, include expansion, or new executor capability is added. The current operator-trusted loader is not a filesystem sandbox. Loading multiple distinct files does not promise an atomic filesystem-wide snapshot.

**Alternatives.** A structured prompt union or named registry adds authoring complexity without a current reuse requirement. Custom YAML tags tie tools to a custom loader. Reading at dispatch or retry weakens reproducibility.

**Evidence.** See [file prompt validation](validation/prompt-file.md) for compatibility, error, snapshot, and runtime checks. Production qualification still follows ADR-008.


## ADR-012 — Local bootstrap and detached example supervisor

**Context.** An operator should be able to open the bundled examples without manually installing Node/Temporal or keeping the setup terminal open. A dashboard listening on a port is not evidence that a worker can execute work.

**Decision.** Refine ADR-001/ADR-010 for the current local demo: `Setup Steward.command` invokes a repository-owned shell bootstrap, and `src/cli/setup.ts` owns example selection and readiness. On macOS the bootstrap may install missing prerequisites through the official Homebrew installer and `brew install node@22 temporal`; Homebrew retains its own administrator/confirmation flow. It does not install Codex credentials, configure ZeroTier, open firewall ports, or provision paid infrastructure. Linux uses preinstalled prerequisites.

This supersedes the foreground-only launcher requirement for the one-click entrypoint: it starts the existing supervisor detached, with append-only local service logs. The manual launcher keeps its signal/shutdown behavior. Closing setup's terminal leaves its supervisor running; reboot stops it. Setup prints the supervisor PID. SIGTERM stops that supervisor and its owned children; it does not stop reused services. This is a local convenience, not the target independently installed system supervisor or a reboot-persistent service.

Validate every catalog definition, demo-output schema, prompt file, and external input binding before service dispatch. Probe Temporal workflow/activity pollers and the dashboard health identity, rather than declaring readiness from an open TCP port. Check same-host poller PIDs to reject recent registrations left by exited workers. Reuse ready services; the existing fixed task queue and local-path assumptions remain and are not suitable for multiple unrelated checkouts sharing a server.

A fresh workspace starts the question example in simulated mode. Repeated setup reconnects; named example launchers explicitly request a new run. Serialize setup and dependency installation. Record submission intent before the Temporal call and refuse an implicit retry after an uncertain response. This is not general durable start deduplication: the record is not completion evidence, and explicit `--new-run` requests may create another run. Temporal and committed outputs retain their existing authority under ADR-003/ADR-005.

**Consequences.** Keep the database and all run artifacts across installation/restart. The selected example is submitted through the existing validated loader and Temporal client; a reused dashboard retains its existing Run-again configuration. One-click setup only supports the repository-local runtime/address and rejects custom runtime overrides. New simulated examples still require human answers at their declared gates. No Workflow/Activity scheduling semantics or replay contracts change. Clean-machine prerequisite installation and signed distribution remain separate release evidence; this change does not pass P2 on its own.
