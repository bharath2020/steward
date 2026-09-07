# Scope session policy: end-to-end acceptance

Date: 2026-09-07. Owner: session_resume_tests subagent. Command: `node --import tsx --test tests/e2e/scope-sessions.test.ts`.

Result: exit 0, 9 tests passed (8 acceptance cases plus the parent), zero failures/skips. [Captured output](scope-sessions-e2e-2026-09-07.txt). [Initial RED evidence](scope-sessions-red-2026-09-07.md) predates production changes; opt-in initially failed public validation while the default baseline completed.

The suite starts an isolated real Temporal service and worker, invokes the public start CLI in Codex mode, and substitutes only the external Codex binary using a worker-local PATH. The controlled CLI emits observed session IDs and records actual fresh/resume arguments. Every completed run reconciles Temporal closure and final output with persisted state; each leaf receipt has its hash, provider, execution identity, and provider-observed session verified.

Verified behaviors:

- Default and explicit `fresh`: each iteration starts independently.
- `resume`: changed iteration inputs reach distinct leaf executions in the same provider session; parallel siblings remain separate.
- Loop-free groups inherit the owner; nested repeats own separate session maps, shadow outer policy, and reset on a new parent activation.
- Killing and restarting the worker at a human gate retains accepted session affinity and does not reinvoke accepted leaves.
- A failed resume waits for explicit recovery. Fresh recovery starts a new session and the next iteration resumes that replacement.
- Mapped leaves retain positional identity even when item values are equal.
- Providers without session IDs use fresh turns with explicit persisted `node.session` fallback reasons.

This is execution-boundary coverage with a controlled provider, not a test of live LLM quality, remote Codex availability, or portable session placement. Existing runtime directories and workflows were preserved. The full repository regression/replay checks are reported separately by the implementation owner.
