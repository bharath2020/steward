#!/bin/bash
# Download a source archive and launch setup. Git is not required.
set -euo pipefail

# EXIT traps run after function locals are unwound on newer Bash versions.
steward_download_temp=""
steward_install_lock=""

main() {
  local install_dir="${STEWARD_INSTALL_DIR:-$HOME/Applications/Steward}"
  local ref="${STEWARD_REF:-main}"
  case "$install_dir" in /*) ;; *) echo "STEWARD_INSTALL_DIR must be an absolute path." >&2; return 1;; esac
  case "$ref" in ''|*[!a-zA-Z0-9._/-]*) echo "Invalid STEWARD_REF." >&2; return 1;; esac

  local existing=false
  if [ -L "$install_dir" ]; then
    echo "Refusing a symlink installation directory." >&2; return 1
  fi
  if [ -e "$install_dir" ]; then
    if [ ! -f "$install_dir/.steward-install" ] || [ ! -f "$install_dir/scripts/setup.sh" ]; then
      echo "Refusing to overwrite $install_dir. Choose an empty STEWARD_INSTALL_DIR." >&2
      return 1
    fi
    existing=true
  fi
  mkdir -p "$(dirname "$install_dir")"
  # Set trap ownership only after acquiring the lock; never remove another installer's lock.
  if ! mkdir "$install_dir.installing" 2>/dev/null; then
    echo "Another installation is in progress ($install_dir.installing)." >&2; return 1
  fi
  steward_install_lock="$install_dir.installing"
  trap 'if [ -n "${steward_download_temp:-}" ]; then rm -rf "$steward_download_temp"; fi; if [ -n "${steward_install_lock:-}" ]; then rmdir "$steward_install_lock"; fi' EXIT
  steward_download_temp=$(mktemp -d "$(dirname "$install_dir")/.steward-download.XXXXXX")
  echo "Downloading Steward ($ref)…"
  curl --fail --silent --show-error --location --retry 3 --header 'Cache-Control: no-cache' \
    "https://codeload.github.com/bharath2020/steward/tar.gz/$ref" -o "$steward_download_temp/source.tar.gz"
  mkdir "$steward_download_temp/app"
  tar -xzf "$steward_download_temp/source.tar.gz" --strip-components=1 -C "$steward_download_temp/app"
  test -f "$steward_download_temp/app/package-lock.json"
  test -f "$steward_download_temp/app/scripts/setup.sh"
  # Record source-owned top-level paths so updates remove files deleted upstream.
  (
    cd "$steward_download_temp/app"
    for path in * .[!.]* ..?*; do
      [ -e "$path" ] || [ -L "$path" ] || continue
      printf '%s\n' "$path"
    done
  ) > "$steward_download_temp/manifest"
  mv "$steward_download_temp/manifest" "$steward_download_temp/app/.steward-source-files"
  printf '%s\n' "$ref" > "$steward_download_temp/app/.steward-install"
  if [ "$existing" = true ]; then
    command -v node >/dev/null || { echo "Node.js is required to update an existing installation." >&2; return 1; }
    local updater="$steward_download_temp/app/scripts/update-install.mjs"
    if [ ! -f "$updater" ]; then
      # Older explicitly pinned archives predate the updater.
      updater="$steward_download_temp/update-install.mjs"
      curl --fail --silent --show-error --location --retry 3 --header 'Cache-Control: no-cache' \
        "https://raw.githubusercontent.com/bharath2020/steward/main/scripts/update-install.mjs" -o "$updater"
    fi
    node "$updater" "$install_dir" "$steward_download_temp/app"
    export STEWARD_INSTALL_UPDATED=1
  else
    mv -n "$steward_download_temp/app" "$install_dir"
    if [ -d "$steward_download_temp/app" ]; then
      echo "Another installer created $install_dir. Rerun after it finishes." >&2; return 1
    fi
  fi
  export STEWARD_INSTALLER=1
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
