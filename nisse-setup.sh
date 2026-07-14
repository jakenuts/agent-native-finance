#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PNPM_VERSION="11.10.0"

log() {
  printf '\n==> %s\n' "$*"
}

append_once() {
  local line="$1"
  local file="${2:-$HOME/.bashrc}"
  touch "$file"
  grep -qxF "$line" "$file" || printf '%s\n' "$line" >> "$file"
}

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$name" >&2
    return 1
  fi
}

log "Checking base tools"
require_command node
require_command npm
require_command git
require_command curl

for optional in python3 make g++; do
  if ! command -v "$optional" >/dev/null 2>&1; then
    printf 'Warning: %s is missing; native package rebuilds may fail.\n' "$optional" >&2
  fi
done

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 22 ]; then
  printf 'Node 22.22+ is required; found %s.\n' "$(node -v)" >&2
  exit 1
fi

log "Activating pnpm ${PNPM_VERSION}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack enable
corepack prepare "pnpm@${PNPM_VERSION}" --activate

log "Installing project dependencies"
pnpm install --frozen-lockfile --prefer-offline

log "Ensuring Railway CLI"
npm_global_bin="$(npm prefix -g)/bin"
append_once "export PATH=\"${npm_global_bin}:\$PATH\""
export PATH="${npm_global_bin}:$PATH"

if ! command -v railway >/dev/null 2>&1; then
  npm install -g @railway/cli
fi

log "Tool versions"
node -v
pnpm -v
railway --version || true

if command -v gh >/dev/null 2>&1; then
  gh auth status >/dev/null 2>&1 \
    && echo "GitHub CLI is authenticated" \
    || echo "GitHub CLI is installed but not authenticated"
else
  echo "GitHub CLI is not installed in this image"
fi

if [ -n "${RAILWAY_TOKEN:-}" ]; then
  echo "RAILWAY_TOKEN is configured"
else
  echo "RAILWAY_TOKEN is not configured; Railway commands that need auth will fail"
fi
