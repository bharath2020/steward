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
| **Steward Console** | [`ui/`](ui/) | Server UI with shared templates, selectable layouts/themes, and browser interactions. |
| Worker and runtime | [`src/worker.ts`](src/worker.ts), [`src/workflows.ts`](src/workflows.ts), [`src/activities.ts`](src/activities.ts) | Durable execution, provider work, and output acceptance. |

The CLI uses the Temporal client directly. The browser uses the server. Both reach the same runtime. The existing root entry points remain compatible with all commands below.

Select **Board** for graph-focused operation or **Review** for a larger output inspector and vertical timeline. Choose **Dark**, **Light**, or **System** independently. Preferences stay in the browser; switching appearance preserves the selected run, selected node, and unsent answer. See [UI templates](ui/README.md) to customize components and theme tokens.

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

All output fields are required. Supported types are `string`, `number`, `boolean`, `object`, `string[]`, and `number[]`. References may target `$input`, `$input.path`, `$nodes.<id>.output`, or `$nodes.<id>.output.path`.

Groups apply per-group parallelism limits while preserving the global cap. Loops are deliberately bounded to 20 iterations and support `equals`, `not_equals`, numeric comparisons, `contains`, and `truthy`. A downstream fan-in sees only the final accepted loop output.

See [docs/architecture.md](docs/architecture.md) for the current durability and control-plane design. The proposed installable CLI, TUI, V2 YAML language, compiler, optional dashboard, and agent implementation packets are specified in [docs/cli-architecture-and-product-spec.md](docs/cli-architecture-and-product-spec.md).

## Development and CI

Run `npm run verify` for typechecking and unit tests. `npm run verify:recovery` additionally checks worker-loss and session recovery in isolated temporary storage using simulated agents.

The [CI workflow](.github/workflows/ci.yml) checks Node 22 and 24 and runs a separate simulated recovery job. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, ownership boundaries, and validation expectations. Runtime history, credentials, local agent configuration, and generated test output are excluded from Git.

Steward was developed under the working name YAMLFlow. Existing `YAMLFLOW_*` settings, `yamlflow-` execution IDs, task queues, schemas, and supported Temporal workflow types retain their identifiers so saved runs remain addressable. The product rename does not migrate execution history.
