# Upgrade testbeds long-running workflow

The input includes Rocket.Chat SDK 55, Rocket.Chat SDK 56, and the Expo SDK 54
monorepo under `/Users/bharath2020/Documents/projects/upgrade-testbeds`.
For each repository: TypeScript -> parallel platform builds -> each platform's
tests -> one report after all seven test lanes. Rocket.Chat covers iOS/Android;
Expo also covers web. There are 18 nodes. Each platform group allows one active
node to reduce contention on shared devices; overall concurrency is three.
Each test waits for its own build; repositories do not wait for unrelated builds.

## Execution requirements

Start with `/Users/bharath2020/Documents/projects/upgrade-testbeds` as the required
working directory so all three repositories are inside the assigned workspace.
New Codex runs permit workspace writes. Native projects, installed dependencies,
devices and existing platform test suites are checked by workers; missing
prerequisites fail the gate without source fixes. Additional cache/network/device
permissions are not granted by a prompt. This workflow has been validated, but
its platform builds and tests have not been run.

Agent activities currently have a 12-hour start-to-close timeout and a 10-second
heartbeat timeout, with heartbeats every four seconds. These are runtime settings,
not per-node YAML fields. Two activity attempts are allowed; one-iteration output
predicates prevent a reported failed/blocked gate from releasing dependent nodes.

## Validate and start

From the Steward checkout:

```sh
rtk npm run validate:workflow -- workflows/upgrade-testbeds-long-running.yaml examples/upgrade-testbeds-long-running-input.json
# Once build and test prerequisites are available:
rtk npm start -- --working-directory /Users/bharath2020/Documents/projects/upgrade-testbeds --workflow workflows/upgrade-testbeds-long-running.yaml --input examples/upgrade-testbeds-long-running-input.json --mode codex
```

Start is intentionally not performed as part of authoring. Explicit `--mode codex`
is required because the start CLI defaults to simulated mode.

## Durability experiment checklist

1. Start once and save the returned workflow/run identity. Record the definition
   hash, Temporal history and committed artifact hashes under `runtime/runs/`.
2. While a real build is active, record its process identity, heartbeat and logs.
   In a dedicated runtime, stop only that run's worker. Do not interrupt unrelated
   runs. Preserve `runtime/temporal.db` and `runtime/runs/`.
3. Restart the existing stack using `rtk npm run resume`; do not start a second
   workflow. Reconcile the same Temporal workflow identity, retry/session events,
   and process state. An interrupted build may restart; process continuation and
   exactly-once shell execution are not guaranteed.
4. Verify previously committed TypeScript/build outputs retain their hashes and
   are not rerun. Verify no test starts before its own successful build commit,
   and no report starts before all seven tests commit. Check for duplicate live
   builds, stale artifacts and source revisions changing during recovery.
5. Repeat a restart between completed gates. Reconcile final Temporal status,
   schema-valid committed outputs, exit codes, report contents and artifact hashes.
   Record observed wall time and retries. Mark durability passed only with this
   evidence; a completed graph or successful provider message alone is insufficient.

No restart experiment or platform command has been executed by authoring this file.
