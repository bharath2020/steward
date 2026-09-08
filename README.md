<p align="center">
  <img src="ui/assets/icon.png" width="96" height="96" alt="Steward icon" />
</p>

<h1 align="center">Steward</h1>

<p align="center">Durable agent workflows. Every step accounted for.</p>

<p align="center">
  <a href="https://github.com/bharath2020/steward/actions/workflows/ci.yml"><img src="https://github.com/bharath2020/steward/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/version-0.1.0-376524" alt="Version 0.1.0" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22%2B-43853d?logo=nodedotjs&logoColor=white" alt="Node.js 22 or later" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white" alt="TypeScript 5.9" /></a>
  <a href="https://temporal.io/"><img src="https://img.shields.io/badge/Temporal-durable_workflows-111827" alt="Temporal workflows" /></a>
  <a href="docs/architecture.md"><img src="https://img.shields.io/badge/status-local_demo-d4a72c" alt="Status: local demo" /></a>
</p>

Steward coordinates durable agent workflows from YAML. Define the work, inspect its progress, and recover interrupted steps from saved evidence. The current local demo supports dependency graphs, parallel agents, bounded quality loops, human input, typed outputs, retries, and a live dashboard.

## CLI, server, and UI

One repository contains distinct components with shared execution contracts:

| Component | Location | Responsibility |
|---|---|---|
| **Steward CLI** | [`src/cli/`](src/cli/) | Start runs, submit human answers, and supervise the local demo stack. |
| **Steward Server** | [`src/server/`](src/server/) | HTTP commands, run snapshots, SSE, and UI template composition. |
| **Steward Console** | [`ui/`](ui/) | Observe durable runs or build parser-validated V1 workflows through Codex/Claude chat and a live SVG preview. |
| Worker and runtime | [`src/worker.ts`](src/worker.ts), [`src/workflows.ts`](src/workflows.ts), [`src/activities.ts`](src/activities.ts) | Durable execution, provider work, and output acceptance. |

The CLI uses the Temporal client directly. The browser uses the server. Both reach the same runtime. The existing root entry points remain compatible with all commands below.

Select **Board** for graph-focused operation or **Review** for a larger output inspector and vertical timeline. Choose **Dark**, **Light**, or **System** independently. Preferences stay in the browser; switching appearance preserves the selected run, selected node, and unsent answer. See [UI templates](ui/README.md) to customize components and theme tokens.

Select **Build** to describe a workflow to an installed, authenticated Codex or Claude Code CLI. Steward supplies the current V1 language contract, requests structured YAML, validates it with the same parser used before durable starts, and renders only an accepted draft in the SVG topology. A parser error gets one bounded repair attempt. Expand **View validated YAML** in the chat to review the exact source. Drafts remain in that browser session, providers run without write permission, and chatting never creates a Temporal run or writes a workflow file.

## Create YAML with your own agent

The standard installer and `npm run setup` install the bundled [Steward workflow skill](skills/steward-workflow/SKILL.md) for Codex automatically. Set `STEWARD_SKILL_AGENT=claude`, `both`, or `none` in the setup/installer environment to select another target or opt out. Repeated setup upgrades older skills, retaining their complete previous directory as a backup; same/newer versions remain unchanged. When using the piped installer, set the variable on `bash`, for example `curl -fsSL https://raw.githubusercontent.com/bharath2020/steward/main/install.sh | STEWARD_SKILL_AGENT=both bash`.

To install the skill separately from a Steward checkout or downloaded installation (Node.js 22+):

```sh
npm run skill:install
```

This installs `steward-workflow` into `${CODEX_HOME:-~/.codex}/skills`. It is available on your next Codex turn. For Claude Code use `npm run skill:install -- --agent claude`; for another agent use `npm run skill:install -- --dest /absolute/path/to/skills`, or give the agent the bundled `SKILL.md` directly. Installation needs no runtime services or npm dependencies. Standalone installation refuses an existing skill unless you pass `--update`: `npm run skill:install -- --update`. Setup and the archive installer use this version-aware update automatically. Keep the whole skill directory so its references and examples remain available.

