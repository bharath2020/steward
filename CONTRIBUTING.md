# Contributing

Contributions should make declared work easier to inspect and recover while preserving existing workflow definitions, execution histories, and accepted outputs.

## Set up a checkout

Use Node.js 22 or 24 and npm. From the repository root:

```sh
npm ci
npm run verify
```

`verify` runs the TypeScript check (`tsc --noEmit`) and the test suite. It requires no running Temporal service or Codex credentials. `build` is a typecheck; it does not emit a distributable package.

For local runtime development, install the [Temporal CLI](https://github.com/temporalio/cli#installation). CI pins Temporal CLI 1.8.2 for recovery verification. Codex is only required when explicitly choosing `--mode codex`; simulated development and CI need no provider account.

## Understand the current design

The CLI lives in `src/cli/`, the HTTP server in `src/server/`, and the server UI in `ui/`. Root entry files preserve existing npm commands. Read [UI templates](ui/README.md) before changing layout, theme, shared markup, or browser behavior. Appearance choices must preserve unsent input and must never submit workflow commands.

Read [the current architecture](docs/architecture.md) before changing runtime behavior. For substantive product or architecture work, also read [the vision](docs/vision.md), applicable [decisions](docs/decisions.md), [technical design](docs/technical-design.md), and [production roadmap](docs/production-roadmap.md). Use [the module responsibility map](docs/software-architecture.md) to identify the owner and allowed dependencies. These target documents describe adopted direction; they do not prove that a capability has shipped.

Keep the existing boundaries explicit:

- Temporal owns scheduling, dependency readiness, retries, and durable human/recovery waits. Workflow code must remain deterministic; filesystem, network, and provider work belongs in Activities or adapters.
- Workers perform their bounded node prompts. The coordinating agent must not answer a missing node prompt or reconstruct missing worker results.
- Agent completion requires schema-valid output and committed receipt evidence before dependent nodes can proceed. The current human-input path has a documented artifact/receipt gap; do not describe it as already using the common target commit contract.
- Preserve supported V1 YAML, human-input workflows, and Temporal histories. New scheduling semantics must not silently change the behavior used to replay old histories.
- Preserve `runtime/temporal.db` and `runtime/runs/` across restarts and upgrades. Those files contain run history and evidence, not disposable build output.
- Keep domain work read-only unless a separately adopted capability and permission contract authorizes broader effects. Do not put credentials or private run artifacts in a contribution.

These boundaries follow ADR-003 (execution authority and evidence), ADR-006 (operator policy), ADR-007 (runtime compatibility), ADR-008 (release evidence), and ADR-009 (module ownership).

## Run and inspect a simulated workflow

```sh
npm run demo -- --mode simulated
```

This starts the local Temporal server, worker, and dashboard and creates a new simulated run. The dashboard defaults to [localhost:4310](http://127.0.0.1:4310); Temporal history is available at [localhost:8233](http://127.0.0.1:8233). Stop the launcher with Ctrl+C. To reopen the stack against the same durable files without creating another run:

```sh
npm run resume
```

The launcher is intended for local development. Same-host SQLite and artifact files do not establish host-loss recovery or production readiness.

## Validate a change

Run `npm run verify` for code changes. Add focused regression coverage for changed behavior, especially parsing, output validation, dependency readiness, recovery, and replay-sensitive contracts. Update current-state documentation when implemented behavior changes.

For changes affecting worker retries, completion receipts, recovery Updates, or the durable store, also run:

```sh
npm run verify:recovery
```

This unattended harness requires the Temporal CLI on `PATH`. It creates its own temporary directory and ephemeral local server ports, runs only simulated workers, kills a test worker, deletes selected test projections, and checks receipt restoration and same-session recovery without rerunning completed siblings. It stops its child processes and deletes its temporary directory afterward. It does not use or erase the repository's `runtime/` history. A successful harness run covers these selected fault scenarios; it is not a production qualification or comprehensive replay test.

GitHub CI runs `npm ci` followed by `npm run verify` on Ubuntu with Node 22 and 24. A separate Node 24 job installs a checksum-verified Temporal CLI and runs `verify:recovery`. Neither job uses provider credentials. GitHub Actions are pinned to commits, with Dependabot checking action updates weekly. When changing the Temporal CLI pin, update both its download version and checksum from the [official release](https://github.com/temporalio/cli/releases).

## Submit a change

Open a pull request describing the user-visible problem, the resulting behavior, and how you verified it. Include relevant test commands and exit results, compatibility effects, and any remaining limitations. For substantive changes, identify the user outcome, owning module, and applicable decision IDs.

A new language semantic, public contract, storage authority, execution or permission boundary, or durability claim needs a superseding decision record and relevant migration/recovery evidence. Routine implementation within an adopted decision does not need another decision record. Do not mark a release gate passed from prose, worker status, or a subprocess success message without verifying its exit status and required artifacts.

For bug reports, include a minimal YAML/input example, expected and observed behavior, Node and Temporal versions, and sanitized error text. Share synthetic or redacted examples; retained run artifacts may contain prompts, inputs, and provider outputs.
