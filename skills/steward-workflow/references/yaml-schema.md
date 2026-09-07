# Steward V1 authoring schema

Verified against `src/definition.ts`, `src/resolver.ts`, `src/loop.ts`, and `src/workflows.ts` in Steward. The installed runtime loader remains authoritative. This reference is an authoring guide, not a separately enforced JSON Schema. Unknown fields may be ignored by the current parser, so successful parsing alone does not establish that a requested feature exists.

## Document

Required: `version: 1`, nonempty `name`, and a nonempty `nodes` mapping keyed by node ID. IDs begin with a lowercase letter and then contain lowercase letters, numbers, `_`, or `-`. Optional `description` is text.

Optional `defaults`:

| Field | Allowed values | Default |
| --- | --- | --- |
| `provider` | `simulated`, `codex` | `simulated` |
| `max_parallelism` | Positive integer | 4 |
| `retry.maximum_attempts` | Integer 1–5 | 2 |
| `delay_ms` | Nonnegative number; simulation pacing | 1200 |

Optional `groups` is a mapping of IDs to optional `title`, `description`, and positive integer `max_parallelism`. Nodes may set `group` to a declared ID. Groups organize/cap work; they are not nested execution scopes.

## Agent node

`kind: agent` is the default. Required: exactly one nonempty `prompt` or `prompt_file`, and a nonempty `outputs` mapping. Optional: `title`, `agent` (provider override), `group`, `needs` (list of predecessor IDs), `inputs` (mapping), `loop`, `for_each`, `demo_output`, `demo_outputs`, `delay_ms`.

Each `outputs` value is one of `string`, `number`, `boolean`, `object`, `string[]`, `number[]`, `boolean[]`, or `object[]`. All declared keys are required and extra top-level output keys are rejected. `object` and `object[]` do not enforce a nested object schema. Describe nested expectations in the prompt, without claiming runtime enforcement.

`prompt_file` resolves relative to the YAML file, must contain nonempty UTF-8 text, and is loaded and hash-bound before start. Use the file-aware loader for validation. Prompt strings are literal instructions; they do not interpolate references. Inputs are supplied separately to the worker.

Simulation fixtures must match the outputs. `demo_outputs` supplies per-iteration or per-item fixtures; `demo_output` supplies one fixture. Fixtures do not run the real prompt or demonstrate real provider quality.

## Bindings and graph

- `$input` binds all initial JSON input; `$input.topic` binds an object field.
- `$nodes.plan.output` binds an entire predecessor result; `$nodes.plan.output.summary` binds an output field.
- References resolve recursively within input objects/arrays, but only when the whole string is a reference. `"Review $input.topic"` is literal text.
- Dot paths traverse object fields, not array indexing. Consume a mapped result as a whole array or pass it into another `for_each`.
- Put each referenced predecessor in `needs` (or `depends_on`, never both). Scope workflows validate reference context and declared output keys before starting. Existing transitive-ancestor references remain valid when the declared dependency chain ensures that ancestor has committed; listing the source directly is the clearest authoring convention. Nested object paths still require runtime values.
- Graphs must be acyclic, with no missing dependencies or self-dependencies. Independent ready nodes can run concurrently; dependencies define ordering.
- Do not use expressions, `${...}` templates, implicit array fan-out, nested `parallel`/`steps`, shell nodes, conditional branches, or proposed V2 envelopes.

## Human node

Use `kind: human`, a nonempty `question` (literal string or entire node-output reference), optional `needs`, `title`, and `group`. Its output is always `{answer: string}`; consume `$nodes.choice.output.answer`.

Omit `inputs`, `outputs`, `prompt`, `prompt_file`, `loop`, and `for_each`. Put multiple-choice options inside the question string; there is no structured `options` field. Answers are free text, not enforced enum choices. A human node waits for an answer; it does not automatically branch or authorize external actions.

## Bounded loop

An agent `loop` repeats one node; use a scope loop below for a multi-step subgraph:

```yaml
loop:
  max_iterations: 3
  carry_as: previous_output
  until:
    path: ready
    operator: equals
    value: true
  on_exhaustion: fail
```

`max_iterations` is 1–20 (default 3). `carry_as` defaults to `previous_output`; it supplies the previous result starting on iteration 2. `__iteration` is supplied by the runtime. Avoid colliding input names. The `until.path` is relative to this node's output, without `$nodes` or `output` prefixes.

Predicates can compose with `all: [predicate, ...]`, `any: [predicate, ...]`, or `not: predicate`. Lists must be nonempty. Every operand must be valid; missing or invalid operands fail explicitly.

Operators: `equals`, `not_equals`, `greater_than`, `greater_than_or_equal`, `less_than`, `less_than_or_equal`, `contains`, `truthy`. Use `value` except for `truthy`. `on_exhaustion` is `fail` (default) or explicit `accept_last`. Prefer scalar predicates and declare the predicate field in `outputs`.

