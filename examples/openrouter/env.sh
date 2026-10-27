#!/usr/bin/env bash
# One command to get a working Claude Code + OpenRouter environment.
#
#   ./env.sh --free --key sk-or-v1-...        # set up, verify, start the dashboard
#   ./env.sh --free --expires 4h --key ...    # same, and track when the key dies
#   ./env.sh --install --free --key ...       # also install the Claude Code CLI
#   ./env.sh --check                          # re-verify an existing setup
#   ./env.sh --demo                           # prove the wiring offline (stand-in server)
#   ./env.sh --stop                           # stop the dashboard it started
#
# Steps: prerequisites → CLI → credential/config → verification → dashboard.
# Safe to re-run: every step is idempotent.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD="$HERE/dashboard/server.mjs"
MOCK="$HERE/dashboard/dev-mock-server.mjs"
LOG="${TMPDIR:-/tmp}/openrouter-dashboard.log"
PID_FILE="${TMPDIR:-/tmp}/openrouter-dashboard.pid"
PORT="${PORT:-4173}"

KEY=""
FREE=0
EXPIRES=""
INSTALL=0
CHECK=0
DEMO=0
STOP=0
DASHBOARD_ON=1
SETUP_ARGS=()

say() { printf '%s\n' "$*"; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; }

usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="${2:-}"; shift 2 ;;
    --key=*) KEY="${1#*=}"; shift ;;
    --free) FREE=1; shift ;;
    --expires) EXPIRES="${2:-}"; shift 2 ;;
    --expires=*) EXPIRES="${1#*=}"; shift ;;
    --install) INSTALL=1; shift ;;
    --check) CHECK=1; shift ;;
    --demo) DEMO=1; shift ;;
    --stop) STOP=1; shift ;;
    --no-dashboard) DASHBOARD_ON=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done

# --- stop ------------------------------------------------------------------
if [ "$STOP" = "1" ]; then
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    kill "$(cat "$PID_FILE")" && rm -f "$PID_FILE"
    say "dashboard stopped"
  else
    say "dashboard is not running (no PID file)"
  fi
  exit 0
fi

# --- 1. prerequisites ------------------------------------------------------
step "1/5 prerequisites"
if ! command -v node >/dev/null 2>&1; then
  bad "Node.js not found — install Node 18 or newer: https://nodejs.org"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  bad "Node $NODE_MAJOR is too old — Claude Code needs 18+"
  exit 1
fi
ok "node $(node -v) at $(command -v node)"
if command -v npm >/dev/null 2>&1; then ok "npm $(npm -v)"; else warn "npm missing (only needed for --install)"; fi

# --- 2. Claude Code CLI ----------------------------------------------------
step "2/5 Claude Code CLI"
if command -v claude >/dev/null 2>&1; then
  ok "claude $(claude --version 2>&1 | head -1 | tr -d '\n')"
elif [ "$INSTALL" = "1" ]; then
  say "  installing @anthropic-ai/claude-code globally…"
  if npm i -g @anthropic-ai/claude-code >/dev/null 2>&1 && command -v claude >/dev/null 2>&1; then
    ok "installed claude $(claude --version 2>&1 | head -1)"
  else
    bad "npm install failed. Alternatives:"
    say "     curl -fsSL https://claude.ai/install.sh | bash       # macOS / Linux"
    say "     brew install --cask claude-code                      # Homebrew"
    exit 1
  fi
else
  warn "claude is not installed — re-run with --install to add it"
fi

# --- demo (offline wiring proof) ------------------------------------------
if [ "$DEMO" = "1" ]; then
  step "demo: Claude Code → local stand-in server"
  MOCK_PORT="${MOCK_PORT:-8787}"
  node "$MOCK" >"${TMPDIR:-/tmp}/openrouter-mock.log" 2>&1 &
  MOCK_PID=$!
  trap 'kill "$MOCK_PID" 2>/dev/null' EXIT
  for _ in $(seq 1 40); do
    curl -s -m 1 "http://127.0.0.1:$MOCK_PORT/__log" >/dev/null 2>&1 && break
    sleep 0.25
  done
  if ! command -v claude >/dev/null 2>&1; then
    bad "claude CLI missing — run with --install"
    exit 1
  fi
  DEMO_DIR="${TMPDIR:-/tmp}/openrouter-demo-config"
  rm -rf "$DEMO_DIR"; mkdir -p "$DEMO_DIR"
  cat > "$DEMO_DIR/settings.json" <<JSON
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:$MOCK_PORT",
    "ANTHROPIC_AUTH_TOKEN": "demo-token",
    "ANTHROPIC_API_KEY": "",
    "ANTHROPIC_MODEL": "thinkingmachines/inkling-small:free[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "thinkingmachines/inkling-small:free[1m]",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
