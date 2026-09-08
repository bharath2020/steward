# Adaptable examples

- [Review, human choice, and summary](../assets/review.yaml) with [input](../assets/review-input.json): parallel analysis, explicit fan-in, and an operator question.
- [Queued fan-out](../assets/fan-out.yaml) with [input](../assets/fan-out-input.json): task array, bounded mapped work, and ordered aggregation.
- [Bounded refinement](../assets/loop.yaml) with [input](../assets/loop-input.json): a single node repeats until its declared output predicate passes.

- [Parallel review loop](../assets/scope-loop.yaml) with [input](../assets/scope-loop-input.json): review leads to a nested group of two parallel agents; the whole scope repeats until both succeed in the same iteration, then releases the next agent.

- [Parallel review with session continuation](../assets/scope-loop-resume.yaml) with [input](../assets/scope-loop-resume-input.json): the same scope graph opts into a separate ongoing conversation for each parallel leaf; explicit loop state still carries the data.

Examples select simulation explicitly. Change `defaults.provider` to `codex` for real agent execution when requested, and explicitly select `--mode codex --working-directory /path/to/repository` at start. New runs permit workspace writes; validation and authoring do not grant execution authority. Validation does not run either provider.
