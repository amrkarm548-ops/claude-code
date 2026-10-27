#!/usr/bin/env bash
# Point Claude Code at OpenRouter as its AI backend.
#
# Writes the OpenRouter credential + provider environment into Claude Code's
# settings file (and optionally your shell profile), so that every Claude Code
# session — main model, subagents, background tasks, /model picker and /fast —
# is served by OpenRouter instead of Anthropic directly.
#
# Usage:
#   ./setup.sh --key sk-or-v1-...                # user scope (all projects)
#   ./setup.sh                                   # prompts for the key
#   OPENROUTER_API_KEY=sk-or-v1-... ./setup.sh   # key from the environment
#   ./setup.sh --scope project                   # ./.claude/settings.local.json only
#   ./setup.sh --no-profile                      # skip the shell-profile block
#   ./setup.sh --opus anthropic/claude-opus-4.6  # pin a different Opus model
#   ./setup.sh --uninstall                       # remove everything this script added
#
# The key is stored in a 0600 file outside the repository
# ($XDG_CONFIG_HOME/openrouter/api_key). Nothing secret is ever written into a
# tracked file.
set -euo pipefail

BASE_URL="https://openrouter.ai/api"
KEY_FILE="${OPENROUTER_KEY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/openrouter/api_key}"
ENV_FILE="${OPENROUTER_ENV_FILE:-$HOME/.openrouter.env}"
SCOPE="user"
WRITE_PROFILE=1
UNINSTALL=0
KEY=""

OPUS_MODEL="${OPENROUTER_OPUS_MODEL:-anthropic/claude-opus-5}"
FABLE_MODEL="${OPENROUTER_FABLE_MODEL:-~anthropic/claude-fable-latest[1m]}"
SONNET_MODEL="${OPENROUTER_SONNET_MODEL:-~anthropic/claude-sonnet-latest[1m]}"
HAIKU_MODEL="${OPENROUTER_HAIKU_MODEL:-~anthropic/claude-haiku-latest}"
SUBAGENT_MODEL="${OPENROUTER_SUBAGENT_MODEL:-~anthropic/claude-opus-latest[1m]}"

BLOCK_BEGIN="# >>> claude-code openrouter >>>"
BLOCK_END="# <<< claude-code openrouter <<<"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

usage() { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="${2:-}"; shift 2 ;;
    --key=*) KEY="${1#*=}"; shift ;;
    --scope) SCOPE="${2:-}"; shift 2 ;;
    --scope=*) SCOPE="${1#*=}"; shift ;;
    --opus) OPUS_MODEL="${2:-}"; shift 2 ;;
    --opus=*) OPUS_MODEL="${1#*=}"; shift ;;
    --no-profile) WRITE_PROFILE=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

case "$SCOPE" in
  user|project) ;;
  *) die "--scope must be 'user' or 'project'" ;;
esac

command -v node >/dev/null 2>&1 || die "node is required (Claude Code needs Node.js 18+)"

if [ "$SCOPE" = "user" ]; then
  SETTINGS_FILE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
else
  SETTINGS_FILE="$PWD/.claude/settings.local.json"
fi

settings_dir="$(dirname "$SETTINGS_FILE")"
mkdir -p "$settings_dir"

# --- uninstall -------------------------------------------------------------
strip_profile_block() {
  local rc="$1"
  [ -f "$rc" ] || return 0
  node -e '
    const fs = require("fs"), [file, begin, end] = process.argv.slice(1);
    const text = fs.readFileSync(file, "utf8");
    const re = new RegExp("\n?" + begin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]*?" +
                          end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\n?", "g");
    const next = text.replace(re, "\n").replace(/\n{3,}/g, "\n\n");
    if (next !== text) { fs.writeFileSync(file, next); console.log("  cleaned " + file); }
  ' "$rc" "$BLOCK_BEGIN" "$BLOCK_END"
}

if [ "$UNINSTALL" = "1" ]; then
  say "Removing the OpenRouter provider from Claude Code"
  node -e '
    const fs = require("fs"), file = process.argv[1];
    if (!fs.existsSync(file)) process.exit(0);
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    const keys = ["OPENROUTER_API_KEY","ANTHROPIC_BASE_URL","ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY","CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
      "CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK","CLAUDE_CODE_SUBAGENT_MODEL",
      "ANTHROPIC_DEFAULT_FABLE_MODEL","ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL","ANTHROPIC_DEFAULT_HAIKU_MODEL","ENABLE_TOOL_SEARCH"];
    if (cfg.env && typeof cfg.env === "object") {
      for (const k of keys) delete cfg.env[k];
      if (Object.keys(cfg.env).length === 0) delete cfg.env;
    }
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  ' "$SETTINGS_FILE"
  say "  cleaned $SETTINGS_FILE"
  strip_profile_block "$HOME/.bashrc"
  strip_profile_block "$HOME/.zshrc"
  rm -f "$ENV_FILE" "$KEY_FILE"
  say "Done. Start a new shell and run /login in Claude Code if you want Anthropic back."
  exit 0