JSON
  say "  running: claude -p \"say pong\" against 127.0.0.1:$MOCK_PORT"
  DEMO_OUT="$(CLAUDE_CONFIG_DIR="$DEMO_DIR" timeout 90 claude -p "say pong" 2>&1 | tail -3)"
  printf '%s\n' "$DEMO_OUT" | sed 's/^/    /'
  say ""
  say "  request the stand-in received:"
  curl -s "http://127.0.0.1:$MOCK_PORT/__log" | sed 's/^/    /'
  say ""
  if printf '%s' "$DEMO_OUT" | grep -q "stand-in server"; then
    ok "wiring works: settings → model → tools → streaming → output"
    warn "the reply came from the stand-in, not a model: this host has no egress to openrouter.ai"
  else
    bad "demo did not complete — see the output above"
    exit 1
  fi
  exit 0
fi

# --- 3. credential + config ------------------------------------------------
if [ "$CHECK" = "0" ]; then
  step "3/5 configuring the OpenRouter provider"
  [ "$FREE" = "1" ] && SETUP_ARGS+=(--free)
  [ -n "$KEY" ] && SETUP_ARGS+=(--key "$KEY")
  [ -n "$EXPIRES" ] && SETUP_ARGS+=(--expires "$EXPIRES")
  if ! "$HERE/setup.sh" "${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}" >"${TMPDIR:-/tmp}/openrouter-setup.log" 2>&1; then
    bad "setup failed:"
    sed 's/^/    /' "${TMPDIR:-/tmp}/openrouter-setup.log"
    exit 1
  fi
  grep -E '^  (settings|key file|env file)' "${TMPDIR:-/tmp}/openrouter-setup.log" | sed 's/^ */  /'
  ok "settings written"
else
  step "3/5 configuration (skipped, --check)"
fi

# --- 4. verification -------------------------------------------------------
step "4/5 verification"
VERIFY_OUT="$("$HERE/verify.sh" 2>&1)"
printf '%s\n' "$VERIFY_OUT" | grep -E '^  (ok|FAIL|note)' | sed 's/^ */  /'
if printf '%s' "$VERIFY_OUT" | grep -q "cannot reach https://openrouter.ai"; then
  warn "this host has no egress to openrouter.ai — the settings are verified, the live calls are not."
  warn "run ./env.sh --check on your own machine for the full pass."
  NET_BLOCKED=1
else
  if printf '%s' "$VERIFY_OUT" | grep -q "PASS —"; then ok "live checks passed"; NET_BLOCKED=0; else bad "verification failed"; NET_BLOCKED=0; fi
fi

# --- 5. dashboard ----------------------------------------------------------
step "5/5 dashboard"
if [ "$DASHBOARD_ON" = "0" ]; then
  say "  skipped (--no-dashboard)"
elif curl -s -m 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  ok "a dashboard is already answering on http://localhost:$PORT"
elif [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null || echo 0)" 2>/dev/null; then
  ok "already running (pid $(cat "$PID_FILE")) on port $PORT"
else
  # setsid/nohup so the dashboard outlives the shell that launched it.
  PORT="$PORT" setsid nohup node "$DASHBOARD" >"$LOG" 2>&1 &
  DASH_PID=$!
  echo "$DASH_PID" > "$PID_FILE"
  for _ in $(seq 1 40); do
    curl -s -m 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
    sleep 0.25
  done
  if curl -s -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    ok "listening on http://localhost:$PORT (pid $DASH_PID, log $LOG)"
  else
    bad "dashboard did not start — see $LOG"
    rm -f "$PID_FILE"
  fi
fi

# --- summary ---------------------------------------------------------------
step "next"
say "  1) open a new shell (or: exec bash -l) so the env file is sourced"
say "  2) claude"
say "  3) /status   →  expect: Auth token: ANTHROPIC_AUTH_TOKEN"
say "                  Anthropic base URL: https://openrouter.ai/api"
say "  4) /logout once, if you were signed in to Anthropic before"
say ""
if command -v claude >/dev/null 2>&1; then
  say "  headless smoke test on your machine:  claude -p \"reply with pong\""
fi
say "  dashboard:  http://localhost:$PORT        (stop with: $0 --stop)"
say "  re-check:   $0 --check"
say "  offline demo: $0 --demo"
[ "${NET_BLOCKED:-0}" = "1" ] && say ""
[ "${NET_BLOCKED:-0}" = "1" ] && say "  note: no egress to openrouter.ai from this host, so model calls cannot run here."
exit 0
