#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
LABEL="${KANBAN_REMINDER_LAUNCHD_LABEL:-com.obsidian-kanban.reminders}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/ObsidianKanban"
INTERVAL="${KANBAN_REMINDER_INTERVAL_SECONDS:-60}"
API_URL="${KANBAN_API_URL:-http://127.0.0.1:4000}"
APP_URL="${KANBAN_APP_URL:-http://127.0.0.1:4000}"
API_TOKEN="${KANBAN_API_TOKEN:-${API_TOKEN:-}}"
EMAIL_TO="${KANBAN_REMINDER_EMAIL_TO:-}"

if [[ ! "$INTERVAL" =~ ^[0-9]+$ || "$INTERVAL" -lt 1 ]]; then
  echo "KANBAN_REMINDER_INTERVAL_SECONDS must be a positive integer" >&2
  exit 1
fi

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  printf '%s' "$value"
}

XML_LABEL="$(xml_escape "$LABEL")"
XML_NODE_BIN="$(xml_escape "$NODE_BIN")"
XML_ROOT_DIR="$(xml_escape "$ROOT_DIR")"
XML_API_URL="$(xml_escape "$API_URL")"
XML_APP_URL="$(xml_escape "$APP_URL")"
XML_API_TOKEN="$(xml_escape "$API_TOKEN")"
XML_EMAIL_TO="$(xml_escape "$EMAIL_TO")"
XML_LOG_DIR="$(xml_escape "$LOG_DIR")"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$XML_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$XML_NODE_BIN</string>
    <string>$XML_ROOT_DIR/scripts/reminder-agent.mjs</string>
    <string>--once</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$XML_ROOT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>KANBAN_API_URL</key>
    <string>$XML_API_URL</string>
    <key>KANBAN_APP_URL</key>
    <string>$XML_APP_URL</string>
    <key>KANBAN_API_TOKEN</key>
    <string>$XML_API_TOKEN</string>
    <key>KANBAN_REMINDER_EMAIL_TO</key>
    <string>$XML_EMAIL_TO</string>
  </dict>
  <key>StartInterval</key>
  <integer>$INTERVAL</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$XML_LOG_DIR/reminders.out.log</string>
  <key>StandardErrorPath</key>
  <string>$XML_LOG_DIR/reminders.err.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed $LABEL"
echo "Plist: $PLIST"
echo "Logs: $LOG_DIR/reminders.out.log and $LOG_DIR/reminders.err.log"