fi

# --- resolve the key -------------------------------------------------------
if [ -z "$KEY" ]; then
  KEY="${OPENROUTER_API_KEY:-}"
fi
if [ -z "$KEY" ] && [ -f "$KEY_FILE" ]; then
  KEY="$(tr -d '\r\n' < "$KEY_FILE")"
fi
if [ -z "$KEY" ]; then
  if [ -t 0 ]; then
    printf 'OpenRouter API key (sk-or-v1-..., input hidden): ' >&2
    IFS= read -rs KEY || true
    printf '\n' >&2
  fi
fi

[ -n "$KEY" ] || die "no API key. Pass --key, set OPENROUTER_API_KEY, or create $KEY_FILE"

case "$KEY" in
  sk-or-v1-*) ;;
  *) die "that does not look like an OpenRouter key (expected the sk-or-v1- prefix)" ;;
esac

# --- store the key out of band --------------------------------------------
mkdir -p "$(dirname "$KEY_FILE")"
umask 077
printf '%s\n' "$KEY" > "$KEY_FILE"
chmod 600 "$KEY_FILE"

cat > "$ENV_FILE" <<EOF
# Generated by examples/openrouter/setup.sh — contains a secret, keep it 0600.
# Sourced from your shell profile so non-Claude tools (SDKs, scripts) see it too.
export OPENROUTER_API_KEY="\${OPENROUTER_API_KEY:-$KEY}"
export ANTHROPIC_BASE_URL="$BASE_URL"
export ANTHROPIC_AUTH_TOKEN="\$OPENROUTER_API_KEY"
export ANTHROPIC_API_KEY=""
EOF
chmod 600 "$ENV_FILE"

# --- merge the env block into Claude Code settings ------------------------
KEY="$KEY" MODELS="$(node -e '
  const [fable, opus, sonnet, haiku, subagent] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({ fable, opus, sonnet, haiku, subagent }));
' "$FABLE_MODEL" "$OPUS_MODEL" "$SONNET_MODEL" "$HAIKU_MODEL" "$SUBAGENT_MODEL")" node - "$SETTINGS_FILE" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const key = process.env.KEY;
const models = JSON.parse(process.env.MODELS);

let cfg = {};
if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() !== '') {
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`error: ${file} is not valid JSON (${err.message}); fix it first`);
    process.exit(1);
  }
}
cfg.env = Object.assign({}, cfg.env, {
  OPENROUTER_API_KEY: key,
  ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
  ANTHROPIC_AUTH_TOKEN: key,
  // Must be present AND empty: unset makes Claude Code fall back to Anthropic auth.
  ANTHROPIC_API_KEY: '',
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: '1',
  CLAUDE_CODE_SUBAGENT_MODEL: models.subagent,
  ANTHROPIC_DEFAULT_FABLE_MODEL: models.fable,
  ANTHROPIC_DEFAULT_OPUS_MODEL: models.opus,
  ANTHROPIC_DEFAULT_SONNET_MODEL: models.sonnet,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: models.haiku,
  ENABLE_TOOL_SEARCH: 'true',
});
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
NODE

# --- shell profile --------------------------------------------------------
if [ "$WRITE_PROFILE" = "1" ]; then
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -e "$rc" ] || continue
    strip_profile_block "$rc" >/dev/null
    {
      printf '\n%s\n' "$BLOCK_BEGIN"
      printf '# OpenRouter as the Claude Code provider (managed by examples/openrouter/setup.sh)\n'
      printf '[ -f "%s" ] && . "%s"\n' "$ENV_FILE" "$ENV_FILE"
      printf '%s\n' "$BLOCK_END"
    } >> "$rc"
    say "  updated $rc"
  done
fi

chmod 600 "$SETTINGS_FILE" 2>/dev/null || true

say ""
say "OpenRouter is now the backend for Claude Code."
say "  settings : $SETTINGS_FILE"
say "  key file : $KEY_FILE (0600)"
say "  env file : $ENV_FILE (0600)"
say ""
say "Models"
say "  fable    : $FABLE_MODEL"
say "  opus     : $OPUS_MODEL"
say "  sonnet   : $SONNET_MODEL"
say "  haiku    : $HAIKU_MODEL"
say "  subagent : $SUBAGENT_MODEL"
say ""
say "Next: open a NEW shell, then run 'claude' and '/status'."
say "  Expect: 'Auth token: ANTHROPIC_AUTH_TOKEN' and base URL $BASE_URL."
say "  If you were signed in to Anthropic, run /logout once first."
say "Check the credential with: $(dirname "$0")/verify.sh"
