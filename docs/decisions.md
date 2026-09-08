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
| ADR-013 | Agent-assisted V1 authoring is validated preview data, not execution authority | Current Console builder |
| ADR-014 | Draft export requires an explicit browser download gesture | Current Console builder |
| ADR-015 | Explicit bounded array fan-out | Current runtime |
| ADR-016 | Pre-adoption runtime has one current interpreter and no compatibility shims | Current runtime |
| ADR-017 | Repeat archive installation updates source and restarts owned services | Current installer correction |
| ADR-018 | Portable V1 authoring skill and offline loader validation | Current authoring distribution |
| ADR-019 | Composable executable scopes and bounded repeat | Early P4 language slice |
| ADR-020 | Explicit provider session continuity within repeated scopes | Scope execution option |
| ADR-021 | Version-aware authoring skill updates with retained backups | Installer behavior |

## ADR-018 — Portable V1 authoring skill

**Context.** Authors want to describe workflows to their own agent and receive usable YAML without requiring the Console authoring endpoint.

**Decision.** Distribute `skills/steward-workflow` with the implemented V1 schema guide and example YAML/input pairs. Add `npm run skill:install` for Codex, `--agent claude`, and an explicit `--dest` skills directory for other agents. The installer copies the bundled skill and refuses existing destinations. Add `npm run validate:workflow -- workflow.yaml [input.json]` as an offline adapter over `loadWorkflow`, `loadInitialInput`, and initial-input resolution. It does not import lifecycle, provider, or Temporal clients.

The explicitly requested local authoring operation may write YAML, prompt files, and example input to the user's workspace. This extends the authoring delivery surface under ADR-013; its Console-specific no-write subprocess boundary remains unchanged. Neither skill installation nor validation starts a workflow, installs providers, or modifies execution permissions. Any agent can author; supported execution providers remain unchanged.

**Consequences.** Packaging/scripts own installation; spec/compiler remains owned by `src/definition.ts` under ADR-009. The guide describes current behavior rather than creating another normative schema or changing V1 semantics. Parser acceptance is reported separately from exhaustive reference validation, which remains future work. This delivers a V1 authoring aid early; it does not pass the P4 nested-language or P2 distribution gates. Tests exercise bundled examples, validation failures, portable installation, and overwrite refusal.

The standard setup path (including archive installation) invokes the skill installer with `--if-missing`. It installs for Codex by default; `STEWARD_SKILL_AGENT` selects `codex`, `claude`, `both`, or `none`. Repeat setup preserves existing skills and their customizations with an explicit refresh message. Standalone installation retains overwrite refusal. This extends ADR-012's bootstrap contents without changing runtime authority.

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


**ADR-012 archive entrypoint refinement (2026-09-06).** `install.sh` provides a
Git-free download path: fetch the GitHub source archive over HTTPS, stage it beside
`~/Applications/Steward`, and invoke the same setup script. A download lock
serializes installers; unrelated destinations are refused. The `.steward-install`
marker identifies an installer-created directory, not execution evidence. Repeat
invocations reuse it without upgrading source or touching runtime data. The
installer forwards setup options and reconnects interactive prerequisite prompts
to the terminal when launched through a pipe. `STEWARD_INSTALL_DIR` and
`STEWARD_REF` allow an explicit destination and source revision. This extends the
installation entrypoint only; runtime authority, local-only binding, credentials,
and the reboot boundary remain unchanged.

## ADR-013 — Agent-assisted authoring stays outside execution authority

**Context.** Authors need to describe a workflow conversationally, see its topology immediately, and refine it without manually translating every dependency into YAML. Letting model output bypass the existing loader or start a run would turn presentation text into execution authority. Adding Claude Code for authoring also expands the local provider boundary beyond the current simulated/Codex execution providers.

