# Scope Console and authoring validation

Date: 2026-09-07. This report covers presentation and authoring only; runtime qualification is recorded separately.

## Automated checks

`rtk proxy node --import tsx --test tests/scope-presentation.test.ts tests/ui-templates.test.ts tests/authoring.test.ts` exited 0: 16 tests passed. The initial sandboxed run encountered `listen EPERM` in the existing authoring HTTP test; rerunning with loopback permission passed. The new checks cover nested instance lookup, human request identity, composite predicate formatting, runtime-only outcome labels, legacy unknown outcomes, and parser acceptance of the shipped scope example.

`rtk proxy node --check ui/assets/app.js` and `rtk proxy git diff --check` passed. Offline validation of `skills/steward-workflow/assets/scope-loop.yaml` with `scope-loop-input.json` exited 0 and explicitly reported that no run started.

## Browser observations

Chrome rendered the current Console against retained real-Temporal test artifacts at `/var/folders/1c/wkzr1t1945v0tg_882wwqshh0000gn/T/steward-cli-e2e-UJU4gK`. A separate dashboard used loopback port 4397 and an unreachable Temporal address (`127.0.0.1:1`). No run, recovery, or answer command was submitted.

For run `2026-09-07T21-58-59-787Z-82b749`, the graph displayed scope `resolve` with `3 / 4 · CONDITION MET` and its downstream agent. Selecting the scope displayed six direct child instances across three iterations. Selecting `resolve~2.parallel_work` displayed its two children and the committed `{implementation: {success: false}, validation: {success: true}}` result. Selecting its validation child displayed the qualified ID, round-2 guidance, and committed `success: true`. Parent navigation returned to the containing scope. A native browser screenshot was inspected in the tool transcript; no standalone screenshot file was exported.

The human form check used a **historical projection fixture**, not a new or live run. Source: `/private/var/folders/1c/wkzr1t1945v0tg_882wwqshh0000gn/T/steward-cli-e2e-dKgv4l/runs/2026-09-07T22-05-18-208Z-3f7fd6`. Its unchanged event prefix through sequence 30 was passed through `rebuildState` into `/private/tmp/steward-scope-human-ui`; `FIXTURE.md` records provenance. No worker output was created or changed. A second isolated dashboard on port 4398, also without a reachable Temporal service, rendered the historical state.

Console automatically selected `repeat~2.group~1.gate`, displayed `AWAITING_INPUT`, the correct question, an empty answer field, and no committed output. A browser-only draft survived navigation to the parent scope and back. The answer was not submitted. A native screenshot was inspected in the tool transcript. This verifies form presentation and draft continuity, not command submission or runtime restart.

## Limits

The Build nested-detail helpers and authoring language contract have focused automated coverage; no live provider-generated nested draft was requested during browser inspection. The server's nested message snapshot omission was reported to the runtime implementation owner and fixed separately. These checks do not qualify production storage, multi-worker operation, or the full P4 milestone.
