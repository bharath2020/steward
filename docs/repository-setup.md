# Steward repository setup and relocation

Status: Steward branding and component/UI work implemented. The repository was moved to `Documents/projects/steward` on 2026-09-06 UTC (2026-09-05 local). Source was initially committed and pushed to `main` in the private [bharath2020/steward](https://github.com/bharath2020/steward) repository. The first [GitHub CI run](https://github.com/bharath2020/steward/actions/runs/34008856686) passed all three jobs on 2026-09-06 UTC (2026-09-05 local).

## Confirmed direction

- Initial product version: `0.1.0`, as selected by the owner. Package metadata and the lockfile agree; the README displays the same version.
- One repository with Steward CLI (`src/cli/`), Steward Server (`src/server/`), and Steward Console (`ui/`) components.
- UI templates mean shared component markup and selectable layouts/themes. Do not enable GitHub's template-repository flag or add a starter-workflow generator on that basis.
- Board and Review layouts; Dark, Light, and System themes.
- Move from the trials folder to the owner's `Documents/projects/steward` directory.
- README, icon, accurate technology/status badges, contribution instructions, and CI configuration prepared locally. The live GitHub CI badge targets `bharath2020/steward`; it reflects GitHub status rather than a static passing claim.
- Steward is the approved display name. The repository is `bharath2020/steward`, now with public visibility and `main` as its default branch. GitHub template mode is disabled.

## Preserve the runtime during relocation

Before relocation, the project services were stopped and the Temporal database had no open file descriptors. No run was resumed or human answer submitted; existing projections were not treated as proof of live Temporal status. Stop only services owned by this project and retain the complete `runtime/` tree, Temporal SQLite database, any SQLite sidecars, agent artifacts, and receipt copies. Move the existing directory rather than creating a second independently writable runtime. Verify file hashes around the move and start from the new repository root.

The launcher still uses cwd-relative database/log locations and service entry paths. The store's `YAMLFLOW_RUNTIME_DIR` override alone does not redirect the launcher's Temporal database. Resolve those paths deliberately and avoid running old and new workers against divergent artifact roots.

Existing definition `sourcePath` fields are historical provenance. Do not rewrite them, accepted receipts, or Temporal identities during a branding change. Provider sessions may remember the old working directory; assess real-session resumption separately from simulated recovery verification.

The saved Codex project entry still points to the former trial directory. The available project tools cannot change a saved path, and Codex blocks computer automation of its own UI; the owner must open the new folder in Codex. Project-local configuration moved with the folder and remains excluded from Git. The new destination is outside this task's current writable root and requires the normal filesystem approval mechanism. Do not use a symlink to bypass that boundary.

## Publication

The owner approved commit and push. After verifying the authenticated GitHub account owns the `bharath2020` namespace, the private repository was created and the committed source pushed. The upload contains 67 tracked source, documentation, example/workflow, icon, package, and CI files. Runtime data, dependencies, credentials, and local agent configuration are ignored. GitHub CI passed Node 22 and Node 24 typechecks/tests plus the isolated simulated recovery job at commit `aef81c2c6be1047cd1225b4e3f39ab96fb44f100`.

The approved display name, package metadata, README icon/badges, repository description, and topics are configured. Preserve execution identifiers and keep runtime history, credentials, local configuration, and generated test output excluded from future commits. No license has been selected; do not add an open-source license or license badge without the owner's choice.

Compatibility is explicit: `YAMLFLOW_*` settings, `yamlflow-<runId>` workflow IDs, the `yamlflow-agent-nodes` task queue, `yamlAgentWorkflow`/`yamlAgentWorkflowV2` workflow types, and stored schema identities retain their established spelling. Existing lowercase identifiers in future CLI proposals also remain unchanged pending a contract-specific decision.

Validation of the current local component/UI change is recorded in [the validation report](validation/component-ui-2026-09-05.md). Relocation verification matched all 888 runtime files (10,632,065 bytes) by relative path, byte count, and SHA-256 before and after the move. The detailed local manifest is `/private/tmp/steward-relocation-20260905.json`; it is excluded from publication.


## Public archive installer

The owner requested public visibility on 2026-09-06. Visibility was verified as
PUBLIC after a Gitleaks scan of all nine then-existing commits reported no leaks
and the tracked history was checked for runtime/credential artifacts. The setup
work is published on `codex/one-click-setup`; it has not been merged to `main`.
The isolated [macOS setup run](https://github.com/bharath2020/steward/actions/runs/34040125098)
passed at `9f6eccde90d9cfb75bec74d586fe116b0b55c350`, including Temporal installation,
example completion/receipt verification, and a repeat launch. That runner already
had Node and Homebrew. The subsequent archive installer removes the checkout
requirement; its CI job downloads the public commit archive without credentials.
