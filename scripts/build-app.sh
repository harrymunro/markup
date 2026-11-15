#!/bin/sh
# Builds Markup.app, a small launcher you can keep in the Dock.
#
#   scripts/build-app.sh            # creates ./Markup.app
#   scripts/build-app.sh ~/Applications
#
# The app only starts this checkout's server.js, so rebuild it if you move the folder.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$ROOT}"
APP="$DEST/Markup.app"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/assets/Markup.icns" "$APP/Contents/Resources/Markup.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Markup</string>
  <key>CFBundleDisplayName</key><string>Markup</string>
  <key>CFBundleIdentifier</key><string>dev.markup.launcher</string>
  <key>CFBundleExecutable</key><string>Markup</string>
  <key>CFBundleIconFile</key><string>Markup</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION:-1.0.0}</string>
  <key>CFBundleVersion</key><string>${VERSION:-1.0.0}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <!-- The executable is a shell script, which macOS would otherwise start under Rosetta on
       Apple Silicon and so run Chrome emulated (slow, and the window never connects). -->
  <key>LSArchitecturePriority</key><array><string>arm64</string><string>x86_64</string></array>
  <key>LSRequiresNativeExecution</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/Markup" <<'LAUNCHER'
#!/bin/sh
# Starts Markup and exits straight away, so every click on the Dock icon runs this again:
# the first click opens the window, later clicks bring the open window to the front.
ROOT="__ROOT__"

fail() {
  /usr/bin/osascript -e "display alert \"$1\" message \"$2\"" >/dev/null 2>&1
  exit 1
}

[ -f "$ROOT/server.js" ] || fail "Markup can’t find its files" "It expected them in $ROOT. If you moved the folder, run scripts/build-app.sh there again."

# Apps started from the Dock get a bare PATH, so look where Node is usually installed.
NODE=""
for candidate in "$MARKUP_NODE" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME/.local/bin/node"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
if [ -z "$NODE" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  newest="$(ls "$HOME/.nvm/versions/node" | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -1)"
  [ -x "$HOME/.nvm/versions/node/$newest/bin/node" ] && NODE="$HOME/.nvm/versions/node/$newest/bin/node"
fi
if [ -z "$NODE" ]; then
  found="$(/bin/zsh -lc 'command -v node' 2>/dev/null | tail -1)"
  [ -x "$found" ] && NODE="$found"
fi
[ -n "$NODE" ] || fail "Markup needs Node.js" "Install it from nodejs.org, then open Markup again."

mkdir -p "$HOME/Library/Logs"
cd "$ROOT" || exit 1
nohup "$NODE" "$ROOT/server.js" "$@" >> "$HOME/Library/Logs/Markup.log" 2>&1 &
exit 0
LAUNCHER

# Bake in where this checkout lives (escaped for sed).
ESCAPED="$(printf '%s' "$ROOT" | sed 's/[&|\\]/\\&/g')"
sed -i '' "s|__ROOT__|$ESCAPED|" "$APP/Contents/MacOS/Markup"
chmod +x "$APP/Contents/MacOS/Markup"

# Make Finder and the Dock pick up the icon straight away.
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true

echo "Built $APP"
echo "Drag it onto the Dock to keep it there."
