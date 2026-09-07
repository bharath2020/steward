# Portable workflow authoring skill validation

User outcome: describe a workflow to an external coding agent, receive V1 YAML and example input, and validate it without starting execution. Implements ADR-018 with the existing spec/compiler ownership from ADR-009 and authoring/execution separation from ADR-013.

Verified locally on 2026-09-07:

- `node --import tsx --test tests/skill.test.ts`: 3/3 passed. All three bundled YAML/input pairs validate; missing input references and nonexistent workflows fail; installation from an unrelated working directory includes references/assets and refuses an existing destination.
- `npm run build`: exit 0.
- `node --import tsx --test tests/*.test.ts`: 78/78 passed, exit 0, with localhost/process access. The first sandboxed run failed on existing HTTP/process tests with `listen EPERM` and `spawnSync ps EPERM`; the authorized rerun passed.
- Skill creator `quick_validate.py skills/steward-workflow`: exit 0, `Skill is valid!`. PyYAML was supplied from a temporary dependency directory because the system interpreter lacked it.
- `node scripts/install-skill.mjs`: installed into `/Users/bharath2020/.codex/skills/steward-workflow`; recursive comparison with the repository skill returned exit 0.
- `git diff --check`: exit 0 before this validation note.

No workflow was started for this task. Validation checks the runtime loader and supplied initial-input references; it is not exhaustive node-output reference validation, a provider-quality evaluation, or a production release gate. The installer was exercised locally and in temporary directories, not via a newly published remote archive. Claude's destination option is documented; no Claude user configuration was changed.

## Standard installer integration

The archive installer's existing setup handoff now installs the Codex skill automatically. `STEWARD_SKILL_AGENT` selects Codex, Claude, both, or opt-out. Repeat setup preserves existing skills and prints refresh guidance. The standalone command still refuses overwrites unless `--if-missing` is passed, which skips them.

The new isolated setup test runs the real `scripts/setup.sh` and skill installer with fixture application/dependency setup. It verifies first installation, successful continuation to the setup entrypoint, preservation of customized skill content, opt-out, and invalid target rejection. No real runtime is launched. The focused suite passes 4/4; the full suite passes 79/79. TypeScript, the installer publication contract, shell syntax, and whitespace checks pass. Remote archive installation on a clean machine was not repeated for this change.
