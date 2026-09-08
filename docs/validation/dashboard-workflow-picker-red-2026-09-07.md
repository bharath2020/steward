# Dashboard workflow picker: RED end-to-end evidence

Date: 2026-09-07. Test owner: session_resume_tests subagent. Scope: tests only; no feature implementation or adopted API decision.

The suite ran against an isolated real Temporal service, worker and dashboard server, with headless Chromium rendering the actual dashboard. Result: exit 1, **one healthy baseline passed and six feature scenarios failed**. Node also counts the failed parent, producing aggregate totals of 8 tests, 1 pass, 7 failures, zero skips. [Captured output](dashboard-workflow-picker-red-2026-09-07.txt).

Exact executed command:

```sh
STEWARD_PLAYWRIGHT_MODULE=/Users/bharath2020/.npm/_npx/e41f203b7505f1fb/node_modules/playwright node --import tsx --test tests/e2e/dashboard-workflow-picker.test.ts
```

The initial sandbox-only attempt could not bind localhost and was not counted as feature RED. The command above was rerun with approved escalation for isolated local services and Chromium. Playwright and its compatible Chromium were already installed. The test resolves `playwright` normally, or the existing module directory supplied by `STEWARD_PLAYWRIGHT_MODULE`; it does not install dependencies or launch a paid provider. A machine without Playwright/Chromium must supply them before reproducing browser evidence. No package/dependency files were changed. The new file is included by `npm run test:e2e`, so that command intentionally remains red pending the feature (and needs the browser prerequisite).

## What actually executed

| Scenario | Observed result |
|---|---|
| Existing configured-workflow HTTP start | Passed: real Temporal completed Alpha, input persisted, simulated receipt hashes and accepted output matched, zero external-provider invocations. |
| Browser chooses Beta and input | Failed at the first feature assertion: the live dashboard has no accessible Workflow picker. Starting the chosen workflow was not reached. |
| Catalog plus prepared definition/input/mode | Failed because proposed catalog endpoint returns 404. Preparation/start binding assertions were not reached. |
| Declared-provider routing | Failed because proposed prepare endpoint returns 404. The deterministic external Codex fixture is present, but declared-provider dispatch was not reached or verified. |
| Invalid JSON preflight | Failed because proposed prepare endpoint returns 404 instead of an actionable validation response. No claim that later validation behavior is implemented. |
| Unknown prepared-start intent | Failed at the actual current start boundary: POST accepted the unknown `preparedId` and started configured Alpha. The unexpected run was reconciled to completed Temporal/artifacts before failing; no test work was left running. |
| History versus draft selection | Failed because the picker does not exist; later history/draft preservation assertions were not reached. |

The proposed endpoints, field names, catalog file format, mode spelling and accessible UI labels are isolated in the test header/contract object. They are acceptance assumptions derived from the feature report, not adopted public contracts: `YAMLFLOW_CATALOG`, `/api/workflows`, `/api/runs/prepare`, `preparedId`, `startId`, and `mode: workflow`. Review or implementation may refine their spelling. Unknown intent is required to produce an actionable 4xx response; HTTP 500 cannot satisfy that assertion.

## Retained evidence and limits

- Durable isolated evidence: `/var/folders/1c/wkzr1t1945v0tg_882wwqshh0000gn/T/steward-cli-e2e-pLCI6D`
- Actual browser screenshot: `/var/folders/1c/wkzr1t1945v0tg_882wwqshh0000gn/T/steward-cli-e2e-pLCI6D/dashboard-before-picker.png`
- Test: `tests/e2e/dashboard-workflow-picker.test.ts`

The screenshot was visually inspected and shows the completed Alpha run with the existing Runner/Pace/Run again controls and no workflow picker. Fixtures and provider processes were restricted to disposable runtime paths. The existing runtime database, workflows, source implementation, user-installed skills and credentials were not changed. The baseline and accidental legacy fallback were simulated only.

This is a bounded initial RED suite, not full feature qualification. Remaining slices include prepared source/prompt mutation, preview invalidation after edit, repeated/lost-response start identity, authorized path boundaries, nested/map declared-provider routing, and new-run-from-history independent session state. Those need an adopted prepared-start/catalog contract and an implementation before they can provide meaningful end-to-end evidence.
