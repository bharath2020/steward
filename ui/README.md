# Steward Console templates

Steward Console is the browser UI served by Steward Server, alongside the separate Steward CLI. It is one browser application with shared component templates, two selectable layouts, and three theme choices. UI preferences affect presentation only; they do not submit workflow commands or change accepted outputs.

## Files and ownership

| File | Owns |
|---|---|
| `brand.json` | Approved Steward display name, tagline, and page description. |
| `templates/shell.html` | The shared document and component slots. |
| `templates/components/` | Toolbar, run navigation, graph, inspector, and timeline markup. |
| `assets/layouts.css` | Board and Review composition plus responsive behavior. |
| `assets/themes.css` | Semantic color tokens and shared component theme rules. |
| `assets/styles.css` | Base component styling and restrained motion. |
| `assets/appearance.js` | Browser preferences, system-theme resolution, and keyboard policy. |
| `assets/graph-layout.js` | Measured text wrapping, dependency layers, and graph node geometry. |
| `assets/human-input.js` | Choice-question presentation, accessible answer controls, and answer serialization. |
| `assets/app.js` | Shared snapshots, graph, inspector, timeline, and operator actions. |
| `assets/icon.png` | Generated project mark, shared by the header, favicon, and README. |

Steward Server composes the Console shell through [`src/server/templates.ts`](../src/server/templates.ts). UI resources resolve relative to that module, so their location does not depend on the selected workflow's working directory. Requests can fetch only explicitly registered assets; template names and paths are never taken from request input.

## Layouts and themes

**Board** puts the workflow graph between run navigation and the inspector, with a horizontal audit timeline below. **Review** puts the graph above a larger inspector and a vertical timeline. The same DOM components remain mounted when switching, preserving draft answers and node selection.

**Dark** and **Light** use shared semantic tokens. **System** follows the operating system's color preference, including changes while the page is open. The browser stores `{layout, theme}` under `agent-workflow:appearance:v1`; invalid or unavailable preferences fall back to Board and Dark. Preferences are applied before the first paint. Reduced-motion settings remain respected.

## Customize a component

Edit its HTML under `templates/components/`. Shell includes use `{{> component}}`; text fields use escaped `{{brand.name}}`, `{{brand.tagline}}`, and `{{brand.description}}`. Templates are repository-authored static fragments; they do not execute expressions or arbitrary code. Unknown tokens fail instead of being silently rendered.

Preserve the mount-point IDs used by `assets/app.js`, with each ID appearing exactly once. Both layouts share the same event handlers and API contract. A template must not decide dependency readiness, output acceptance, or recovery eligibility.

To add a layout, add its CSS rules under a distinct `data-layout` selector, expose its option in the toolbar, and add it to preference normalization and tests. To add a theme, define semantic tokens and extend the toolbar/preference contract. Register any additional static resources in the server's explicit asset map.

## Verify

```sh
npm run verify
npm run dashboard
```

The dashboard command starts only Steward Server and serves Steward Console. It can display retained run artifacts without starting a new workflow. Browser verification should cover both layouts and themes, mobile width, appearance persistence after reload, and unsent input surviving a switch. Typing `r` in an editable field must not create a run.

The approved display name preserves compatibility with existing `YAMLFLOW_*` settings, `yamlflow-` workflow IDs, Temporal task queue/workflow types, and schema identities. Console preferences retain the `agent-workflow:appearance:v1` browser storage key.

## Icon provenance

The icon was generated with the built-in image generation tool for this repository on 2026-09-05. Its reusable prompt is in [icon-prompt.txt](icon-prompt.txt). It is a visual identity asset, not evidence of workflow behavior.

## Human answer controls

The console renders the explicit V1 example format as native radio options:
`Question? A) First choice; B) Second choice; C) Third choice. Reply A, B, C, or your own answer.`
It recognizes two to six consecutive labels beginning at A, separated by
semicolons, with the matching reply instruction. Ambiguous or ordinary questions
retain a labeled text field. Agent text is rendered with `textContent`.

No option is selected automatically. **Write my own answer** reveals a required
text field. Selecting an option does not submit it: **Submit answer** sends the
letter or custom text through the existing string-answer API. Pending submissions
disable the form; rejected submissions retain its draft for retry. Drafts are
scoped to the run and request and survive inspector navigation and SSE refreshes
in the current page, but are not saved across page reloads.

This is presentation work under ADR-009 and ADR-010; the YAML language, Temporal
history, human request records, and command payloads are unchanged. Existing
waiting example runs gain these controls after the console is refreshed.

## Graph layout

Node columns size to their titles, with up to three wrapped lines and full-title
hover/accessibility text. Long phase/group/loop labels are ellipsized to their
available width. JOIN counts have reserved footer space. Edges, group bounds,
and loop circuits use the same measured boxes as the nodes. Status changes update
labels within those bounds instead of moving the graph during execution.

The initial view fits available space down to 80% and never enlarges nodes beyond
actual size. Larger graphs scroll inside the graph panel. **Fit** shows the full
graph, **− / +** adjusts zoom, and the percentage button restores 100%. Resizing,
zooming, and changing appearance preserve the selected node and answer drafts.
This is presentation under ADR-009/ADR-010; it does not schedule workflow work.
