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
- Put each referenced predecessor in `needs`. Check ordinary references manually; the loader currently checks declared graph edges and fan-out references more thoroughly than ordinary input references.
- Graphs must be acyclic, with no missing dependencies or self-dependencies. Independent ready nodes can run concurrently; dependencies define ordering.
- Do not use expressions, `${...}` templates, implicit array fan-out, nested `parallel`/`steps`, shell nodes, conditional branches, or proposed V2 envelopes.

## Human node

Use `kind: human`, a nonempty `question` (literal string or entire node-output reference), optional `needs`, `title`, and `group`. Its output is always `{answer: string}`; consume `$nodes.choice.output.answer`.

Omit `inputs`, `outputs`, `prompt`, `prompt_file`, `loop`, and `for_each`. Put multiple-choice options inside the question string; there is no structured `options` field. Answers are free text, not enforced enum choices. A human node waits for an answer; it does not automatically branch or authorize external actions.

## Bounded loop

Agent-only `loop` repeats one node, not a multi-step subgraph:

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