**Decision.** Add a Build workspace to Steward Console with chat on the left and the shared SVG topology on the right. A loopback Steward Server endpoint accepts a bounded message, up to twelve bounded browser-session history messages, an optional current draft, and an explicit authoring provider (`codex` or `claude`). The provider must return `{reply, workflow_yaml}` through a structured-output schema. Steward runs `workflow_yaml` through the existing V1 `parseWorkflow` implementation and permits one bounded repair pass using the parser diagnostic. Only a parser-accepted definition is returned to the browser or rendered.

Authoring providers run as local subprocesses with non-interactive, no-write permission settings and a two-minute timeout. They receive the V1 authoring contract as data and cannot extend it. Generated drafts use inline prompts only. The authoring endpoint rejects browser origins outside the same loopback Console. Chat and YAML remain browser-session preview data: no files are written, no durable command is recorded, and no Temporal Workflow is started. A preview uses synthetic pending presentation state and must never be reported as a run.

**Consequences.** This implements the authoring experience anticipated by the vision while preserving ADR-002, ADR-003, ADR-006, ADR-009, and ADR-010. Codex and Claude Code authentication remains owned by their installed local CLIs; absence or failure is explicit. The current loopback endpoint still lacks the target local session credential and therefore does not pass the P2 control-security gate. Persisting drafts, editing YAML directly, generating example input, and starting a generated draft require later explicit commands and contracts rather than being inferred from chat.

## ADR-014 — Draft export is an explicit browser download

**Context.** ADR-013 keeps generated YAML in browser-session preview state and forbids implicit persistence. Authors still need to take ownership of parser-accepted YAML without copying it from the conversation or granting the builder repository filesystem access.

**Decision.** Supersede only ADR-013's blanket no-file-write wording for an explicit Export YAML browser action. Keep export disabled until the existing parser accepts a draft. On a user click, download the exact accepted YAML bytes through the browser with a portable filename derived from the workflow name. Do not add a server write endpoint, choose a repository path, start a run, or export an invalid/in-flight response.

**Consequences.** The browser and operator own the download destination and confirmation behavior. Exported YAML is an author-controlled source file, not durable execution evidence or proof that a run started. Draft chat and YAML remain session-only until the explicit gesture, and later save/start commands still require separate contracts and authorization.

## ADR-015 — Explicit bounded array fan-out in V1

**Status.** Its fan-out semantics remain adopted; its compatibility strategy is superseded by ADR-016.

**Context.** Authors can already declare array-valued outputs, but turning an array into one agent invocation per item requires manually authored static nodes. Inferring fan-out from any array binding would make provider count and graph expansion implicit. The requested use case is a source-ordered queue with an explicit maximum number of simultaneous agents.

**Decision.** Extend V1 agent nodes with `for_each: { items, as, max_parallelism }`. `items` is one `$input` or declared dependency-output array reference, `as` is the resolved-input key for one item, and `max_parallelism` is a positive node-local cap that defaults to the workflow cap. The interpreter expands the array only after dependencies commit, drains source-ordered work while enforcing the workflow, group, and node-local caps together, and aggregates per-item object outputs in source order. An empty array commits `[]` without provider execution. `for_each` is unavailable on human nodes and cannot be combined with `loop`.

Each item uses its one-based source position as the existing execution iteration identity, with an item-specific provider session, recovery request, receipt, and artifact directory. Per-item completion is evidence, but the mapped node releases dependents only after every item succeeds and the interpreter records the ordered aggregate. A failed item fails the mapped node after already committed siblings finish; accepted siblings remain recoverable evidence.

This is an explicitly documented compatible extension under ADR-002, not the nested V2 language proposed in the CLI specification. Existing definitions have no `for_each`, retain their definition hashes, and follow the unchanged Workflow command path. New definitions use the distinct `yamlAgentWorkflowV2ForEach` type so a stale worker that knows only ordinary V2 semantics cannot accept and misinterpret them. The legacy `yamlAgentWorkflow` and ordinary `yamlAgentWorkflowV2` identities remain available for old histories. The richer compiled-plan map/foreach design remains future work.