## Array fan-out

Agent-only `for_each` runs one invocation per source-array item:

```yaml
for_each:
  items: $nodes.plan.output.tasks
  as: task
  max_parallelism: 2
```

`items` references `$input`, `$input.path`, a declared predecessor array output, or a mapped predecessor's complete `.output`. The referenced value must actually be an array. `as` starts with a lowercase letter and contains lowercase letters, numbers, or underscores; it must not collide with `inputs`. The alias is an injected input key, not a `$task` expression. `max_parallelism` is a positive integer (default: workflow cap); workflow and group caps also apply.

`outputs` describes each item result. The mapped node publishes a source-ordered array of those objects only after every item succeeds. An empty source publishes `[]`; a failed item prevents successful aggregate completion. A downstream join uses `$nodes.review.output` and `needs: [review]`. `for_each` and `loop` cannot coexist on a node; human nodes support neither.

## Executable scope and repeat

`kind: scope` requires nonempty `nodes` and `outputs` mappings, and accepts `inputs`, `needs`/`depends_on`, `title`, and `loop`. Assign named `group` limits to leaf agents; scopes do not accept `group`. Scope `outputs` maps exported names to bindings, unlike agent `outputs`, which declares types. A scope without a loop runs once. It consumes no provider permit; its leaf agents share workflow and applicable concurrency caps.

Inside a scope, `$input` means that scope's resolved inputs, `$nodes` means sibling results, and `$state` means the nearest enclosing loop's state. Outside consumers can read only the scope's exported output. A non-loop scope inherits enclosing state; a nested loop owns independent state.

Scope `loop` requires explicit `max_iterations` (1–20) and supports `initial` and `next` mappings, `until`, and `on_exhaustion`. Both state mappings default to empty; when state is declared, `next` must provide exactly the keys of `initial`. `initial` resolves against local `$input`. `next` resolves against local `$input`, current `$state`, and `$output` (the current iteration's exports). Do not set `carry_as` on a scope.

The scope runs at least once, waits for all children, commits exports, and then evaluates `until`. A false condition repeats the complete graph with the next state; a terminal accepted result releases dependents. Parallel success flags must both be true in the same iteration. Provider failures follow recovery rules; they are not ordinary false results. Exhaustion fails by default; explicit `accept_last` produces a distinct exhausted outcome.

Scopes nest to eight levels. Runtime expansion is capped at 1000 step instances. Each instance retains its full enclosing iteration path, including distinct human request identities. `demo_outputs` on an agent without its own loop selects fixtures using the nearest enclosing repeat iteration; these are simulation examples only.

See [parallel review loop](../assets/scope-loop.yaml) and its [input](../assets/scope-loop-input.json) for review → parallel group → both succeed → next agent.


## Provider sessions across scope iterations

Set `loop.agent_sessions: resume` on a repeated scope to continue each leaf agent's recorded provider conversation across that scope's iterations. Omission and explicit `fresh` start a fresh conversation for each new scope iteration. Existing retries and a leaf's own single-agent loop keep their existing behavior.

```yaml
loop:
  max_iterations: 3
  agent_sessions: resume
  initial:
    feedback: ""
  next:
    feedback: $output.feedback
  until:
    path: approved
    operator: equals
    value: true
```

`agent_sessions` accepts only `fresh` or `resume` and is allowed only on scope loops. Resume does not replace `initial`, `next`, or explicit input bindings: those remain the workflow's data contract, while the provider conversation supplies prior context. Changed iteration inputs are expected.

Each descendant leaf owns its own session; parallel siblings never share. Mapped work is keyed by its source position, so preserve item ordering when that position is intended to represent the same ongoing conversation. A non-loop scope propagates its enclosing repeat policy. A nested repeated scope establishes its own policy, defaulting to fresh, and its session map resets on every new outer activation. It can independently opt into resume within that activation.

The first encounter starts fresh. If a completed turn supplies no session ID, a later encounter explicitly records a fresh start (`node.session`, `action: fresh`, `reason: no_recorded_session`). Recorded sessions bind the actual provider and canonical local workspace; a mismatch refuses provider execution and requires recovery. Session identity travels in hash-bound receipts, Temporal Activity results, heartbeat checkpoints, and recovery metadata. This is local session continuity, not portability across workspaces or machines.

A resume failure does not silently switch to a new conversation. Existing operator recovery choices apply; a successful explicit `retry_fresh_session` replaces the affinity used on subsequent iterations. No new permissions or provider guarantees are implied.

See [parallel review with session continuation](../assets/scope-loop-resume.yaml) and [input](../assets/scope-loop-resume-input.json). The example defaults to simulation; live provider behavior requires separate execution evidence.
