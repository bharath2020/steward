# Steward production roadmap and release gates

Status: implementation plan; no phase is marked complete by writing these documents. Date: 2026-09-07.

The [vision](vision.md) sets product scope, the [decision register](decisions.md) explains architectural choices, and the [technical design](technical-design.md) defines target behavior. The older CLI proposal supplies detailed UI/language examples; the sequence below replaces its packet order and single large MVP milestone.

The [software architecture](software-architecture.md) assigns module ownership and interface boundaries for these slices. P1 includes checks for allowed imports and public contracts in new modules; introducing folders alone does not pass that gate. Presentation work consumes interpreter-reported loop outcomes rather than reimplementing predicates.

## Delivery sequence

Each phase produces a usable vertical slice and retained evidence. Owner labels are responsibilities, not assigned people. The repository maintainer assigns a concrete owner before implementation; production promotion additionally needs an operational owner and release owner.

| Phase | Outcome and work | Exit evidence | Owner |
|---|---|---|---|
| P0 — protect the current runtime | Harden the single current interpreter. Diagnose and fix human/final artifact coverage, receipt recovery collisions, stale status, accidental keyboard starts, always-on HTTP control, and duplicate start behavior. | Human output/final manifest verification; corrupt-receipt fresh recovery; lost-start-response deduplication; input typing causes zero starts; closed Temporal executions expose no live recovery controls. | Runtime + interface maintainers |
| P1 — contracts and durable foundation | Publish contract fixtures, compiler for existing semantics, input/reference validation, separate semantic/provenance hashes, evidence/artifact interfaces, transactional local backend, common ControlPlane, bounded DAG execution, history bounds, attempt isolation and cancellation. | Both valid/invalid fixtures; stable hash tests; multi-process duplicate/late commit races; accepted-answer restart; history rollover; active-sibling cancellation; current-interpreter replay. | Contracts + runtime + storage maintainers |
| P2 — installable developer preview | Emit distributable JavaScript, package schemas/assets, implement CLI/profiles/doctor/supervision, TUI for existing graph/loop/human semantics, optional safe dashboard, cursored events, and tutorial. | Install actual package in clean unrelated directories; validate/plan offline; run/detach/attach/answer/recover/cancel/status/export; compact TUI and browser checks; five-user pilot against vision measures. | Product interfaces + release owner |
| P3 — production for one team | Add external production Temporal profile, PostgreSQL and object storage adapters, operator/service identity, session placement policy, retention/backups, observability, deployment and rollback automation. | Full production fault/restore matrix; two-worker concurrency; loss of a worker host; authenticated control/artifact access; measured operating targets; deployment canary and rollback. | Platform/operations + security + release owner |
| P4 — richer workflow authoring | Add new nested group/parallel/multi-step-loop language, scope exports, migration tooling, and authoring skill. Keep existing human gates. Child workflows and richer approval syntax remain separate proposals. | Nested-scope semantic fixtures, bounded expansion, no partial fan-in, renderer agreement, failure/continuation tests for nested scopes. | Language + runtime + interface maintainers |

ADR-019 authorizes an early bounded P4 scope/repeat slice with red-first end-to-end tests. ADR-020 adds explicit per-agent session continuation within repeated scopes, retaining fresh sessions by default and requiring independent session-isolation/recovery evidence. This does not pass the full P4 gate or bypass the remaining compiler, evidence-store, continuation, migration, and production qualification work.

P4 can be explored independently after P1 contracts settle, but is not a prerequisite for qualifying the existing workflow model. Multi-tenant hosting, writable executors, new provider integrations, and a marketplace need separate decisions and gates.

ADR-022 authorizes the bounded local workspace-write executor slice with mandatory repository binding and red-first end-to-end evidence. It does not qualify transactional external effects, descendant-process recovery, shared production execution, or the broader P1–P3 gates.

The portable V1 authoring skill (ADR-018) is available ahead of P4 with current-language examples and offline loader validation. It does not implement the proposed nested language or establish that the P2/P4 release gates pass.

## First implementation slice

Start with a human-input workflow and one simulated agent consuming its answer. Add a versioned shared commit path, a final result manifest, and reconciliation that distinguishes accepted output from Temporal completion. Prove worker restart after answer acceptance, projection deletion, and duplicate answer submission on the current Workflow type.

Then address dispatch-scoped receipt storage and a lost-response start retry. These slices exercise the most important contracts before the package, TUI, or new language depends on them. Parallelize contract fixtures, interface regression tests, and storage contract tests only after their shared interfaces are fixed.

## Required fault and compatibility evidence