**Consequences.** Add `boolean[]` and `object[]` to the existing output shorthand so practical task arrays can be declared. The current runtime still embeds expanded item values and aggregate outputs in Temporal history and remains subject to the local durability and history-size gaps in this document. Validation must cover source typing, declared dependency edges, cap composition, stable result ordering, empty arrays, item failure/recovery, and unchanged non-`for_each` behavior before making a broader release claim. Current bounded evidence and its explicit gaps are recorded in [the queued fan-out validation note](validation/queued-fan-out-2026-09-07.md).

## ADR-016 — One pre-adoption interpreter without compatibility shims

**Context.** Steward has not been adopted externally, so retaining three Workflow type names, two Activity input types, and scheduler compatibility branches adds maintenance and replay constraints without protecting a supported consumer. The repository maintainer explicitly chose a clean replacement before adoption.

**Decision.** The current authored contract remains `version: 1`, but all definitions execute through one Temporal Workflow type, `stewardWorkflow`, one `AgentExecutionInput`, one `executeAgent` Activity, and one rolling scheduler for ordinary and `for_each` work. Remove `yamlAgentWorkflow`, `yamlAgentWorkflowV2`, `yamlAgentWorkflowV2ForEach`, their wrappers, and the ordinary-node compatibility branch. Persisted databases, run directories, and historical provenance remain untouched, but executions started under removed Workflow types are no longer supported or replayable by the current worker. The new type name also prevents an older worker bundle from accepting new work.

This supersedes the compatibility and retained-interpreter portions of ADR-002, ADR-007, ADR-009, ADR-010, and ADR-015. Their language validation, durability, evidence, ownership, and bounded-history requirements remain in force. Once Steward is adopted, incompatible changes require a versioned migration decision and replay evidence.

**Consequences.** Current code and tests have one execution path. Operators may inspect preserved artifacts from pre-adoption runs, but must not present an open removed-type execution as resumable. Rollback means running a matching historical bundle against preserved state, not adding compatibility shims back to the current bundle or deleting runtime data.


## ADR-017 — Repeat archive installation updates source

**Context.** Pointing the public command to `main` only fixed fresh installs.
ADR-012's repeat-install reuse rule left existing users running old source.

**Decision.** Supersede that rule for `install.sh`: every invocation downloads
`main` by default (or the explicit `STEWARD_REF`), validates the staged archive,
and updates installer-owned source. The bootstrap lifecycle helper
`scripts/update-install.mjs` stops only recognized Steward services whose working
directory matches the installation, then replaces source and invokes the normal
setup path. Direct setup clicks retain their reconnect-only behavior.

Source paths are tracked in `.steward-source-files`; updates remove upstream-deleted
managed paths. For legacy installs, incoming source directories are replaced but
unknown top-level files remain. Preserve runtime databases, runs, outputs, local
environment files, and unrelated top-level files. Keep the previous source in a
sibling backup, restore it on a caught replacement error, and fail on conflicting
setup locks or services that do not stop. The installer lock spans setup; updated
lockfiles require locked dependency installation rather than `npm ls` acceptance.

**Consequences.** Updates interrupt this installation's active processes. They do
not cancel workflows, manufacture outputs, migrate histories, or establish replay
compatibility beyond ADR-016. Source edits are replaced and retained in the backup.
A crash during replacement may require restoring that backup; this is not an
atomic multi-file upgrade. A failed post-update setup leaves the new source and
backup available and reports failure. No other workspace's services are stopped.
Ownership remains bootstrap/lifecycle under ADR-009 and ADR-012; runtime scheduling
and committed evidence remain with their existing owners.

**Evidence.** Installer tests exercise A-to-B replacement, deleted source, legacy
markers, failed downloads, saved data, and real process shutdown scoped to a
workspace. The isolated macOS CI also repeats installation at the candidate SHA
and rechecks Temporal completion and output receipts after restart.


## ADR-019 — Composable executable scopes and bounded repeat

