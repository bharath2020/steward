# File prompt validation

Date: 2026-09-06 UTC (2026-09-05 local).
Base: `7b61904153337d29a690b38bc75663f82e0ef5db`.
Decision: [ADR-011](../decisions.md#adr-011--file-prompts-are-resolved-before-workflow-start), refining ADR-002 and preserving ADR-009 ownership.

## User outcome

Authors can replace inline agent assignments with `prompt_file`. CLI and server load the file before Temporal start; saved definitions retain assignment text, source path, and SHA-256. Existing inline-only definition hashes remain unchanged.

## Local checks

Environment: Node 22.23.2, Temporal CLI 1.8.2.

- `rtk npm run verify`: exit 0; typecheck and all 48 tests passed, including 10 new file-prompt cases.
- Independent reviewer: no actionable findings in parser/loader, contracts, tests/example, documentation, or runtime handoff. Independent `rtk proxy node --import tsx --test tests/prompt-file.test.ts`: exit 0, 10/10 passed.
- `rtk npm run verify:recovery`: exit 0. Uses its own temporary runtime, Temporal server, workers, and ports with simulated agents.
- The initial sandboxed `verify` passed typechecking but could not create the tsx IPC socket (`EPERM`). The full command subsequently passed outside that restriction.

Unit coverage includes mixed source types, exclusivity, human-node rejection, invalid paths, missing/directories/empty files, malformed UTF-8, literal Unicode/BOM/line endings, input bindings, path resolution from another working directory, explicit absolute paths, pure parser injection, serialized snapshots, changed-content hashes, portable relative-path identity, and the frozen legacy hash.

## Live recovery evidence

Receipt run: `2026-09-06T05-37-50-142Z-8fa20c`.

1. Created a product-launch workflow with `intake.prompt_file`.
2. Started the workflow, then deleted its prompt file before starting any worker.
3. Killed the worker after the primary completion receipt was persisted.
4. Deleted the output and mirror receipt projections and restarted the worker.
5. The workflow completed; both deleted projections were reconstructed with zero provider reruns.
6. Checked saved definition content/provenance and the executed prompt's receipt hash while the source file remained absent.

Prompt source SHA-256: `a86df9f89aa93b4e07b7f4cdf8487cc2ef1161973391fd808952f92c7c610266`.

Network recovery run: `2026-09-06T05-38-04-446Z-bde8cf`. Two automatic attempts were exhausted, the HTTP recovery command resumed the same simulated provider session, and completed siblings were not rerun.

The harness cleans up its owned temporary runtime after assertions. The run IDs above record this validation, not a currently running service. Real Codex inference was not needed for this loader extension; no production qualification is implied.
