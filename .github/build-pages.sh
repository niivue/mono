#!/usr/bin/env bash
# Build the GitHub Pages site locally for testing or in CI.
#
# Usage:
#   .github/build-pages.sh          # build into _site/
#   .github/build-pages.sh --serve  # build then start a local server
#
# The BASE_PATH env var controls the URL prefix (default: /mono/).
# Set BASE_PATH=/ to test without a subpath.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BASE_PATH="${BASE_PATH:-/mono/}"

# Ensure BASE_PATH ends with /
[[ "$BASE_PATH" == */ ]] || BASE_PATH="${BASE_PATH}/"

echo "==> Building with BASE_PATH=$BASE_PATH"

# Demo apps to include (folder names under apps/)
APPS=(demo-ext-drawing demo-ext-image-processing demo-ext-save-html)

# 1. Build the niivue library (required by all apps)
echo "==> Building niivue library"
bunx nx build niivue

# 2. Build demo apps (each gets its own sub-path)
for app in "${APPS[@]}"; do
  echo "==> Building $app"
  VITE_BASE="${BASE_PATH}${app}/" VITE_IMAGES_BASE="$BASE_PATH" bunx nx build "$app"
done

# 3. Build niivue examples last (overwrites packages/niivue/dist)
echo "==> Building niivue examples"
rm -rf packages/niivue/dist
(cd packages/niivue \
  && bun run codegen:assets \
  && VITE_BASE="$BASE_PATH" bunx --bun vite build --config vite.config.examples.ts --mode production)

# 4. Assemble site
# Strip leading/trailing slashes to get the subdir name (e.g. "mono")
SUB_DIR="${BASE_PATH#/}"
SUB_DIR="${SUB_DIR%/}"

echo "==> Assembling _site/"
rm -rf _site

if [[ -n "$SUB_DIR" ]]; then
  DEST="_site/$SUB_DIR"
else
  DEST="_site"
fi
mkdir -p "$DEST"

# Examples build forms the site root (includes shared dev-images)
cp -r packages/niivue/dist/* "$DEST/"

# Landing page
cp .github/pages/index.html "$DEST/index.html"

# Each demo app in its own subfolder
for app in "${APPS[@]}"; do
  mkdir -p "$DEST/$app"
  cp -r "apps/$app/dist/"* "$DEST/$app/"
done

echo "==> Done. Site is in _site/ ($(du -sh _site | cut -f1))"

# Optional: serve locally
if [[ "${1:-}" == "--serve" ]]; then
  echo "==> Serving at http://localhost:8080${BASE_PATH}"
  bunx http-server _site -p 8080 --cors -c-1
fi
