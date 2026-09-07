# Adaptable examples

- [Review, human choice, and summary](../assets/review.yaml) with [input](../assets/review-input.json): parallel analysis, explicit fan-in, and an operator question.
- [Queued fan-out](../assets/fan-out.yaml) with [input](../assets/fan-out-input.json): task array, bounded mapped work, and ordered aggregation.
- [Bounded refinement](../assets/loop.yaml) with [input](../assets/loop-input.json): a single node retries until its declared output predicate passes.

Examples select simulation explicitly. Change `defaults.provider` to `codex` for real read-only agent execution when requested. Validation does not run either provider.
