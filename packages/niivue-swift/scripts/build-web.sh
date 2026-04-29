#!/usr/bin/env bash
#
# build-web.sh
#
# Rebuilds the web bundle used as the default `NiiVueKit` web app and
# mirrors it into the SPM resources directory.
#
# Consumers that keep BridgeConfig.default (`.resourceBundle = .main`)
# do not need this bundle -- they ship their own via a Run Script phase.
# The bundle here is for consumers that opt into the built-in default via
# BridgeConfig.niiVueKitBundled (see NiiVueKit/BridgeConfig+Bundled.swift).
#
# Run this before `git commit` whenever anything under
# `packages/niivue-web-bridge/src/` or `apps/medgfx/web/` changes that
# should be reflected in the bundled default.
#

set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
target="$here/Sources/NiiVueKit/Resources/WebApp"

cd "$repo_root"

echo "Building medgfx-web as the default NiiVueKit bundle..."
bunx nx build medgfx-web

echo "Mirroring dist/ into $target"
mkdir -p "$target"
# Preserve Resources/WebApp/README.md (tracked in git as a placeholder);
# --delete removes everything else that isn't present in the source dist.
rsync -a --delete --exclude='README.md' apps/medgfx/web/dist/ "$target/"

echo "Done. The bundle lives under $target but is intentionally not tracked"
echo "in git -- consumers run this script locally before \`swift build\`."
