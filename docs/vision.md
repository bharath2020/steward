# Steward vision

Status: adopted direction for future implementation. Last reviewed: 2026-09-05.

Steward makes multi-step agent work something a developer can define, inspect, and recover with confidence. A workflow declares the work, its dependencies, its boundaries, and the evidence required to finish. The operator can leave and return without losing the run or guessing what happened.

The product promise is: **declare the work once, understand its progress, and recover from durable evidence.** Repeating a plan means repeating its execution rules; it does not promise identical model responses.

## Who we serve first

Start with developers who already use coding agents and need repeatable workflows across analysis, review, synthesis, and human decisions. They are comfortable with a repository and terminal, but should not need to write Temporal code, inspect provider protocol logs, or manually reconstruct failed handoffs.

The initial direction follows the existing CLI proposal: a local developer experience, then a deployment for one trusted team. It is a product sequencing decision, not evidence of customer demand. Validate it with real pilot workflows before expanding the audience.

The author describes intent and output contracts. The operator starts runs, supplies requested answers, and handles recovery. The maintainer evolves the language, executors, and runtime while keeping old work recoverable. One person may hold all three roles.

## The experience we are building

1. Author YAML directly or use an authoring agent that produces reviewable YAML and example input.
2. Validate input, dependencies, permissions, and limits without starting a provider or runtime.
3. Preview the compiled graph and effective policy, then start one durable run.
4. See which steps are working, waiting, complete, or blocked, with readable messages and inspectable outputs.
5. Detach, close the terminal, or lose the dashboard; execution remains owned by the runtime.
6. Return to the same run. Answer a human gate or recover the affected step through a durable command.
7. Export the final result with its plan, input, accepted output hashes, and execution provenance.

For example, a repository review can run independent analyses, wait for their committed findings, ask the operator a question, and produce a final review. A failed analysis should leave successful sibling results intact. The coordinator must never fill a missing result by answering the analysis prompt itself.

## Product principles

| Principle | Consequence for a feature |
|---|---|
| Evidence before completion | A success indicator requires accepted output evidence and reconciled execution status. A process exit or agent message is insufficient. |
| Explicit intent | YAML and policy expose dependencies, retry limits, loop limits, executor choice, and requested capabilities before execution. |
| Recovery is a normal operation | A failure must identify the affected work and supported actions. Reattach, retry, cancel, and start fresh have distinct meanings. |
| One execution model | CLI, TUI, web, and authoring integrations use the same contracts and control service. |
| Permission stays with the operator | A prompt, workflow, dependency result, or executor cannot grant itself additional authority. |
| Compatibility is part of durability | A release must preserve existing definitions, artifacts, and open histories or provide an explicit, tested migration. |
| Bounded work | Every loop, retry sequence, payload, and provider process has an enforced limit. Resource use is visible. |
| Complexity earns its place | Prefer one package and clear internal interfaces until deployment or ownership evidence requires a split. |

## Scope and sequence

**Developer preview:** installable CLI, validation and planning, simulated and Codex executors, the existing DAG/loop/human-input behavior, recovery, transactional local evidence, default TUI, and optional local dashboard. Local development infrastructure carries an explicit same-host durability boundary.

**Production for one team:** the same contracts with a production Temporal service, external artifact storage, a transactional shared evidence store, service identity, authenticated control, independently supervised workers, bounded history, monitoring, and tested restore/upgrade procedures. Passing the developer preview gate does not authorize a production durability claim.

**Later, when justified:** richer nested control blocks, more executors, portable sessions, and explicitly governed write operations. Hierarchical language work is separated from the first hardening release so it cannot hold basic correctness fixes hostage.

ADR-022 brings forward bounded local workspace writes for coding/build workflows: every new run names its repository explicitly. Broader external effects and portable sessions remain later work.

Public multi-tenant SaaS, billing, an executor marketplace, arbitrary workflow code, unrestricted autonomous repository changes, dynamic unbounded graphs, and promises of exactly-once external effects are outside the initial scope. New scope needs a concrete user problem and a decision record explaining the added operating burden.

## How we measure progress

These are initial pilot goals, not measured results or service commitments:

| Outcome | Measurement and initial gate |
|---|---|
| A developer reaches a useful run | At least 4 of 5 pilot users install, validate, and finish the simulated tutorial in 15 minutes without maintainer intervention. |
| Recovery preserves work | Every release fault scenario preserves accepted output hashes and schedules no provider work for already accepted steps. |
| Status is trustworthy | Zero false successful runs, duplicate accepted results, or silent integrity failures in the release gate. |
| The interface is understandable | At least 4 of 5 pilot users correctly identify a blocked step and choose the intended recovery action from the UI alone. |
| Execution is inspectable | Every successful release-test run exports a verifiable result manifest and complete supported provenance. |

Record retry count, operator interventions, time waiting for workers, and provider usage when available. Unknown provider cost must be shown as unknown. Provider task quality is measured separately from orchestration reliability.

## Keeping future changes aligned

Read the [decision register](decisions.md) before changing architecture. The [technical design](technical-design.md) defines the target contracts; the [production roadmap](production-roadmap.md) defines the evidence required to ship them. The [current architecture](architecture.md) describes implemented behavior.

Every substantive change should identify the user outcome it improves, the decisions it follows or supersedes, compatibility and permission effects, and its validation evidence. Routine implementation within an adopted decision does not need a new decision record. A new language semantic, storage authority, execution boundary, durability claim, or public contract does.

A change is aligned when it makes declared work easier to understand or recover while preserving the existing evidence and permission guarantees. Product scope expands after that claim is demonstrated in a real workflow.
