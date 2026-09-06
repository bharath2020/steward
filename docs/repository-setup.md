# Steward repository setup and relocation

Status: Steward branding and component/UI work implemented. The repository was moved to `Documents/projects/steward` on 2026-09-06 UTC (2026-09-05 local). Local source is committed on `main`. GitHub creation/push is blocked by automatic approval review pending explicit authorization of this source upload to the private `bharath2020/steward` repository. Remote CI has not run.

## Confirmed direction

- One repository with Steward CLI (`src/cli/`), Steward Server (`src/server/`), and Steward Console (`ui/`) components.
- UI templates mean shared component markup and selectable layouts/themes. Do not enable GitHub's template-repository flag or add a starter-workflow generator on that basis.
- Board and Review layouts; Dark, Light, and System themes.
- Move from the trials folder to the owner's `Documents/projects/steward` directory.
- README, icon, accurate technology/status badges, contribution instructions, and CI configuration prepared locally. The live GitHub CI badge targets `bharath2020/steward`; it reflects GitHub status rather than a static passing claim.
- Steward is the approved display name. The prepared destination is `bharath2020/steward` with private visibility; no remote has been created.

## Preserve the runtime during relocation

Before relocation, the project services were stopped and the Temporal database had no open file descriptors. No run was resumed or human answer submitted; existing projections were not treated as proof of live Temporal status. Stop only services owned by this project and retain the complete `runtime/` tree, Temporal SQLite database, any SQLite sidecars, agent artifacts, and receipt copies. Move the existing directory rather than creating a second independently writable runtime. Verify file hashes around the move and start from the new repository root.

The launcher still uses cwd-relative database/log locations and service entry paths. The store's `YAMLFLOW_RUNTIME_DIR` override alone does not redirect the launcher's Temporal database. Resolve those paths deliberately and avoid running old and new workers against divergent artifact roots.

Existing definition `sourcePath` fields are historical provenance. Do not rewrite them, accepted receipts, or Temporal identities during a branding change. Provider sessions may remember the old working directory; assess real-session resumption separately from simulated recovery verification.

The saved Codex project entry still points to the former trial directory. The available project tools cannot change a saved path, and Codex blocks computer automation of its own UI; the owner must open the new folder in Codex. Project-local configuration moved with the folder and remains excluded from Git. The new destination is outside this task's current writable root and requires the normal filesystem approval mechanism. Do not use a symlink to bypass that boundary.

## Publication

Automatic approval review rejected the combined repository-creation/push command because it requires explicit approval for the exact source payload and destination. No upload occurred. The prepared payload is the Git-tracked source, documentation, examples/workflows, icon, package metadata, and CI configuration; runtime data and local agent configuration are ignored. GitHub CI remains unverified until publication is approved and performed.

Apply the approved Steward display name and repository/package metadata while retaining existing execution identifiers. Commit source, documentation, and UI assets; exclude runtime history, credentials, local agent configuration, and generated test output. Create the requested GitHub repository, push `main`, set its description/topics, and verify the first CI run. No license has been selected; do not add an open-source license or license badge without the owner's choice.

Compatibility is explicit: `YAMLFLOW_*` settings, `yamlflow-<runId>` workflow IDs, the `yamlflow-agent-nodes` task queue, `yamlAgentWorkflow`/`yamlAgentWorkflowV2` workflow types, and stored schema identities retain their established spelling. Existing lowercase identifiers in future CLI proposals also remain unchanged pending a contract-specific decision.

Validation of the current local component/UI change is recorded in [the validation report](validation/component-ui-2026-09-05.md). Relocation verification matched all 888 runtime files (10,632,065 bytes) by relative path, byte count, and SHA-256 before and after the move. The detailed local manifest is `/private/tmp/steward-relocation-20260905.json`; it is excluded from publication.
