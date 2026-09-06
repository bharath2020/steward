# CLI, server, and UI template validation

Recorded 2026-09-06 00:02 UTC (2026-09-05 local). Scope: component extraction and configurable UI presentation under ADR-001, ADR-009, and ADR-010.

## Automated checks

| Check | Observed result |
|---|---|
| `npm run verify` | Exit 0; TypeScript check and 25/25 tests passed. |
| Focused CLI import check | Exit 0; imports perform no filesystem writes, subprocess launch, network connection, command submission, output, or signal-handler registration. |
| UI/template suite | Exit 0; required mount points, template composition, explicit asset mapping, preferences, system themes, and keyboard guards passed. |
| `node --check ui/assets/app.js` and `node --check ui/assets/appearance.js` | Exit 0. |
| `npm run verify:recovery` | Exit 0 and `ok: true`; isolated simulated runs with temporary storage/ephemeral ports. |

The recovery harness recorded receipt recovery run `2026-09-05T23-55-38-680Z-2d0124`: worker killed after provider completion, deleted receipt/output restored, **0 provider reruns**. Network recovery run `2026-09-05T23-55-52-756Z-535ab7` exhausted **2 automatic attempts**, accepted `retry_same_session`, and reran **0 completed siblings**. The harness removed its own temporary storage after checking; those run IDs are a record of test output, not a claim that their artifacts remain available.

## Browser observations

Inspected the server on a separate local port using the existing run projections without submitting answers, recovery commands, or new runs.

- Board/Dark and Review/Light rendered successfully; icon loaded.
- Layout and theme switches retained the unsent test answer and selected node.
- Typing `r` in the answer field left the displayed run count at 18. The test text was cleared without submission.
- Review's graph fits its overview region; its timeline uses vertical scrolling. Board retains the larger scrollable graph and horizontal timeline.
- Reload preserved layout/theme preferences. System resolved to the current dark system preference; operating-system changes are covered by the pure preference tests rather than changing the user's OS settings.
- At a 390px viewport, both layouts had a 390px document width and visible appearance controls. The temporary viewport override was reset.
- Browser error log inspection returned no errors.

## Limits and outstanding work

These checks cover the local refactor and selected recovery scenarios. They do not establish production readiness, full Temporal history replay qualification, live-provider relocation compatibility, or GitHub CI success. The existing runtime was preserved. Steward naming is approved and the project moved to `Documents/projects/steward`; all 888 runtime files (10,632,065 bytes) matched pre-move SHA-256 hashes after relocation. Repository creation/push and the first GitHub CI run remain pending.
