# Workflow authoring validation — 2026-09-06

User outcome: describe and refine a Steward V1 workflow in a left-side agent chat and receive immediate, detailed SVG topology feedback without granting model output execution authority.

Applicable decisions: ADR-001, ADR-002, ADR-003, ADR-006, ADR-009, ADR-010, and ADR-013.

## Automated evidence

- `npm run verify` exited 0 with TypeScript passing and 59/59 tests passing.
- Authoring tests cover input/history bounds, provider selection, current-draft prompt binding, parser-gated acceptance, one bounded repair pass, invalid-result rejection, same-loopback Origin acceptance, and foreign-Origin rejection before provider invocation.
- UI composition tests cover the authoring mount points and explicit `authoring.js` asset allowlist while preserving all existing Console mount points.

## Live-provider evidence

- Codex produced a four-node release-readiness draft through `POST /api/authoring/chat`; Steward returned definition hash `8ddf92c3debe3a81805e6c8cd4d4a6d70fe79aecdcdc784c5bf74a57facbfd9c` only after the existing parser accepted it.
- A browser-submitted Codex customer-research draft initially contained invalid YAML. The parser refused it, the single bounded repair pass returned valid YAML, and the UI displayed `4 nodes · validated` with definition hash prefix `105de0239365`. The graph was rendered as preview state; no Temporal run was created.
- Claude Code produced and validated a three-node parallel-review/fan-in draft with definition hash `987da0ddd0984785b689df20bfca754518602d6a03a7c00429b15dc38a97b32a` using its installed CLI authentication and no-write authoring settings.

## Browser evidence

- The updated Console was served independently on `http://127.0.0.1:4311` while the existing local stack stayed untouched.
- At the available 596×885 in-app viewport, Build stacked chat above graph, retained every control, reported provider work immediately, replaced the empty graph only after validation, and had no page-level horizontal overflow (`scrollWidth` equaled viewport/body width at 596 CSS pixels).
- Switching Observe → Build did not start a run. Existing SSE observation remained connected while Build owned the graph surface.

## Boundaries not claimed

This evidence does not pass P2 or production gates. Drafts are not persisted, generated input is not authored, the target local session credential is not implemented, direct YAML editing is not implemented, and a generated draft cannot yet be saved or started from Build. The current test demonstrates installed Codex/Claude provider compatibility on this host, not all CLI versions or authentication configurations.
