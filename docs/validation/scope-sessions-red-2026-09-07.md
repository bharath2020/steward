# Scope session policy: initial RED evidence

Date: 2026-09-07. Test owner: session_resume_tests subagent.

Before production changes, `node --import tsx --test tests/e2e/scope-sessions.test.ts` exited 1. The default policy baseline passed through an isolated real Temporal server and the real Codex Activity adapter with a controlled external CLI. It created four independent provider sessions, four qualified execution identities and four hash-verified committed receipts over two parallel leaves and two iterations. The opt-in `loop.agent_sessions: resume` scenario failed at public CLI validation: `Invalid workflow: node repair.loop has an unsupported field`.

The test asserts actual `codex exec resume` invocations, session continuity per leaf, distinct sessions for siblings, and receipt provenance matching the provider-observed IDs. It does not assert LLM task quality or test the installed Codex service. The provider stub is scoped to the worker PATH; no real provider credentials or existing runtime directories are used.

- [Captured RED log](scope-sessions-red-2026-09-07.txt)
- Durable baseline evidence: `/var/folders/1c/wkzr1t1945v0tg_882wwqshh0000gn/T/steward-cli-e2e-MOwwZ4`
- Sandbox-only first attempt encountered localhost `listen EPERM`; it was not counted as feature RED. The isolated test was rerun with approved escalation.

Implementation was released to the implementation subagent only after this RED result.
