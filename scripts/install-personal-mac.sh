#!/usr/bin/env bash
# Personal install on one Apple Silicon Mac, for one person: the board server as a
# LaunchAgent on 127.0.0.1, Basic Memory as Claude Code's Obsidian MCP server, and a
# Claude rule for «в канбан: …». Needs no admin password; a rerun updates in place.
# Runbook: docs/personal-install.md
# The node -e programs below are single-quoted on purpose: ${...} there is JavaScript.
# shellcheck disable=SC2016
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Pinned downloads; checksums from the vendors' release pages.
NODE_VERSION="24.21.0"
NODE_SHA256="bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057"
PNPM_VERSION="10.25.0"
UV_VERSION="0.12.23"
UV_SHA256="50487ae565ccd96e499056b4674d438f4c53170202617b4c759defe0c6a1b544"
BASIC_MEMORY_VERSION="0.22.1"
BASIC_MEMORY_PYTHON="3.14"

LABEL="com.obsidian-kanban"
MCP_NAME="obsidian-basic-memory"
BM_PROJECT="obsidian"
BOARD_ID="tasks"
BOARD_NAME="Задачи"
BOARD_FILE="Задачи.md"
BOARD_COLUMNS='["Backlog","In Progress","Done"]'
MANAGED_MARK="<!-- managed by obsidian-kanban-app scripts/install-personal-mac.sh -->"
HEALTH_TIMEOUT_SECONDS=90

RUNTIME_DIR="$HOME/.local/share/obsidian-kanban"
LOCAL_BIN="$HOME/.local/bin"
NODE_DIR="$RUNTIME_DIR/node-v$NODE_VERSION"
PNPM_DIR="$RUNTIME_DIR/pnpm-$PNPM_VERSION"
UV_DIR="$RUNTIME_DIR/uv-$UV_VERSION"
BM_BIN="$LOCAL_BIN/basic-memory"
CONFIG="$ROOT_DIR/config.boards.json"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/ObsidianKanban"
RULE_FILE="$HOME/.claude/rules/obsidian-kanban.md"
RULE_TEMPLATE="$ROOT_DIR/ops/personal/claude-rule.md"
GUI_DOMAIN="gui/$(id -u)"

VAULT=""
PORT="4000"
ACTION="install"
CLAUDE_BIN=""

usage() {
  cat <<'USAGE'
Usage: scripts/install-personal-mac.sh [--vault PATH] [--port N]
       scripts/install-personal-mac.sh --uninstall

  --vault PATH  Obsidian vault folder (absolute path); default ~/Obsidian/Notes.
                Created if missing. Ignored on a rerun: config.boards.json keeps it.
  --port N      Board server port on 127.0.0.1; default 4000.
  --uninstall   Stop the board server and remove the Claude wiring. Keeps the vault,
                this checkout and the downloaded runtimes.
USAGE
}

step() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vault) [[ $# -ge 2 ]] || die "--vault needs a path"; VAULT="$2"; shift 2 ;;
    --port) [[ $# -ge 2 ]] || die "--port needs a number"; PORT="$2"; shift 2 ;;
    --uninstall) ACTION="uninstall"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  printf '%s' "$value"
}

port_in_use() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; }

