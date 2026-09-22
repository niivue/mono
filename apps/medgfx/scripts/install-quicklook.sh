#!/usr/bin/env bash
#
# Build medgfx and make Finder use THAT copy of the Quick Look extension --
# then prove which binary is registered.
#
# This exists because registration silently moves. Any second copy of the app
# can win it: an old -derivedDataPath tree, an `xcodebuild archive`, a copy in
# /Applications, or simply the Debug build sitting next to the Release one.
# Finder will happily preview with a binary from hours ago while you conclude
# your change did not work. That has already happened twice in this port.
#
# Usage:
#   ./scripts/install-quicklook.sh                 # Release build, then register
#   ./scripts/install-quicklook.sh --debug         # Debug build (has the trace log)
#   ./scripts/install-quicklook.sh --no-build      # register what is already built
#   ./scripts/install-quicklook.sh --which         # who is registered / running now
#
set -euo pipefail
cd "$(dirname "$0")/.."

ID=com.niivue.medgfx.QuickLookPreview
DD="$HOME/Library/Developer/Xcode/DerivedData/medgfx-ql"
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
CONFIG=Release
BUILD=1

for arg in "$@"; do
  case "$arg" in
    --debug) CONFIG=Debug ;;
    --no-build) BUILD=0 ;;
    --which) CONFIG=; BUILD=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

registrations() { /usr/bin/pluginkit -m -v -A -D 2>/dev/null | grep -F "$ID" || true; }

if [ -z "$CONFIG" ]; then
  echo "Registered:"
  registrations | sed 's/.*\t/  /'
  echo
  echo "Running right now (open a preview in Finder first):"
  # Works in Release too, unlike the trace log, which is #if DEBUG. This is the
  # only signal that survives a Release build.
  pgrep -fl 'QuickLookPreview.appex' | sed 's/^/  /' || echo "  (not running)"
  exit 0
fi

APP="$DD/Build/Products/$CONFIG/medgfx.app"
APPEX="$APP/Contents/PlugIns/QuickLookPreview.appex"

if [ "$BUILD" = 1 ]; then
  echo "Building $CONFIG..."
  # Ad-hoc: there is no Mac Development certificate on this machine, only a
  # Developer ID Application one, which does not satisfy development signing.
  # Ad-hoc is enough for Finder to invoke an extension.
  xcodebuild -project medgfx.xcodeproj -scheme medgfx -configuration "$CONFIG" \
    -destination 'platform=macOS,arch=arm64' -derivedDataPath "$DD" \
    CODE_SIGN_IDENTITY="-" CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="" \
    PROVISIONING_PROFILE_SPECIFIER="" build >/tmp/medgfx-ql-build.log 2>&1 || {
      echo "BUILD FAILED -- refusing to register a stale binary." >&2
      tail -20 /tmp/medgfx-ql-build.log >&2
      exit 1
    }
fi

[ -d "$APPEX" ] || { echo "no appex at $APPEX" >&2; exit 1; }

# Evict every OTHER registration first. The newest is not automatically the one
# Finder picks, so "register mine" is not enough on its own.
echo "Evicting other copies..."
registrations | sed 's/.*\t//' | while read -r other; do
  case "$other" in
    "$APPEX") ;;
    *) echo "  drop $other"
       /usr/bin/pluginkit -r "$other" 2>/dev/null || true
       "$LSREG" -u "${other%%/Contents/PlugIns/*}" 2>/dev/null || true ;;
  esac
done

"$LSREG" -f -R "$APP"
/usr/bin/pluginkit -a "$APPEX" 2>/dev/null || true
/usr/bin/qlmanage -r >/dev/null 2>&1 || true
/usr/bin/qlmanage -r cache >/dev/null 2>&1 || true
sleep 2

echo
echo "Registered:"
registrations | sed 's/.*\t/  /'
COUNT=$(registrations | wc -l | tr -d ' ')
echo "  built $(stat -f '%Sm' -t '%b %e %H:%M:%S' "$APPEX/Contents/MacOS/QuickLookPreview")"
if [ "$COUNT" -ne 1 ]; then
  echo "  $COUNT copies registered -- Finder may pick either." >&2
  exit 1
fi

# A binary date says nothing about the web assets inside the bundle. The shipped
# page has gone stale before, so compare it against the one just built.
SRC="web/dist/quicklook.html"
DST="$APPEX/Contents/Resources/WebApp/quicklook.html"
if [ -f "$SRC" ] && [ -f "$DST" ]; then
  if [ "$(shasum -a 256 <"$SRC")" = "$(shasum -a 256 <"$DST")" ]; then
    echo "  page matches the build ($(shasum -a 256 <"$DST" | cut -c1-12))"
  else
    echo "  SHIPPED PAGE IS STALE -- the appex does not contain the page just built." >&2
    exit 1
  fi
else
  echo "  WARNING: could not compare the shipped page ($SRC / $DST)" >&2
fi

echo
if [ "$CONFIG" = Debug ]; then
  LOG="$HOME/Library/Containers/$ID/Data/tmp/quicklook-preview.log"
  rm -f "$LOG" 2>/dev/null || true
  echo "Confirm it ran -- preview a file in Finder, then:"
  echo "  tail -5 \"$LOG\""
  echo "Each preview appends a line stamped with the build time. os_log from a"
  echo "Quick Look appex does NOT reach 'log show', so this file is the only"
  echo "reliable signal. An empty or missing file means it never ran."
else
  echo "Release has no trace log (it is #if DEBUG). To confirm which binary ran,"
  echo "open a preview in Finder and, while it is up:"
  echo "  ./scripts/install-quicklook.sh --which"
fi
