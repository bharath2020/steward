#!/bin/bash
# Download a source archive and launch setup. Git is not required.
set -euo pipefail

# EXIT traps run after function locals are unwound on newer Bash versions.
steward_download_temp=""
steward_install_lock=""

main() {
  local install_dir="${STEWARD_INSTALL_DIR:-$HOME/Applications/Steward}"
  local ref="${STEWARD_REF:-codex/one-click-setup}"
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
    steward_install_lock="$install_dir.installing"
    if ! mkdir "$steward_install_lock" 2>/dev/null; then
      echo "Another download is in progress ($steward_install_lock)." >&2
      return 1
    fi
    trap 'if [ -n "${steward_download_temp:-}" ]; then rm -rf "$steward_download_temp"; fi; if [ -n "${steward_install_lock:-}" ]; then rmdir "$steward_install_lock"; fi' EXIT
    if [ -e "$install_dir" ]; then
      echo "The installation directory appeared during setup; rerun to reconnect." >&2
      return 1
    fi
    # Stage beside the destination so publishing the complete directory is atomic.
    steward_download_temp=$(mktemp -d "$(dirname "$install_dir")/.steward-download.XXXXXX")
    echo "Downloading Steward…"
    curl --fail --silent --show-error --location --retry 3 \
      "https://codeload.github.com/bharath2020/steward/tar.gz/$ref" -o "$steward_download_temp/source.tar.gz"
    mkdir "$steward_download_temp/app"
    tar -xzf "$steward_download_temp/source.tar.gz" --strip-components=1 -C "$steward_download_temp/app"
    test -f "$steward_download_temp/app/package-lock.json"
    test -f "$steward_download_temp/app/scripts/setup.sh"
    printf '%s\n' "$ref" > "$steward_download_temp/app/.steward-install"
    # macOS/BSD and GNU mv both support -n: never replace an existing install.
    mv -n "$steward_download_temp/app" "$install_dir"
    if [ -d "$steward_download_temp/app" ]; then
      echo "Another installer created $install_dir. Rerun after it finishes." >&2
      return 1
    fi
    rm -rf "$steward_download_temp"
    steward_download_temp=""
    rmdir "$steward_install_lock"
    steward_install_lock=""
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
