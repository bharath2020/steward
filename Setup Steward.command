#!/bin/bash
# Finder entrypoint: keep diagnostics visible if installation fails.
cd "$(dirname "$0")" || exit 1
# A new run always needs an operator-selected repository, including Finder starts.
new_run=false
has_directory=false
for arg in "$@"; do
  [ "$arg" = "--new-run" ] && new_run=true
  [ "$arg" = "--working-directory" ] && has_directory=true
done
if $new_run && ! $has_directory; then
  read -r -p "Repository working directory: " repository_directory
  set -- "$@" --working-directory "$repository_directory"
fi
/bin/bash scripts/setup.sh "$@"
status=$?
if [ "$status" -ne 0 ]; then
  echo "Setup stopped. Read the error above; your saved runs have been preserved."
  read -r -p "Press Return to close. " _
fi
exit "$status"
