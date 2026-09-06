# Workflow graph layout validation

Recorded 2026-09-06 UTC. The graph now sizes cards from measured title text,
wraps titles to at most three lines, and uses the resulting bounds for groups,
connectors and loop paths. Long secondary labels truncate with full-text tooltips.
JOIN counts have reserved footer space. The graph defaults to a readable scale;
Fit and zoom controls adjust the canvas within its scrolling panel.

The change belongs to presentation under ADR-009 and ADR-010. The YAML contract,
Temporal workflow and string-answer API are unchanged.

## Verification

- `npm run build`: exit 0.
- `node --import tsx --test tests/*.test.ts`: exit 0, 38/38 tests passed.
- Six graph-layout regression tests cover fan-out/fan-in bounds, measured widths,
  long titles and unbroken tokens, ellipsis, loop extents, reversed definition
  order, and empty graphs.
- `node --check ui/assets/app.js`: exit 0.
- `git diff --check`: exit 0.
- Playwright: 24 combinations of the question workflow, a workflow with a loop,
  and a long-label stress fixture; Board/Review views; and viewport widths
  1770, 1024, 900 and 390 pixels. Every combination passed text containment,
  group-heading containment, JOIN separation, loop bounds and document-width
  checks, with zero page errors.
- Fit confines the whole graph to the available panel. Custom-answer drafts
  survive graph zoom, layout changes and resizing.
- Board at the default readable scale and Review with Fit were visually checked
  after finite entrance animations completed. Screenshots are retained locally
  in `output/playwright/graph-layout/`.

Browser regression checks ran on an isolated static-snapshot server with no
Temporal client. It rejects every non-GET request. The live dashboard was then
restarted to register the graph asset and checked read-only. Run
`2026-09-06T03-57-13-820Z-390631` remained `waiting_for_human`, with two of seven
nodes complete. No human answers were submitted during this layout work.
