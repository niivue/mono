#!/usr/bin/env bash
# Compile and run the Quick Look routing self-check.
#
# ponytail: swiftc straight to a temp binary. No SPM package, no XCTest host —
# the thing under test is one file with no dependencies beyond Foundation.
set -euo pipefail
cd "$(dirname "$0")/.."
out=$(mktemp -d)/check
trap 'rm -rf "$(dirname "$out")"' EXIT
swiftc -o "$out" QuickLookPreview/PreviewFileKind.swift scripts/check-preview-file-kind.swift
"$out"
