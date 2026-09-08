# Version-aware skill update: initial RED

Date: 2026-09-07. Test owner: session_resume_tests subagent.

Before production changes, `node --import tsx --test tests/skill-update.test.ts` exited 1: one passing fresh-install baseline and one failing older-version upgrade test. The failure is the public installer rejecting the new `--update` flag with its usage message, not an environment failure.

The temporary application fixture ships `skill-version.json` with `{name: "steward-workflow", version: 2}`. Its existing customized installation has version 1. The acceptance assertion requires the bundled copy to replace the old version and retain every prior file in a reported backup. No real user skill installation or runtime is modified.

[Captured RED output](skill-update-red-2026-09-07.txt). Production implementation was released only after this result.
