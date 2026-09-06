# Steward control-plane contract

When the user asks to run or resume a workflow, the main Codex thread is a control plane only.

- Validate the requested YAML and initial input, start or inspect the durable runtime, and report evidence from persisted artifacts.
- Do not answer any workflow node's domain prompt in the main thread.
- Do not invent or reconstruct missing worker outputs. A node is complete only when its schema-valid output artifact is committed.
- Fan-in nodes may start only after every declared dependency has a committed output.
- Preserve `runtime/temporal.db` and `runtime/runs/` across restarts unless the user explicitly asks to remove them.
- A process exit, terminal message, or callback is not completion by itself; reconcile it with Temporal history and the run's artifacts.

Codex processes launched by `src/activities.ts` are bounded worker agents. They may perform only the node prompt they receive and must return the declared JSON output.

## Design alignment for future changes

- Before substantive product or architecture changes, read `docs/vision.md`, the applicable records in `docs/decisions.md`, and the relevant sections of `docs/technical-design.md` and `docs/production-roadmap.md`.
- Use `docs/software-architecture.md` to identify the owning module, its interfaces, and allowed dependencies before changing responsibilities or extracting code. Keep graph decisions, provider execution, and accepted-output commits with their declared owners.
- The vision governs product scope, adopted decisions govern architecture, the technical design governs target contracts, and the roadmap governs delivery order and release evidence. `docs/architecture.md` describes current behavior; the CLI specification supplies subordinate command/UI/language detail.
- Preserve existing V1 YAML, human-input workflows, and supported Temporal histories. A target document is not evidence that its proposed capability is implemented.
- Identify the user outcome and applicable decision IDs in substantive change descriptions. Record a superseding decision for changes to language semantics, public contracts, storage authority, execution or permission boundaries, or durability claims. Routine implementation within an adopted decision needs no additional approval or decision record.
- Update affected current-state documentation and record relevant validation evidence with the change. Never mark a release gate passed from prose, worker status, or an unverified subprocess success message.
