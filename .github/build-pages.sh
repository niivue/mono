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
APPS=(
  demo-ext-drawing
  demo-ext-image-processing
  demo-ext-save-html
  demo-ext-dcm2niix
  demo-nv-web-component
)

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
# GitHub Pages (actions/deploy-pages) maps the artifact root to BASE_PATH,
# so files go directly into _site/ — no subdirectory nesting needed.

echo "==> Assembling _site/"
rm -rf _site
mkdir -p _site

# Examples build forms the site root (includes shared dev-images)
cp -r packages/niivue/dist/* _site/

# Landing page
cp .github/pages/index.html _site/index.html

# Each demo app in its own subfolder
for app in "${APPS[@]}"; do
  mkdir -p "_site/$app"
  cp -r "apps/$app/dist/"* "_site/$app/"
done

echo "==> Done. Site is in _site/ ($(du -sh _site | cut -f1))"

# Optional: serve locally with the correct base path
if [[ "${1:-}" == "--serve" ]]; then
  echo "==> Serving at http://localhost:8080${BASE_PATH}"
  # Nest _site/ under the base path so local preview matches production URLs
  SERVE_DIR=$(mktemp -d)
  SUB_DIR="${BASE_PATH#/}"
  SUB_DIR="${SUB_DIR%/}"
  if [[ -n "$SUB_DIR" ]]; then
    mkdir -p "$SERVE_DIR/$SUB_DIR"
    cp -r _site/* "$SERVE_DIR/$SUB_DIR/"
  else
    cp -r _site/* "$SERVE_DIR/"
  fi
  bunx http-server "$SERVE_DIR" -p 8080 --cors -c-1
fi
