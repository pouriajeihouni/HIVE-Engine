#!/usr/bin/env bash
# Install Hive as a macOS LaunchAgent (starts at login, auto-restarts).
# Usage: bash scripts/install-macos.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_SRC="$DIR/launchd/com.hive.agent.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.hive.agent.plist"
NODE_BIN="$(command -v node)"

if [ -z "$NODE_BIN" ]; then
  echo "❌ node not found in PATH — install Node 18+ first (https://nodejs.org)"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$DIR/data"
sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__HIVE_DIR__|$DIR|g" "$PLIST_SRC" > "$PLIST_DST"

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

echo "✅ Installed LaunchAgent: $PLIST_DST"
echo "   Starts at login · logs: tail -f $DIR/data/hive.log"
echo "   Stop:  launchctl unload $PLIST_DST"
echo "   Start: launchctl load   $PLIST_DST"