`skill-version.json` carries a positive integer release version independent of YAML version 1; maintainers must increment it when changing the bundled skill. Updates replace older versions, preserving all previous files and customizations at `.steward-workflow-backup-<unique>/steward-workflow` beside the installed skill. Same/newer versions are preserved. Recognizable unversioned Steward skills count as version 0; unrelated unversioned directories are preserved with a message. Invalid version metadata stops installation. `--if-missing` retains its install-only behavior.

To restore a backup, move the current skill aside and move the printed backup directory back to its original location. An interrupted update retains its backup and install lock; confirm the installer has stopped before restoring the backup or removing the lock.

Ask your agent:

> Use $steward-workflow to create a workflow that reviews a proposal from two perspectives, asks me to choose a direction, and produces a summary. Save workflow.yaml and input.json. Validate them without starting a run.

The skill covers the implemented V1 schema, human questions, loops, and array fan-out. Any agent can author the YAML; execution providers remain `codex` and `simulated`. With Steward dependencies installed, validate files independently:

```sh
npm run validate:workflow -- /absolute/path/to/workflow.yaml /absolute/path/to/input.json
```

Validation uses the same file-aware loader as runtime starts, checks supplied initial-input references, and does not start Temporal or an agent. It does not exhaustively check node-output references or nested object shapes. The schema guide calls out those manual checks. Installation and validation details are covered by [ADR-018](docs/decisions.md#adr-018--portable-v1-authoring-skill) and [ADR-021](docs/decisions.md#adr-021--version-aware-authoring-skill-updates-with-retained-backups).

## Product direction and design

Steward is moving toward an installable developer CLI, followed by a production deployment for one trusted team. The repository currently implements the demo; the documents below define the target and its release gates.

| Document | Purpose |
|---|---|
| [Vision](docs/vision.md) | Users, product promise, scope, principles, and success measures |
| [Architecture decisions](docs/decisions.md) | Adopted choices, alternatives, consequences, and change policy |
| [Software architecture](docs/software-architecture.md) | Component responsibilities, interfaces, dependencies, and current-code mapping |
| [Technical design](docs/technical-design.md) | Execution, evidence, storage, security, compatibility, and deployment contracts |
| [Production roadmap](docs/production-roadmap.md) | Sequenced implementation, fault tests, operating targets, and release gates |
| [Current architecture](docs/architecture.md) | Implemented behavior and current limitations |
| [CLI and language specification](docs/cli-architecture-and-product-spec.md) | Detailed target command, TUI, and future language reference |

For future changes, follow the vision and adopted decisions, use the technical design for behavior and the software architecture for code ownership, and use the roadmap for scope and acceptance. Target documents do not establish that a production capability has shipped.

## Run the demo

### One-command macOS installation

```bash
curl -fsSL https://raw.githubusercontent.com/bharath2020/steward/main/install.sh | bash
```

No Git, cloning, or directory changes are required. The installer downloads the
source archive to `~/Applications/Steward`, then installs prerequisites and opens
the console. Every invocation downloads the latest `main` source, including when
Steward is already installed. Updates stop services belonging to that installation,
replace source, and run setup to restart the console. Saved `runtime/` data,
outputs, local `.env` files, and unrelated top-level files are preserved. The
previous source is retained in the printed `.steward-source-backup.*` folder beside
the installation. Edits inside source directories are replaced; their old copies
remain in that backup. `Setup Steward.command` reopens without downloading.

`STEWARD_INSTALL_DIR` selects a different absolute installation directory;
`STEWARD_REF` can pin a commit. `npm run verify:installer` checks the public
command and exercises the default download and explicit pin; CI runs this on
every push and pull request through `npm run verify`. Existing unrelated
directories are never overwritten.
A force-interrupted download may leave `<installation-directory>.installing`;
confirm no installer is running before removing that empty lock directory.

### One-click macOS setup

Download or clone this repository, then double-click **[Setup Steward.command](Setup%20Steward.command)** in Finder. It installs missing Node.js 22+ and Temporal through Homebrew (installing Homebrew when needed), checks dependencies, typechecks, validates all four examples, starts the local services in the background, and opens Steward Console. Initial Homebrew installation may require your administrator password and its own installation confirmation. A downloaded file may require Finder's **Open** action under macOS security settings.

On a fresh workspace, setup starts the simulated multiple-choice example. On later launches it reconnects to saved runs. No Codex account is required. The service data stays in `runtime/temporal.db` and `runtime/runs/`; closing the setup window does not stop the background supervisor. Rebooting stops it; double-click Setup again to restart.

To start a **new** example with one click, open a launcher in `examples/`:

| Launcher | Example |
|---|---|
| [Run Questions.command](examples/Run%20Questions.command) | Two agents, four multiple-choice human gates, joined decision brief |
| [Run Product Launch.command](examples/Run%20Product%20Launch.command) | Parallel specialists and a bounded quality loop |
| [Run Privacy Launch.command](examples/Run%20Privacy%20Launch.command) | Human clarification before privacy launch research |
| [Run File Prompt.command](examples/Run%20File%20Prompt.command) | A small agent assignment loaded from a Markdown file |

These launchers use the simulated provider. They never answer human gates for you.

Terminal equivalents:

```bash
npm run setup
npm run setup -- --example questions --new-run
npm run setup -- --example product --new-run
npm run setup -- --example privacy --new-run
npm run setup -- --example file --new-run
npm run setup -- --check        # Install/check dependencies and validate; no services or runs
```

The shell entrypoint also works on Linux with Node.js 22+, npm, and Temporal already installed. Automatic prerequisite installation targets macOS. Homebrew follows its [official installer](https://brew.sh/); Temporal uses its [documented Homebrew installation](https://docs.temporal.io/cli/setup-cli).

Logs are in `runtime/services/`; setup prints the supervisor PID when it starts one. To stop that supervisor and its owned services, send `kill -TERM <printed-pid>`. Services that were already running are reused and remain owned by their original launcher. An existing dashboard retains its configured **Run again** example; use the example launchers to choose another one. Setup binds locally and does not install/configure ZeroTier or expose a network interface. Custom `TEMPORAL_ADDRESS` or `YAMLFLOW_RUNTIME_DIR` profiles are rejected by this local setup flow.

Concurrent clicks are serialized. If setup is force-killed during dependency installation, confirm it has stopped before removing the empty `runtime/services/bootstrap.lock` directory and retrying. A recorded but uncertain start in `runtime/services/setup-start.json` is not automatically resubmitted: inspect its Workflow ID in Temporal first. That file records submission intent, not accepted output or completion.

### Manual setup

Requires Node.js 22 or later and the [Temporal CLI](https://github.com/temporalio/cli#installation) on your PATH. The simulated demo needs no provider account. Real workers additionally require an authenticated Codex CLI.

```bash
git clone https://github.com/bharath2020/steward.git
cd steward
npm ci
npm run verify
npm run demo
```

Open [http://127.0.0.1:4310](http://127.0.0.1:4310). Temporal's local history UI is at [http://127.0.0.1:8233](http://127.0.0.1:8233).

The default run is deterministic and takes roughly 10 seconds. Use the dashboard's **Run again** control to replay it. The server refreshes from disk over SSE every 700 ms.

To restart services without creating another run:

```bash
npm run demo -- --no-start
```

The equivalent explicit recovery command is `npm run resume`. It reconnects to the existing database and does not start a second run. `npm run verify:recovery` runs two destructive fault scenarios against an isolated temporary database: it kills a worker after provider completion and reconstructs deleted receipt/output projections without rerunning the provider, then exhausts automatic network retries and resumes the recorded provider session through a durable Workflow Update.

The Temporal server uses `runtime/temporal.db`; active workflows resume when the worker returns.

## Recovery behavior

- Every long-running provider Activity heartbeats a checkpoint bound to the Temporal Run ID, application run, node, iteration, recovery cycle, and provider session. An automatic retry uses `codex exec resume <session-id>` instead of silently starting over.
- Successful outputs are committed with two immutable `agent-completion-receipt.v1` copies. The receipt binds the Workflow Run ID, one-time dispatch token, prompt/schema/output hashes, node identity, iteration, and provider session. A retry can rebuild a missing output or receipt projection from the remaining valid copy without rerunning the agent. Disagreeing or forged copies are rejected.
- After the YAML retry budget is exhausted, only the failed node moves to **Recovery needed**. Completed parallel siblings remain committed. Select the node in the dashboard to resume the same session, start a fresh session, or abort the workflow. A same-session option is disabled when no session was checkpointed or the context window was exhausted.
- Each operator retry schedules a new Activity invocation, so it receives a fresh automatic-attempt budget. The operator command and every transition remain in Temporal history and `events.jsonl`.
- Cancellation sends `SIGTERM` to the provider process and escalates to `SIGKILL` after five seconds. Provider JSONL and stderr are bounded so a runaway child cannot grow memory without limit.

The demo protects process, worker, launcher, browser-network, and same-disk projection failures. It does not claim protection from loss or corruption of the whole machine: `runtime/temporal.db` and both receipt copies are local. Production needs Temporal Cloud or a production Temporal cluster plus externally replicated artifact storage.

## Run real Codex workers

```bash
npm run start -- --workflow workflows/product-launch.yaml --input examples/product-input.json --mode codex
```

The worker adapter uses `codex exec --json --sandbox read-only --output-schema ... --output-last-message ...`, or `codex exec resume` when a matching session checkpoint exists. Existing Codex CLI authentication is reused. Each agent is bounded to one node, cannot write to the repository, and must return the node's JSON shape. Only completed `agent_message` items from the Codex JSONL stream are persisted to `nodes/<node-id>/messages.jsonl`; reasoning, command, tool, and lifecycle events remain out of the selected-node transcript.

## Multiple-choice questions from two agents

[Run the question example](examples/two-agent-multiple-choice.md) to have product
and technical agents each ask two questions with A/B/C options. Four human answer
gates join before a decision brief. It supports simulated and real Codex runs;
the console presents selectable choices and a custom-answer option.

## YAML contract

```yaml
version: 1
name: Example
defaults:
  provider: codex
  max_parallelism: 4
  retry: { maximum_attempts: 2 }
groups:
  discovery:
    title: Discovery
    max_parallelism: 2
nodes:
  first:
    prompt: Analyze the initial brief.
    inputs:
      brief: $input.brief
    outputs:
      summary: string
  parallel_a:
    group: discovery
    needs: [first]
    prompt: Explore option A.
    inputs:
      summary: $nodes.first.output.summary
    outputs:
      recommendation: string
  parallel_b:
    group: discovery
    needs: [first]
    prompt: Explore option B.
    inputs:
      summary: $nodes.first.output.summary
    outputs:
      risk: string
  join:
    needs: [parallel_a, parallel_b]
    prompt: Reconcile both branches.
    inputs:
      option: $nodes.parallel_a.output.recommendation
      risk: $nodes.parallel_b.output.risk
    outputs:
      decision: string
      quality_score: number
    loop:
      max_iterations: 3
      carry_as: previous_decision
      on_exhaustion: fail
      until:
        path: quality_score
        operator: greater_than_or_equal
        value: 0.85
```

Agent nodes require exactly one of `prompt` or `prompt_file`. Keep long assignments in UTF-8 text or Markdown files:

```yaml
nodes:
  review:
    prompt_file: ./prompts/review.md
    inputs:
      brief: $input.brief
    outputs:
      summary: string
```

Relative paths resolve from the YAML file's directory, regardless of the launch directory. Absolute paths also work; relative paths make workflows easier to share. Paths are literal filesystem paths: no URL fetching, environment expansion, or nested includes. Human nodes continue to use `question`; `prompt_file` is rejected on them.

Both the CLI and server load file contents before starting a run. Missing, unreadable, invalid UTF-8, and empty/whitespace-only files fail validation with the node ID and reference. Specifying both prompt fields is an error, even if one is empty or null.

The compiled definition stores the prompt text plus `promptSource.path` and its SHA-256. File content changes affect `definitionHash`. An active run, retry, or resumed execution uses its saved text even after the source file is edited or deleted; starting a new run loads the file again. Inline-only definition hashes retain their existing behavior.

File and inline prompts are literal assignment text. Neither interpolates `{{variables}}` or `$input` inside the prompt. Declare dynamic data under `inputs`; Steward resolves it and appends it to the worker assignment.

Try the [file prompt example](workflows/file-prompt.yaml):

```bash
npm run start -- --workflow workflows/file-prompt.yaml --input examples/product-input.json --mode simulated
```

This command requires a running Temporal server and Steward worker, as with the other examples.

All output fields are required. Supported types are `string`, `number`, `boolean`, `object`, `string[]`, `number[]`, `boolean[]`, and `object[]`. References may target `$input`, `$input.path`, `$nodes.<id>.output`, or `$nodes.<id>.output.path`.

An agent node can consume an array as a bounded queue with `for_each`:

```yaml
  review:
    needs: [plan]
    prompt: Review the one queued task supplied as task.
    for_each:
      items: $nodes.plan.output.tasks
      as: task
      max_parallelism: 2
    outputs:
      finding: string
```

`items` is an array reference, `as` injects one item into each worker's resolved inputs, and `max_parallelism` caps that node's simultaneous item workers. The global and group caps still apply, so the strictest applicable limit wins. Items are released in source order; the node commits only after every item succeeds, and its downstream output is an array of per-item output objects in the original source order. An empty source array commits `[]` without launching an agent. `for_each` cannot be combined with `loop` or `kind: human`.

Try the [queued fan-out example](workflows/queued-fan-out.yaml):

```bash
npm run start -- --workflow workflows/queued-fan-out.yaml --input examples/queued-fan-out-input.json --mode simulated
```

Groups apply per-group parallelism limits while preserving the global cap. Loops are deliberately bounded to 20 iterations and support `equals`, `not_equals`, numeric comparisons, `contains`, and `truthy`. A downstream fan-in sees only the final accepted loop output.

See [docs/architecture.md](docs/architecture.md) for the current durability and control-plane design. The proposed installable CLI, TUI, V2 YAML language, compiler, optional dashboard, and agent implementation packets are specified in [docs/cli-architecture-and-product-spec.md](docs/cli-architecture-and-product-spec.md).

## Development and CI

Run `npm run verify` for typechecking and unit tests. `npm run test:e2e` exercises the consumer CLI and all five bundled YAML workflows against an isolated Temporal server, including human answers, loop/queue boundaries, and invalid definitions. `npm run verify:recovery` checks worker-loss and session recovery. Run `npm run verify:all` for all three layers. See the [CLI surface and scenario matrix](docs/cli-testing.md) for prerequisites, evidence, and coverage limits.

The [CI workflow](.github/workflows/ci.yml) checks Node 22 and 24 and runs a separate simulated recovery job. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, ownership boundaries, and validation expectations. Runtime history, credentials, local agent configuration, and generated test output are excluded from Git.

Steward was developed under the working name YAMLFlow, so some local configuration, execution IDs, task queues, and schema identifiers retain that spelling. All new definitions use the single `stewardWorkflow` Temporal type and `executeAgent` Activity. Pre-adoption `yamlAgentWorkflow*` histories and artifacts are preserved but are not registered or replayable by the current worker; see ADR-016.
