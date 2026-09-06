#!/bin/bash
# Finder entrypoint: keep diagnostics visible if installation fails.
cd "$(dirname "$0")" || exit 1
/bin/bash scripts/setup.sh "$@"
status=$?
if [ "$status" -ne 0 ]; then
  echo "Setup stopped. Read the error above; your saved runs have been preserved."
  read -r -p "Press Return to close. " _
fi
exit "$status"
