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

These checks cover the local refactor and selected recovery scenarios. They do not establish production readiness, full Temporal history replay qualification, or live-provider relocation compatibility. GitHub CI was subsequently verified as recorded below. The existing runtime was preserved. Steward naming is approved and the project moved to `Documents/projects/steward`; all 888 runtime files (10,632,065 bytes) matched pre-move SHA-256 hashes after relocation. The private GitHub repository has been created, `main` pushed, and the first CI run passed.

## Verification after relocation

Repeated from `Documents/projects/steward` on 2026-09-06 UTC (2026-09-05 local):

- `npm run verify`: exit 0; TypeScript and all 25 tests passed.
- `npm run verify:recovery`: exit 0 and `ok: true`. Receipt run `2026-09-06T02-40-01-234Z-5157ec` restored the deleted output/receipt with 0 provider reruns. Network run `2026-09-06T02-40-15-181Z-e067d5` exhausted 2 attempts, accepted `retry_same_session`, and reran 0 completed siblings. These simulated test runs used temporary storage that the harness cleaned up.
- Reloaded the separate server preview at `http://127.0.0.1:4431`: title `Steward · Workflow console`, icon loaded, 18 existing run projections visible, Board/Dark and Review/Light selectable. The settled Light theme used a light selected-run background and readable graph nodes. No browser console errors. No run or human command submitted.
- Saved Codex project path update remains manual because available tools cannot edit it and Codex blocks automation of its own UI.

## GitHub publication verification

The private [bharath2020/steward](https://github.com/bharath2020/steward) repository uses default branch `main`; GitHub template mode is disabled. The first [CI run, 34008856686](https://github.com/bharath2020/steward/actions/runs/34008856686), passed for commit `aef81c2c6be1047cd1225b4e3f39ab96fb44f100` on 2026-09-06 UTC (2026-09-05 local):

- Verify (Node 22): passed.
- Verify (Node 24): passed.
- Simulated recovery (Node 24): passed.

The 67 tracked project files exclude runtime data and local credentials. No GitHub release or version tag was created; the package and README identify the starting version as `0.1.0`.