**Context.** The maintainer approved grouping several nodes into a repeated graph, including review → a nested parallel group → repeat until both agents succeed in the same iteration → next agent. Single-agent loops and named concurrency groups cannot express that behavior. The requested delivery starts with failing real-Temporal end-to-end tests, followed by implementation.

**Decision.** Extend authored `version: 1` with `kind: scope`: local `inputs`, a nested acyclic `nodes` graph, and `outputs` export bindings. A scope is externally one dependency-producing node. Removing its `loop` runs the same graph once. Existing `groups` keep their concurrency meaning. `depends_on` aliases `needs`; declaring both is rejected.

Scope repeat executes at least once, requires an explicit iteration bound (1–20), commits all children and exported output, then evaluates `until`. `initial` establishes state from scope inputs; `next` replaces that state from `$input`, `$state`, and the current exported `$output`, preserving declared state keys. Children resolve `$nodes` only within their scope and `$input` from explicit scope inputs. A non-loop scope inherits enclosing state; an inner loop owns independent state. A composite predicate uses nonempty `all`/`any` lists or `not`; invalid operands fail explicitly. False repeats the entire graph. Exhaustion fails unless the author explicitly selects `accept_last`.

Qualified execution IDs encode the entire enclosing iteration path (`resolve~2.parallel_work~1.validation`). Each iteration keeps its own committed evidence and human/recovery identities. Scope execution holds no provider permit; leaf work shares existing concurrency admission. Nesting is bounded to eight levels and dynamic scope expansion to 1000 step instances. Simulation fixtures for a leaf without its own loop follow the nearest enclosing repeat iteration, without changing receipt identity or provider-attempt semantics.

The compiler owns scope/reference validation and export schemas, the Temporal interpreter owns readiness and predicates, and Activities own export artifact commits. Console formats interpreter outcomes (`condition_met`, `exhausted_accepted`, `exhausted_failed`); absent outcomes are unknown. Top-level graphs show scopes as composable nodes; their inspectors expose nested execution instances and the same human/recovery controls. Authoring remains parser-gated preview under ADR-013.

**Compatibility and sequencing.** This refines ADR-002/003/009/018 and supersedes the P4-only deferral of executable nested scopes. The maintainer explicitly authorized this bounded P4 slice now; it does not qualify the remaining P1–P4 gates. Keep the single interpreter required by ADR-016, preserve current supported histories with replay-safe changes, and preserve existing V1 definitions and runtime data. Removed pre-adoption Workflow types remain outside the supported set. No change to execution permissions, storage authority, provider guarantees, or same-host durability is adopted.

**Evidence.** [Initial red end-to-end evidence](validation/scope-loops-red-2026-09-07.md) records the pre-implementation failures. Implementation validation must separately record Temporal closure, committed artifacts, restart behavior, boundary failures, existing-language regression checks, and presentation checks. This decision is not itself evidence that those gates passed.


## ADR-020 — Explicit provider session continuity within repeated scopes

**Context.** Repeated scopes currently start new leaf invocations each iteration. An author may want each agent to continue its previous provider conversation while still receiving the next iteration's explicit inputs. Sharing one conversation among parallel agents or relying on a worker's unbound session string would violate task isolation and recovery expectations.

**Decision.** Add `scope.loop.agent_sessions: fresh | resume`, defaulting to fresh. Preserve absent fields and the existing default execution path. Resume creates an interpreter-owned affinity map for one repeated-scope activation, keyed by descendant leaf path and mapped source position. Loop-free scopes propagate that owner. A nested repeated scope owns an independent policy and map, defaulting to fresh; a new outer activation creates a new inner map. A leaf's own loop and retry semantics remain unchanged.

Only accepted Activity results update affinity. The descriptor binds actual provider, canonical workspace, and observed session ID in hash-bound receipts, Activity results, heartbeat checkpoints, and recovery metadata. Provider and canonical-workspace identity must match before spawning a resumed process. Canonicalization belongs in the Activity, never in Workflow code. Changed inputs do not invalidate session reuse: `loop.next` and explicit input bindings continue to govern data flow; the conversation is supplementary context, not accepted workflow output.