| Scenario | Required invariant |
|---|---|
| CLI or browser death | Same Workflow identity remains active; reattach does not start or retry it. |
| Start accepted but response lost | Same command/payload returns the original run; conflicting reuse rejects. |
| Worker killed before/after receipt commit | Accepted result is reused; before-commit provider repetition is identified rather than hidden. |
| Duplicate/late Activity attempts across two processes | One accepted output per logical step iteration; fenced attempt cannot replace it. |
| Corrupted receipt followed by operator recovery | Integrity failure is visible; old evidence is retained; a permitted new dispatch has a distinct path. |
| Human/recovery Update repeated or interrupted | Exactly one applied command; correct accepted/applied receipt; no dependent starts before output acceptance. |
| Cancel while siblings run | No new steps; active leases revoked; descendant cleanup status visible; committed siblings remain inspectable. |
| Deleted projection / truncated export / disconnected SSE | Rebuild from retained evidence, explicit corruption/gap reporting, deterministic cursors, no invented result. |
| Temporal closes before projection updates | Status reconciles to the closed lifecycle; no invalid live recovery controls or false success. |
| History continuation with pending decisions | Stable logical run, preserved pending IDs and accepted refs, no unfinished handlers or repeated accepted work. |
| Current histories on a release bundle | Supported `stewardWorkflow` histories replay; after adoption, incompatible changes introduce and retain an explicit versioned bundle. |
| Production worker-host loss | Accepted evidence survives; session availability is assessed explicitly; no claim of session portability without a passing adapter test. |
| Production restore | Temporal lineage, SQL acceptance records, and object hashes agree before writes resume; restore time/loss meet the declared envelope. |
| Unauthorized control / synthetic secret input | Denied commands cause no dispatch; credentials stay out of payloads, logs, transcripts, and exports. |

The existing `verify:recovery` script is useful local simulated evidence. It does not cover this matrix or qualify real-provider recovery. Release harnesses must retain run-bound reports instead of deleting all evidence at teardown.

## Initial operating targets

These are proposed qualification targets for a single-team deployment, not current results or contractual SLAs. Measure them with 10 active workflows, 500-step definitions where applicable, up to 16 concurrent provider Activities per run under a shared 32-Activity cap, and 10 observers. Use simulated executors for repeatable overhead measurements and a separate bounded real-provider smoke.

| Target | Qualification |
|---|---|
| Control responsiveness | p95 status reads below 500 ms; durable command acceptance below 2 seconds while dependencies are healthy. Exclude provider completion time. |
| Presentation freshness | p95 accepted-transition visibility within 2 seconds; clearly mark status stale after 10 seconds without successful reconciliation. |
| Worker recovery | Eligible unfinished work resumes within 60 seconds after a compatible replacement worker becomes ready; preserved outputs keep identical hashes. |
| Worker-host durability | Zero lost accepted results or accepted commands after loss of one worker host with production external stores available. |
| Backup restore | Initial regional/disaster target: recovery point at most 15 minutes and restore within 4 hours, demonstrated for the selected Temporal/SQL/object-store configuration. Do not claim these if any component cannot support them. |
| Resource bounds | No configured payload/history/concurrency limit exceeded; slow observers cannot cause unbounded server buffering. |

Keep provider latency, provider outages, task-quality scores, unknown usage/cost, and orchestration overhead separate in reports. A successful model response does not compensate for a failed integrity or permission gate.

## Release record and promotion

Each candidate writes a retained `release-evidence/<version>/release.json` with package and worker bundle hashes, source snapshot identity, exact runtime/provider versions, schema/migration versions, target profile, test command/exit code/results, relevant run and Temporal execution IDs, artifact/receipt hashes, replay results, load results, restore observations, known limitations, and accountable owners. This path is a proposed output contract, not an existing artifact from this documentation task.

Run the complete gate against the packaged artifact in an isolated environment. Preserve fixtures and manifests; redact credentials and synthetic/private input as appropriate. Verify CI exits zero, not merely that a subprocess printed a pass message.

Block promotion for any replay failure, wrong or missing accepted artifact, duplicate start from one command, unauthorized dispatch, secret leakage, silent projection corruption, unresolved migration incompatibility, or restore failure. Missing production evidence also blocks the production label. The developer preview may ship only with its local durability limitation clearly exposed.

Canary the candidate with new runs before broader promotion. On an integrity, permission, replay, or duplicate-start incident, stop admission immediately and retain all evidence. On sustained latency/freshness breach for five minutes under the qualified load, stop rollout and investigate. Return new starts to the last supported bundle/profile; keep compatible workers for in-flight histories. Never erase `runtime/temporal.db` or `runtime/runs/` as a rollback technique.

Before P3 promotion, settle the deployment region/provider, supported OS/Node/Codex versions, data-retention and reset windows, identity provider, cost envelope, session portability/affinity limits, incident contact, backup ownership, and the measured recovery objectives. These are deployment prerequisites, not reasons to delay P0–P2.
