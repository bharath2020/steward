# Version-aware skill installation validation — 2026-09-07

Updated installer behavior under ADR-021: standard setup uses `--update`, installing missing skills and upgrading older versions with a complete retained backup. Bundled `skill-version.json` starts at version 1. Same/newer versions remain unchanged, recognizable legacy Steward copies count as version 0, unknown legacy copies are preserved, and invalid metadata fails closed.

## Evidence

- Actual RED: older `--update` rejected by original CLI usage, fresh install baseline passed. See [acceptance report](skill-update-acceptance-2026-09-07.md).
- New updater 17 plus existing skill 4 tests: **21/21 pass**, including executable repeat setup with an older installed skill, legacy/customized backups, no downgrade, malformed metadata, symlink refusal, lock contention, and injected final publication failure/rollback.
- `npm run verify:installer`: **8/8 pass**, exit 0, including archive update regression. [Log](skill-update-installer-2026-09-07.txt). Initial sandbox run was blocked by `spawnSync ps EPERM`; rerun with required process inspection passed.
- `npm run build`: exit 0.
- `npm test`: **123/123 pass**, zero failures/skips/cancellations, exit 0. [Log](skill-update-unit-2026-09-07.txt). This completes the installer/build/unit checks of `npm run verify` without repeating successful checks.
- `node --check scripts/install-skill.mjs` and `git diff --check`: exit 0.
- Independent source review found no actionable issues.

Tests used isolated temporary installs and controlled agent homes. The actual locally installed skill and existing runtime were not modified. No commit or push performed. No Temporal runtime code changed, so full runtime E2E was not repeated. Publication uses rename and caught failures roll back; process death between directory renames still requires restoring the retained backup and clearing the lock after confirming the installer stopped, as documented in ADR-021.
