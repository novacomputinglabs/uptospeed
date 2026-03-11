#!/usr/bin/env bash
set -euo pipefail

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required. Install Node.js/npm first."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_SCRIPT="$ROOT_DIR/scripts/capture-ui-components.cjs"

cd "$ROOT_DIR"

# Ensure Chromium is present for Playwright.
if ! npx --yes --package=playwright -c 'NODE_PATH="$(dirname "$(dirname "$(which playwright)")")" node -e "const fs=require(\"fs\"); const { chromium } = require(\"playwright\"); process.exit(fs.existsSync(chromium.executablePath()) ? 0 : 1);"'; then
  npx --yes -p playwright playwright install chromium >/dev/null
fi

# Forward arguments safely through `npx -c`.
escaped_script="$(printf '%q' "$NODE_SCRIPT")"
escaped_args=()
for arg in "$@"; do
  escaped_args+=("$(printf '%q' "$arg")")
done
args_string="${escaped_args[*]:-}"

# Run the capture job using Playwright from npx's temporary node_modules.
npx --yes --package=playwright -c "NODE_PATH=\"\$(dirname \"\$(dirname \"\$(which playwright)\")\")\" node ${escaped_script} ${args_string}"
