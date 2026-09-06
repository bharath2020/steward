#!/bin/bash
# Download a source archive and launch setup. Git is not required.
set -euo pipefail

main() {
  local install_dir="${STEWARD_INSTALL_DIR:-$HOME/Applications/Steward}"
  local ref="${STEWARD_REF:-codex/one-click-setup}"
  local scratch=""
  local install_lock=""
  case "$install_dir" in /*) ;; *) echo "STEWARD_INSTALL_DIR must be an absolute path." >&2; return 1;; esac
  case "$ref" in ''|*[!a-zA-Z0-9._/-]*) echo "Invalid STEWARD_REF." >&2; return 1;; esac

  if [ -e "$install_dir" ]; then
    if [ ! -f "$install_dir/.steward-install" ] || [ ! -f "$install_dir/scripts/setup.sh" ]; then
      echo "Refusing to overwrite $install_dir. Choose an empty STEWARD_INSTALL_DIR." >&2
      return 1
    fi
    echo "Reopening your existing Steward installation at $install_dir"
  else
    mkdir -p "$(dirname "$install_dir")"
    install_lock="$install_dir.installing"
    if ! mkdir "$install_lock" 2>/dev/null; then
      echo "Another download is in progress ($install_lock)." >&2
      return 1
    fi
    trap 'if [ -n "${scratch:-}" ]; then rm -rf "$scratch"; fi; if [ -n "${install_lock:-}" ]; then rmdir "$install_lock"; fi' EXIT
    if [ -e "$install_dir" ]; then
      echo "The installation directory appeared during setup; rerun to reconnect." >&2
      return 1
    fi
    # Stage beside the destination so publishing the complete directory is atomic.
    scratch=$(mktemp -d "$(dirname "$install_dir")/.steward-download.XXXXXX")
    echo "Downloading Steward…"
    curl --fail --silent --show-error --location --retry 3 \
      "https://codeload.github.com/bharath2020/steward/tar.gz/$ref" -o "$scratch/source.tar.gz"
    mkdir "$scratch/app"
    tar -xzf "$scratch/source.tar.gz" --strip-components=1 -C "$scratch/app"
    test -f "$scratch/app/package-lock.json"
    test -f "$scratch/app/scripts/setup.sh"
    printf '%s\n' "$ref" > "$scratch/app/.steward-install"
    # macOS/BSD and GNU mv both support -n: never replace an existing install.
    mv -n "$scratch/app" "$install_dir"
    if [ -d "$scratch/app" ]; then
      echo "Another installer created $install_dir. Rerun after it finishes." >&2
      return 1
    fi
    rm -rf "$scratch"
    scratch=""
    rmdir "$install_lock"
    install_lock=""
    trap - EXIT
  fi
  echo "Steward location: $install_dir"
  # The downloaded script has already been fully parsed before setup can read
  # input, so Homebrew prompts never consume this curl pipeline's source text.
  if [ -t 1 ] && [ -r /dev/tty ]; then
    /bin/bash "$install_dir/scripts/setup.sh" "$@" </dev/tty
  else
    /bin/bash "$install_dir/scripts/setup.sh" "$@"
  fi
}

main "$@"