check_prerequisites() {
  [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || die "this installer supports Apple Silicon Macs only"
  [[ "$(id -u)" -ne 0 ]] || die "run it as yourself, without sudo"
  [[ "$PORT" =~ ^[0-9]+$ && "$PORT" -ge 1024 && "$PORT" -le 65535 ]] || die "--port must be a number from 1024 to 65535"
  git --version >/dev/null 2>&1 || die "git is not ready: run 'xcode-select --install', finish the macOS dialog, then rerun"
}

# fetch_verified URL SHA256 DEST: download to DEST only if the checksum matches.
fetch_verified() {
  local url="$1" sha="$2" dest="$3" tmp actual
  tmp="$(mktemp "$dest.XXXXXX")"
  if ! curl -fsSL --retry 3 -o "$tmp" "$url"; then
    rm -f "$tmp"
    die "download failed: $url"
  fi
  actual="$(shasum -a 256 "$tmp" | awk '{print $1}')"
  if [[ "$actual" != "$sha" ]]; then
    rm -f "$tmp"
    die "checksum mismatch for $url (expected $sha, got $actual)"
  fi
  mv "$tmp" "$dest"
}

# unpack_verified URL SHA256 DIR: unpack a pinned tarball into DIR, once.
unpack_verified() {
  local url="$1" sha="$2" dir="$3" archive staging
  [[ -d "$dir" ]] && return 0
  mkdir -p "$RUNTIME_DIR"
  archive="$RUNTIME_DIR/download.tar.gz"
  fetch_verified "$url" "$sha" "$archive"
  staging="$(mktemp -d "$RUNTIME_DIR/unpack.XXXXXX")"
  tar -xzf "$archive" -C "$staging" --strip-components 1
  rm -f "$archive"
  mv "$staging" "$dir"
}

install_toolchain() {
  step "Node.js $NODE_VERSION and pnpm $PNPM_VERSION"
  unpack_verified "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-arm64.tar.gz" \
    "$NODE_SHA256" "$NODE_DIR"
  export PATH="$NODE_DIR/bin:$PNPM_DIR/bin:$PATH"
  if [[ ! -x "$PNPM_DIR/bin/pnpm" ]]; then
    npm install --global --prefix "$PNPM_DIR" --no-audit --no-fund "pnpm@$PNPM_VERSION" >/dev/null
  fi
  node --version
  pnpm --version
}

build_app() {
  step "Board app: dependencies and web build"
  (cd "$ROOT_DIR" && CI=1 pnpm install --frozen-lockfile)
  # A Node change leaves a native module built for the old ABI.
  if ! (cd "$ROOT_DIR/apps/api" && node -e "new (require('better-sqlite3'))(':memory:').close()" 2>/dev/null); then
    (cd "$ROOT_DIR" && pnpm rebuild better-sqlite3)
  fi
  (cd "$ROOT_DIR" && pnpm --filter @kanban/web build)
}

# The vault lives in config.boards.json once written; a rerun keeps it.
resolve_vault() {
  if [[ -e "$CONFIG" ]]; then
    local configured
    configured="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).vaultRoot || ""))' "$CONFIG")" \
      || die "$CONFIG is not valid JSON; fix or remove it, then rerun"
    [[ -n "$configured" ]] || die "$CONFIG has no vaultRoot"
    if [[ -n "$VAULT" && "$VAULT" != "$configured" ]]; then
      die "$CONFIG already uses the vault $configured; rerun without --vault, or remove that file to start over"
    fi
    VAULT="$configured"
  fi
  [[ -n "$VAULT" ]] || VAULT="$HOME/Obsidian/Notes"
  [[ "$VAULT" == /* ]] || die "--vault must be an absolute path"
}

write_config() {
  step "Boards and vault"
  if [[ -e "$CONFIG" ]]; then
    echo "Keeping $CONFIG (vault $VAULT)"
    return 0
  fi
  mkdir -p "$VAULT"
  [[ -e "$VAULT/$BOARD_FILE" ]] || printf '# %s\n\n' "$BOARD_NAME" > "$VAULT/$BOARD_FILE"
  node -e '
    const fs = require("fs");
    const [target, vaultRoot, id, name, file, columnsJson] = process.argv.slice(1);
    const columns = JSON.parse(columnsJson);
    const body = JSON.stringify({ vaultRoot, boards: [{ id, name, file, columns }], defaultColumns: columns }, null, 2) + "\n";
    const tmp = `${target}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, target);
  ' "$CONFIG" "$VAULT" "$BOARD_ID" "$BOARD_NAME" "$BOARD_FILE" "$BOARD_COLUMNS"
  echo "Board \"$BOARD_NAME\" → $VAULT/$BOARD_FILE"
}

write_plist() {
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE_DIR/bin/node")</string>
    <string>--import</string>
    <string>tsx</string>
    <string>src/index.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$ROOT_DIR/apps/api")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>SERVE_STATIC</key>
    <string>1</string>
    <key>HOST</key>
    <string>127.0.0.1</string>
    <key>PORT</key>
    <string>$(xml_escape "$PORT")</string>
    <key>PATH</key>
    <string>$(xml_escape "$NODE_DIR/bin"):/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_DIR/api.out.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_DIR/api.err.log")</string>
</dict>
</plist>
PLIST
}

stop_server() {
  launchctl bootout "$GUI_DOMAIN/$LABEL" >/dev/null 2>&1 || true
  local waited=0
  while port_in_use && [[ $waited -lt 10 ]]; do sleep 1; waited=$((waited + 1)); done
}

start_server() {
  step "Board server on http://127.0.0.1:$PORT"
  stop_server
  port_in_use && die "port $PORT is used by another program; rerun with --port and a free number, e.g. --port 4100"
  write_plist
  launchctl bootstrap "$GUI_DOMAIN" "$PLIST"
  local waited=0 health=""
  while [[ $waited -lt $HEALTH_TIMEOUT_SECONDS ]]; do
    health="$(curl -fsS -m 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
    if [[ -n "$health" ]] && node -e 'process.exit(JSON.parse(process.argv[1]).ok === true ? 0 : 1)' "$health" 2>/dev/null; then
      echo "Server is up"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  tail -n 20 "$LOG_DIR/api.err.log" >&2 2>/dev/null || true
  die "the board server did not answer within ${HEALTH_TIMEOUT_SECONDS}s; its log is $LOG_DIR/api.err.log"
}

install_basic_memory() {
  step "Basic Memory $BASIC_MEMORY_VERSION (Obsidian access for Claude)"
  unpack_verified "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-aarch64-apple-darwin.tar.gz" \
    "$UV_SHA256" "$UV_DIR"
  if [[ -x "$BM_BIN" ]]; then
    echo "Keeping the installed $("$BM_BIN" --version 2>/dev/null | tail -n 1)"
  else
    "$UV_DIR/uv" tool install --python "$BASIC_MEMORY_PYTHON" "basic-memory==$BASIC_MEMORY_VERSION"
  fi
  [[ -x "$BM_BIN" ]] || die "basic-memory did not land in $LOCAL_BIN"

  local bm_config="$HOME/.basic-memory/config.json" current=""
  if [[ -f "$bm_config" ]]; then
    current="$(node -e '
      const projects = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).projects || {};
      const entry = projects[process.argv[2]];
      process.stdout.write(entry ? String(typeof entry === "string" ? entry : entry.path || "") : "");
    ' "$bm_config" "$BM_PROJECT")" || die "$bm_config is not valid JSON"
  fi
  if [[ -z "$current" ]]; then
    "$BM_BIN" project add "$BM_PROJECT" "$VAULT" --default
  elif [[ "$current" != "$VAULT" ]]; then
    die "Basic Memory project '$BM_PROJECT' already points to $current, not $VAULT; remove it with 'basic-memory project remove $BM_PROJECT' and rerun"
  else
    echo "Project '$BM_PROJECT' → $VAULT"
  fi
}

find_claude() {
  if command -v claude >/dev/null 2>&1; then
    CLAUDE_BIN="$(command -v claude)"
  elif [[ -x "$LOCAL_BIN/claude" ]]; then
    CLAUDE_BIN="$LOCAL_BIN/claude"
  fi
}

wire_claude() {
  step "Claude Code: Obsidian tools and the kanban rule"
  find_claude
  if [[ -z "$CLAUDE_BIN" ]]; then
    echo "Installing the Claude Code command line (official installer, claude.ai)"
    curl -fsSL https://claude.ai/install.sh | bash -s stable
    find_claude
    [[ -n "$CLAUDE_BIN" ]] || die "the Claude Code installer did not produce $LOCAL_BIN/claude"
  fi
  "$CLAUDE_BIN" mcp remove --scope user "$MCP_NAME" >/dev/null 2>&1 || true
  "$CLAUDE_BIN" mcp add --scope user "$MCP_NAME" -- "$BM_BIN" mcp --project "$BM_PROJECT"

  mkdir -p "$(dirname "$RULE_FILE")"
  if [[ -e "$RULE_FILE" ]] && ! head -n 1 "$RULE_FILE" | grep -qF -- "$MANAGED_MARK"; then
    die "$RULE_FILE exists and was not written by this installer; move it away and rerun"
  fi
  node -e '
    const fs = require("fs");
    const [template, target, mark, apiUrl, mcpName, project] = process.argv.slice(1);
    const body = mark + "\n" + fs.readFileSync(template, "utf8")
      .replaceAll("{{API_URL}}", apiUrl)
      .replaceAll("{{MCP_NAME}}", mcpName)
      .replaceAll("{{BM_PROJECT}}", project);
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, body, { mode: 0o644, flag: "wx" });
    fs.renameSync(tmp, target);
  ' "$RULE_TEMPLATE" "$RULE_FILE" "$MANAGED_MARK" "http://127.0.0.1:$PORT" "$MCP_NAME" "$BM_PROJECT"
  echo "Rule → $RULE_FILE"
}

verify_install() {
  step "Check"
  local boards
  boards="$(curl -fsS -m 5 "http://127.0.0.1:$PORT/api/boards")" || die "the board API stopped answering"
  node -e '
    const boards = JSON.parse(process.argv[1]).filter((b) => !b.archived);
    if (boards.length === 0) { console.error("no active boards"); process.exit(1); }
    for (const b of boards) console.log(`Board ${b.id} "${b.name}": ${b.totalCards} cards`);
  ' "$boards" || die "the board API returned no active board"
  local mcp_status
  mcp_status="$("$CLAUDE_BIN" mcp get "$MCP_NAME" 2>&1 || true)"
  [[ "$mcp_status" == *Connected* ]] \
    || die "Claude Code cannot start $MCP_NAME; run '$CLAUDE_BIN mcp get $MCP_NAME' for details"
  echo "Claude Code reaches $MCP_NAME"
}

uninstall() {
  step "Uninstall"
  launchctl bootout "$GUI_DOMAIN/$LABEL" >/dev/null 2>&1 || true
  rm -f "$PLIST"
  find_claude
  if [[ -n "$CLAUDE_BIN" ]]; then
    "$CLAUDE_BIN" mcp remove --scope user "$MCP_NAME" >/dev/null 2>&1 || true
  fi
  if [[ -e "$RULE_FILE" ]] && head -n 1 "$RULE_FILE" | grep -qF -- "$MANAGED_MARK"; then
    rm -f "$RULE_FILE"
  fi
  echo "Removed the board server, $MCP_NAME and the rule."
  echo "Kept: the vault, $ROOT_DIR, $RUNTIME_DIR and $BM_BIN."
}

if [[ "$ACTION" == "uninstall" ]]; then
  uninstall
  exit 0
fi

check_prerequisites
install_toolchain
resolve_vault
build_app
write_config
start_server
install_basic_memory
wire_claude
verify_install

cat <<DONE

Done.
  Board:     http://localhost:$PORT
  Vault:     $VAULT  (open it in Obsidian: "Open folder as vault")
  Claude:    start a NEW Claude Code session, then say «в канбан: …»
  Update:    git -C "$ROOT_DIR" pull --ff-only && "$ROOT_DIR/scripts/install-personal-mac.sh"
DONE
