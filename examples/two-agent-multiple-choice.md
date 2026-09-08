# Two agents with multiple-choice questions

Run two question agents in parallel. The product agent asks about audience and
priority; the technical agent asks about platform and storage. Each asks two
questions with three labeled options. The four human gates retain separate
answers, and a decision brief editor waits for all four.

```text
Product agent   -> Audience answer --+
                -> Priority answer -+
                                    +-> Decision brief
Technical agent -> Platform answer -+
                -> Storage answer --+
```

## Run

From the repository root, start the local Temporal server, worker, and console
without starting the default workflow:

```sh
npm run resume
```

Keep that terminal open. In another terminal, start this example:

```sh
npm run start -- --working-directory /path/to/repository --workflow workflows/two-agent-multiple-choice.yaml --input examples/two-agent-multiple-choice-input.json --mode simulated
```

The command prints `runId` and `workflowId`. Open
[Steward Console](http://127.0.0.1:4310), select that run, then select each waiting
human node. Its title and question identify the requesting agent. Select an option
or choose **Write my own answer**, then press **Submit answer**. The brief stays blocked until all four answers
are accepted. You can answer them in any order.

For live question generation and synthesis, use the same command with
`--mode codex`; it requires the authenticated Codex CLI. Both question roles and
the final editor use Codex. Edit the input JSON to change the brief or constraints.

## Answer from the CLI

Wait until all four human nodes show that they are awaiting input in the console.
The start command returns before agents finish; submitting an answer before its
question exists is rejected. Set the run ID printed by the start command, then
submit each answer separately. These selections are an illustration for the
supplied simulated questions:

```sh
QUESTION_RUN_ID='<runId printed by start>'
npm run answer -- --run "$QUESTION_RUN_ID" --request "${QUESTION_RUN_ID}:audience_answer:human" --answer 'C'
npm run answer -- --run "$QUESTION_RUN_ID" --request "${QUESTION_RUN_ID}:priority_answer:human" --answer 'B'
npm run answer -- --run "$QUESTION_RUN_ID" --request "${QUESTION_RUN_ID}:platform_answer:human" --answer 'A'
npm run answer -- --run "$QUESTION_RUN_ID" --request "${QUESTION_RUN_ID}:storage_answer:human" --answer 'B'
```

Read the generated questions before answering a live run: its choices can differ
from the fixtures. A custom response such as `A, with offline support` is also
accepted.

## Expected result and current limits

- Simulated mode uses the YAML's four fixed question fixtures, with real durable
  human waits. Its final `decisions` object echoes the resolved inputs, including
  the actual submitted answers. It does not perform AI synthesis.
- Codex mode generates questions from the brief and writes a decision brief using
  all four answers. Its prompt preserves custom answers and reports ambiguous or
  conflicting choices as unresolved tradeoffs.
- The console recognizes this example's explicit question format and presents
  radio choices plus **Write my own answer**. It sends the selected letter or
  custom text through the existing V1 string-answer API. Unrecognized question
  formats retain a text field. The runtime checks nonempty answers; it does not
  enforce A/B/C membership or the prompt's three-choice rule.
  Each human node represents one question. This example uses one fixed batch of
  four questions; it does not implement dynamic follow-up batches.
- The run's `runtime/runs/<runId>/state.json` and `events.jsonl` contain the human
  requests and accepted answers. Interviewer and final editor outputs are in
  `nodes/<nodeId>/output.json` with completion receipts. The current human path
  records `{answer}` through events and does not write an agent completion receipt.