The first encounter or absence of a recorded session ID starts fresh and emits an explicit `node.session` event with `action: fresh` and `reason: no_recorded_session`. A valid reuse emits `action: resume`. Resume failure follows existing operator recovery rather than silently falling back. Successful explicit fresh-session recovery replaces future affinity. Provider/workspace mismatch is an integrity failure that cannot be repaired by retrying the same bound session.

**Consequences.** This refines ADR-019's iteration execution semantics and ADR-005's session-bound recovery without changing output acceptance, fan-in, permissions, or the default fresh behavior. Map positions are affinity identities; reordering data changes which item occupies that identity. Local provider session availability is required; this adds no cross-workspace or machine portability guarantee. Simulation or controlled adapter tests do not establish live provider reliability.

**Evidence.** [Initial session-policy red evidence](validation/scope-sessions-red-2026-09-07.md) precedes implementation. Record adapter invocation, accepted session metadata, changed inputs, sibling/nested isolation, missing-ID fallback, recovery/restart, mismatches, and existing-history replay separately before claiming qualification.


## ADR-021 — Version-aware authoring skill updates with retained backups

**Context.** Reinstalling Steward updated source while ADR-018's `--if-missing` setup policy left installed authoring skills stale, hiding newly supported scopes and session options.

**Decision.** Packaging/scripts own a bundled `skill-version.json` with exactly `name: "steward-workflow"` and a positive safe-integer `version`. Start at 1 and increment for future skill changes; this is separate from workflow language and npm versions. Setup (and therefore archive install) invokes `--update`. It installs missing skills, replaces lower versions, and preserves same/newer versions. A recognizable unversioned SKILL.md frontmatter name is legacy version 0, including customized copies. Unknown legacy directories remain untouched with an explicit message. Present malformed metadata fails closed. Plain install retains overwrite refusal and `--if-missing` remains install-only; those flags cannot be combined with `--update`.

An installation lock serializes this skill's operations. Reject symlink/non-directory destinations. Copy and validate the incoming skill into a private staging directory first. Move an older entire directory to a unique hidden backup wrapper beside the destination, then publish the staged directory by rename. Retain and print the backup (including customizations). A caught publication failure restores the previous directory. Do not merge user edits into the new release or silently downgrade.

**Consequences.** This supersedes ADR-018's repeat-setup preservation rule only for older recognizable skills. No dependencies, providers, credentials, execution authority or runtime data change. The rename publication is atomic, but swapping two directories is not a crash-atomic transaction: an interruption between renames may leave the old copy in the retained backup and the install lock in place. Operators confirm the installer stopped, restore the printed/adjacent backup when necessary, then remove the lock. Existing agent turns may retain loaded instructions; updated skills become available on a subsequent turn. Tests cover the executable setup path as well as helper behavior; this does not establish broader production distribution readiness.

## ADR-022 — Mandatory repository binding and workspace writes

**Outcome.** Developers can run coding and build/test workflows in an explicitly selected repository instead of launching every worker read-only in Steward's own checkout. The maintainer requested a mandatory working directory and red-first end-to-end implementation.

**Decision.** Supersede ADR-006's initial read-only restriction for new runs. Require `--working-directory` on CLI starts and `workingDirectory` on HTTP/client starts, including simulation. Resolve to an existing canonical directory before connecting to Temporal. Persist `{workingDirectory, sandbox: "workspace-write"}` in Workflow input, `execution.json`, projected state, and hashed agent completion receipts. Bind all nodes, fresh sessions, and retries to that directory. Validate the recorded path before new provider dispatch; a retargeted input symlink cannot redirect an existing run. The operator may choose a common parent directory for a multi-repository workflow. A Git checkout is not required.

