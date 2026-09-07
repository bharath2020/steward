# Optional scope session continuity — verified 2026-09-07

Implemented ADR-020: `scope.loop.agent_sessions: fresh | resume`, default fresh. The root task orchestrated; implementation, end-to-end tests, documentation, and independent review were delegated. All changes remain uncommitted; prior scope work and repository runtime data were preserved.

```yaml
loop:
  max_iterations: 5
  agent_sessions: resume
  until:
    path: approved
    operator: equals
    value: true
```

Resume preserves a separate conversation per descendant leaf and mapped source position within one repeated-scope activation. Loop-free scopes inherit the owner; nested repeats own independent policies/maps and default fresh. New iteration inputs intentionally differ and still use explicit state/export bindings. Execution identities and accepted output artifacts remain distinct per iteration.

Only accepted Activity results update affinity. The descriptor binds observed session ID, actual provider, and canonical workspace in receipts, results, heartbeats, and recovery metadata. A matching current-dispatch checkpoint supersedes the previous-iteration seed. Mismatches reject before provider spawn or publishing an opted-in resume heartbeat. A known resume failure uses existing recovery; successful explicit fresh recovery replaces future affinity. With no recorded session ID, execution starts fresh and records `node.session` with `action: fresh`, `reason: no_recorded_session`.

## Final frozen verification

`rtk proxy sh -c 'npm run verify:all > /tmp/steward-session-verify-final.log 2>&1; result=$?; tail -65 /tmp/steward-session-verify-final.log; exit "$result"'` completed **exit 0**, with approved local loopback/IPC access. No source or tests changed during this final run.

- Installer: 8/8 passed; TypeScript build passed.
- Unit/integration: 106/106 passed, including identity checks, accepted-receipt session restoration, and both supported-history replay fixtures.
- Real-Temporal CLI end-to-end: 78/78 passed; the new session suite contributed 9 passing TAP cases.
- No failures, cancellations, or skipped tests.
- Recovery returned `ok: true`: zero provider reruns after receipt recovery; zero completed sibling reruns; queued recovery released permits; corrupt superseded dispatches remained retained while fresh recovery completed.
- `rtk git diff --check` and `rtk proxy node --check ui/assets/app.js` passed.

Installer tests also appear in the unit glob; stage counts are not unique-test totals. Complete output: [final log](scope-sessions-final-2026-09-07.txt). Tested source snapshot SHA-256: `285e1b3fa47fb3ff39d45f9fdfe23d3b62261c8978a31d56cbecd28f4908ee78`; [manifest](scope-sessions-source-manifest-2026-09-07.json).

## Red-first and boundary evidence

[Initial RED](scope-sessions-red-2026-09-07.md) was observed before production edits: a healthy default-fresh baseline executed four separate external CLI sessions and committed receipts; the opt-in case failed parser validation on the unsupported field. [Session E2E report](scope-sessions-e2e-2026-09-07.md) records the later passing adapter cases.

Final tests inspect real Activity adapter subprocess arguments (`exec` versus `exec resume`) using a deterministic fake `codex` executable under isolated real Temporal. They prove default/explicit fresh, distinct parallel session affinity, changed iteration inputs, loop-free inheritance, nested policy isolation, worker restart at a human gate without rerunning accepted leaves, resumed failure followed by explicit fresh replacement, mapped position isolation, and explicit missing-session fallback.

The Activity-boundary regression initially exposed a heartbeat published before rejecting invalid affinity ([RED](scope-sessions-affinity-red-2026-09-07.txt)). The corrected boundary rejects provider/workspace/session mismatches with no CLI invocation or unvalidated checkpoint, chooses the newest valid checkpoint, and restores hash-bound session metadata from an accepted receipt without invoking the provider again ([GREEN](scope-sessions-affinity-green-2026-09-07.txt)). Independent review found no outstanding actionable runtime issue.

Final session E2E database/artifacts: `/var/folders/1c/wkzr1t1945v0tg_882wwqshh0000gn/T/steward-cli-e2e-rVC5Vd`. Harness cleanup stopped isolated services; existing repository runtime services were not restarted or removed.

## Example and limits

Runnable workflow: `/Users/bharath2020/Documents/projects/steward/skills/steward-workflow/assets/scope-loop-resume.yaml`, using `/Users/bharath2020/Documents/projects/steward/skills/steward-workflow/assets/scope-loop-input.json`. The Console inspector shows the selected policy; authoring and the portable skill describe it.

This verifies orchestration and the actual CLI adapter boundary with a controlled provider executable, not live Codex model reliability or conversation quality. Existing scope bounds, read-only execution permissions, same-host artifact storage, and production qualification limits remain unchanged. Session continuity requires the provider's retained local session; no cross-workspace or cross-machine portability is promised.
