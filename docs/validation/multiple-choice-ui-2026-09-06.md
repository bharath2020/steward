# Multiple-choice answer UI validation

Recorded 2026-09-06 UTC. User outcome: choose agent-provided options in the
console instead of typing a letter. Presentation ownership follows ADR-009 and
ADR-010. V1 YAML, Temporal execution and the string-answer API are unchanged.

## Checks

- `npm run build`: exit 0.
- `node --import tsx --test tests/*.test.ts`: exit 0, 32/32 tests passed.
- `node --check ui/assets/app.js` and `node --check ui/assets/human-input.js`: exit 0.
- `git diff --check`: exit 0.
- Browser: all three options and a custom option appear with no default selection.
  Custom input is revealed only when chosen and cannot submit empty text.
- Browser: selections and custom text survive question navigation, SSE updates,
  and Board/Review plus Dark/Light changes. A submission in flight stays disabled
  after navigating away and back. A rejected submission retains its draft.
- Isolated browser fixture: intercepted request data confirmed the selected
  letter `B` and custom text were sent to the correct run and question. The final
  fixture server has no Temporal client, does not forward requests, and rejects
  every POST. No new runtime acceptance semantics are introduced by these checks.
- Browser: 390px mobile document width has no horizontal overflow; dark, light,
  and mobile panel screenshots were inspected. The completed isolated check
  reported zero page errors. Synthetic 409 responses were expected.

Screenshots are retained locally in `output/playwright/multiple-choice/`.
Ordinary or ambiguous question prose keeps its text field; parser regression
coverage checks this fallback. Drafts persist only within the current page.

## Test incident and clean run

An earlier browser route-mocking error allowed a test answer `B` to reach
`audience_answer` in run `2026-09-06T03-40-53-854Z-3b08c9`. This was disclosed
to the user. That run and its history were preserved; no answer was rewritten.
Submission testing then moved to the isolated server described above.

A fresh simulated run, `2026-09-06T03-57-13-820Z-390631`, was started for the
user and verified at `waiting_for_human`, with both interviewer outputs committed,
all four questions unanswered, and the final brief pending. The existing dashboard
was restarted to register the new browser module; the Temporal service and
workers were preserved.
