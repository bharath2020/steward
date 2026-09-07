---
name: steward-workflow
description: Turn a workflow description into Steward version 1 YAML and example JSON input. Use when creating or editing Steward agent workflows with dependencies, human questions, loops, or array fan-out.
---

# Author Steward workflows

Produce reviewable workflow YAML and matching example input from the user's intent. Any coding agent can use this skill; the agent authoring the file is separate from the provider that will execute its nodes.

Read [the V1 schema reference](references/yaml-schema.md) before drafting. For working patterns, read [the examples guide](references/examples.md) and only the relevant linked assets. These describe the implemented V1 language, not the proposed nested language in Steward's product specification.

1. Identify the intended result, initial inputs, independent work, required handoffs, human decisions, and stopping conditions. Ask only for missing information that materially changes the graph; state reasonable assumptions.
2. Give each node a bounded assignment and explicit typed outputs. Put data references in `inputs`, not interpolated prompt text. List every referenced predecessor in `needs`, including human questions and fan-out sources. A join must depend on all work whose results it consumes.
3. Choose explicit execution providers: `codex` for real agent work or `simulated` for a demonstration. Claude or another agent can author YAML, but `agent: claude` is not supported by this runtime. Preserve the user's execution choice.
4. Write the requested YAML and sample JSON input to the user's chosen location. Use inline prompts by default. If using `prompt_file`, deliver that UTF-8 file too, with its path relative to the YAML. Do not overwrite unrelated files.
5. Validate using an available Steward checkout or installed source distribution with dependencies installed:

   ```sh
   npm --prefix /absolute/path/to/steward run validate:workflow -- /absolute/path/to/workflow.yaml /absolute/path/to/input.json
   ```

   This calls the runtime loader without starting Temporal or a provider. Fix reported errors and revalidate. Also review all node references, output paths, and dependency edges: the current parser does not exhaustively validate them or reject all unknown fields. An `object` output does not enforce nested fields. If Steward is unavailable, deliver the files with validation explicitly marked as not run; do not claim schema acceptance.
6. Return file paths, a short graph explanation, assumptions, and the actual validation result. Authoring does not itself authorize running the workflow. Start it only if requested separately or already authorized in the conversation.

Do not answer the generated nodes' domain tasks while authoring or fabricate worker results. Simulation fixtures are examples, never completed execution evidence. Prompts and human answers do not grant execution permissions. The current real executor supports read-only agent work; do not promise arbitrary shell steps, deployment, or repository writes through invented YAML fields.
