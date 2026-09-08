#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -d "$PWD.installing" ] && [ "${STEWARD_INSTALLER:-0}" != 1 ]; then
  echo "The archive installer is updating Steward. Wait for it to finish." >&2
  exit 1
fi
mkdir -p runtime/services
if ! mkdir runtime/services/bootstrap.lock 2>/dev/null; then
  echo "Another setup is installing dependencies. Wait for it to finish. If it was interrupted, remove runtime/services/bootstrap.lock after confirming it has stopped." >&2
  exit 1
fi
trap 'rmdir runtime/services/bootstrap.lock' EXIT

ensure_brew() {
  if ! command -v brew >/dev/null 2>&1; then
    echo "Installing Homebrew. Its installer may request your Mac administrator password."
    installer=$(mktemp -t steward-homebrew)
    curl --fail --show-error --location https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$installer"
    /bin/bash "$installer"
    rm -f "$installer"
  fi
}

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  if [ "$(uname -s)" != Darwin ]; then
    echo "Install Node.js 22+ and npm, then rerun bash scripts/setup.sh." >&2
    exit 1
  fi
  ensure_brew
  brew install node@22
  export PATH="$(brew --prefix node@22)/bin:$PATH"
fi
if ! command -v temporal >/dev/null 2>&1; then
  if [ "$(uname -s)" != Darwin ]; then
    echo "Install the Temporal CLI, then rerun bash scripts/setup.sh." >&2
    exit 1
  fi
  ensure_brew
  brew install temporal
fi

echo "Checking Steward dependencies…"
# Avoid replacing dependencies underneath a running worker on repeat clicks.
fingerprint=$(node -e 'const fs=require("fs"), c=require("crypto"); console.log(c.createHash("sha256").update(fs.readFileSync("package-lock.json")).update(process.versions.node.split(".")[0]).digest("hex"))')
if [ ! -f node_modules/.steward-setup ] || [ "$(cat node_modules/.steward-setup)" != "$fingerprint" ]; then
  if [ "${STEWARD_INSTALL_UPDATED:-0}" != 1 ] && [ -d node_modules ] && npm ls --depth=0 >/dev/null 2>&1; then
    echo "Existing dependencies satisfy the package; preserving the running worker's installation."
  else
    npm ci
  fi
  printf '%s' "$fingerprint" > node_modules/.steward-setup
fi
npm run build
# Install or upgrade older authoring skills, retaining the previous directory as a backup.
case "${STEWARD_SKILL_AGENT:-codex}" in
  codex|claude) node scripts/install-skill.mjs --update --agent "${STEWARD_SKILL_AGENT:-codex}" ;;
  both)
    node scripts/install-skill.mjs --update --agent codex
    node scripts/install-skill.mjs --update --agent claude
    ;;
  none) echo "Skipping authoring skill installation (STEWARD_SKILL_AGENT=none)." ;;
  *) echo "STEWARD_SKILL_AGENT must be codex, claude, both, or none." >&2; exit 1 ;;
esac
node --import tsx src/setup.ts "$@"