The start client and `repository-workspace.ts` own input/path validation, the interpreter forwards the immutable binding, the Activity/executor owns subprocess cwd and sandbox enforcement, and the existing receipt owner binds completion evidence. No filesystem access is added to Workflow code. Authoring chat stays read-only. YAML and prompts cannot select permission overrides. CLI/Console starts supply the directory; setup without one opens the Console without auto-starting a first run, while explicit new-run setup requires it.

Writable HTTP starts require JSON content, a loopback Host matching the listening port, and a matching Origin when supplied. Local CLI clients may omit Origin. This prevents cross-site browser starts; it is not authentication for untrusted local users or a production control API.

**Compatibility.** Keep optional wire fields solely for previously started histories. When absent, preserve prior Activity payloads, prompt text, receipt hashes, cwd behavior and read-only flags; no implicit write migration. New starts always include the binding. V1 YAML and graph semantics are unchanged. Runtime services and durable evidence retain their configured location; only domain worker execution moves to the selected directory.

**Limits.** This is local workspace-write support, not unrestricted filesystem access or an exactly-once side-effect guarantee. Installed Codex/host policy still governs protected paths, temporary directories, network, and tools. It may deny build caches or device operations. Repository edits are not rolled back on retries, and an abrupt worker death can leave an external build process alive. Workers must reconcile interrupted operations; accepted-output receipts do not make arbitrary shell commands transactional. Concurrent writers share the selected repository and need suitable workflow concurrency limits. No cross-host session portability or production qualification is claimed.

**Evidence.** See [repository execution validation](validation/repository-execution-2026-09-07.md) for observed red failures, isolated Temporal/file-write/retry/browser tests, the installed sandbox probe, live Codex fresh/resumed execution, and replay results.

## ADR-023 — Catalog selection and immutable prepared starts

**Outcome.** Operators select a workflow, edit its input, review the exact definition and repository binding, and start that reviewed run. This closes the previously red dashboard-picker acceptance contract.

**Decision.** Refine ADR-009/010 control-plane ownership and ADR-022 repository binding. `src/run-preparation.ts` owns the operator-configured catalog and preparation use case; the HTTP adapter and Console only submit and present it. `YAMLFLOW_CATALOG` names a JSON file containing `workflows` entries with `id`, `name`, `workflow`, `input`, and `allowedRoots`. Relative paths resolve against the catalog directory. Workflow, example input, and recursively referenced prompt files must resolve inside an allowed root. Without a catalog, expose the configured workflow/input pair. Browser requests cannot choose arbitrary source files.

`POST /api/runs/prepare` requires `workflowId`, `inputText`, `mode`, and `workingDirectory`. Parse JSON, validate the canonical directory and workflow, and preflight external root input references. References requiring dependency outputs or scope iteration data remain runtime checks. Save the complete compiled definition, prompt snapshots, input, mode, canonical directory, and generated run identity in a hash-checked immutable local preparation record. Preparation does not schedule work.

`POST /api/runs` with `preparedId` and UUID `startId` starts that saved intent; it never falls back to the configured workflow. Bind each start key immutably to one intent. Each intent has one Temporal workflow ID and starts with reject-duplicate reuse policy, including after completion. Retrying an uncertain response returns the same identity. Prepared records persist across server restarts under `runtime/prepared/` and `runtime/prepared-starts/`; preserve them with the runtime. Local records bind launch intent, while Temporal remains execution authority. This is same-host retry deduplication within retained Temporal history, not permanent global exactly-once execution or authenticated protection from local file owners.

Add run mode `workflow`, which dispatches each leaf's declared provider, including nested leaves. Keep `simulated` and legacy global `codex` overrides unchanged. Only the new mode adds provider metadata to nested registration events, preserving existing history payloads. Actual provider remains recorded in each completion receipt. Existing V1 YAML and historical starts remain supported.

**Evidence.** See [dashboard picker validation](validation/dashboard-picker-2026-09-08.md). No broader production release gate is qualified by this change.
