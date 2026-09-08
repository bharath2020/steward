# Version-aware skill update: acceptance evidence

Date: 2026-09-07. Test owner: session_resume_tests subagent.

Command: `node --import tsx --test tests/skill-update.test.ts tests/skill.test.ts`. Result: exit 0, 21 passed, zero failures/skips. [Captured output](skill-update-acceptance-2026-09-07.txt). [Initial RED evidence](skill-update-red-2026-09-07.md) was captured before production implementation.

The new tests execute the actual installer and setup shell against disposable application fixtures and controlled agent homes. They verify fresh installation, older-version replacement, same/newer version preservation, recognizable legacy upgrade with customization backup, unrelated unversioned preservation, malformed installed/bundled metadata rejection, symlink rejection, and repeated setup upgrading an older installed skill. Every successful upgrade compares the installed tree with the bundled source and the retained backup with the complete old file tree.

Failure coverage uses an external Node preloader to inject only the final publication rename failure. The previous installation is restored byte-for-byte, staging and lock are removed, and the next ordinary update succeeds. A separate existing-lock test verifies no mutation and retention of the other installer lock owner.

Existing offline example validation, portable installation/refusal behavior, and customized same-version repeat setup also pass. No actual user skills, credentials, existing runtimes, or workflows were changed by these tests. This verifies handled filesystem failures, not power-loss atomicity; an interrupted process may require recovery from its retained backup and stale lock as documented by the installer.
