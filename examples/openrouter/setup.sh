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
#   ./setup.sh --free --key sk-or-v1-...         # free-only: no spend, rate limited
#   ./setup.sh --free --expires 4h --key ...     # also record when the key dies
#   ./setup.sh --list-free                       # what is free right now
#   ./setup.sh --scope project                   # ./.claude/settings.local.json only
#   ./setup.sh --no-profile                      # skip the shell-profile block
#   ./setup.sh --opus anthropic/claude-opus-5    # pin a different Opus model
#   ./setup.sh --uninstall                       # remove everything this script added
#
# The key is stored in a 0600 file outside the repository
# ($XDG_CONFIG_HOME/openrouter/api_key). Nothing secret is ever written into a
# tracked file.
set -euo pipefail

BASE_URL="https://openrouter.ai/api"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/openrouter"
KEY_FILE="${OPENROUTER_KEY_FILE:-$CONF_DIR/api_key}"
META_FILE="${OPENROUTER_META_FILE:-$CONF_DIR/key_meta.json}"
ENV_FILE="${OPENROUTER_ENV_FILE:-$HOME/.openrouter.env}"
SCOPE="user"
WRITE_PROFILE=1
UNINSTALL=0
FREE=0
LIST_FREE=0
KEY=""
EXPIRES=""

OPUS_MODEL="${OPENROUTER_OPUS_MODEL:-anthropic/claude-opus-5}"
FABLE_MODEL="${OPENROUTER_FABLE_MODEL:-~anthropic/claude-fable-latest[1m]}"
SONNET_MODEL="${OPENROUTER_SONNET_MODEL:-~anthropic/claude-sonnet-latest[1m]}"
HAIKU_MODEL="${OPENROUTER_HAIKU_MODEL:-~anthropic/claude-haiku-latest}"
SUBAGENT_MODEL="${OPENROUTER_SUBAGENT_MODEL:-~anthropic/claude-opus-latest[1m]}"

# Free-tier presets: $0 per token, but shared account limits apply (20 req/min,
# 50 req/day below $10 of lifetime credit). Both support tool calling, which
# Claude Code requires. Ids rotate — re-check with `--list-free`.
#
# The [1m] suffix is Claude Code's own notation for "this model has a 1M context
# window": it strips it before calling the API, and stops Claude Code from
# assuming 200K. Claude Code also prints a harmless "[claude-code:unrecognized_model]"
# notice for any gateway id it does not know. For a model with a smaller window
# than 1M, drop [1m] and set CLAUDE_CODE_MAX_CONTEXT_TOKENS instead.
FREE_MAIN_MODEL="${OPENROUTER_FREE_MODEL:-thinkingmachines/inkling-small:free[1m]}"
FREE_FAST_MODEL="${OPENROUTER_FREE_FAST_MODEL:-nvidia/nemotron-3.5-lightning:free[1m]}"

BLOCK_BEGIN="# >>> claude-code openrouter >>>"
BLOCK_END="# <<< claude-code openrouter <<<"

# Every env key this script owns; --uninstall removes exactly these.
MANAGED_KEYS='["OPENROUTER_API_KEY","ANTHROPIC_BASE_URL","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_API_KEY","CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY","CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK","CLAUDE_CODE_SUBAGENT_MODEL","ANTHROPIC_DEFAULT_FABLE_MODEL","ANTHROPIC_DEFAULT_OPUS_MODEL","ANTHROPIC_DEFAULT_SONNET_MODEL","ANTHROPIC_DEFAULT_HAIKU_MODEL","ENABLE_TOOL_SEARCH","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]'

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="${2:-}"; shift 2 ;;
    --key=*) KEY="${1#*=}"; shift ;;
    --scope) SCOPE="${2:-}"; shift 2 ;;
    --scope=*) SCOPE="${1#*=}"; shift ;;
    --opus) OPUS_MODEL="${2:-}"; shift 2 ;;
    --opus=*) OPUS_MODEL="${1#*=}"; shift ;;
    --free) FREE=1; shift ;;
    --expires) EXPIRES="${2:-}"; shift 2 ;;
    --expires=*) EXPIRES="${1#*=}"; shift ;;
    --list-free) LIST_FREE=1; shift ;;
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

# --- current free catalog --------------------------------------------------
if [ "$LIST_FREE" = "1" ]; then
  key_hint="${KEY:-${OPENROUTER_API_KEY:-}}"
  if [ -z "$key_hint" ] && [ -f "$KEY_FILE" ]; then key_hint="$(tr -d '\r\n' < "$KEY_FILE")"; fi
  curl -sS -m 30 "https://openrouter.ai/api/v1/models?max_price=0" \
    ${key_hint:+-H "Authorization: Bearer $key_hint"} \
  | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const rows = JSON.parse(s).data
        .filter(m => (String(m.pricing.prompt) === "0") &&
                     (m.architecture.output_modalities || []).includes("text"))
        .map(m => {
          const p = m.supported_parameters || [];
          return { id: m.id, ctx: m.context_length,
                   tools: p.includes("tools") ? "yes" : "NO",
                   choices: p.includes("tool_choice") ? "yes" : "no",
                   ends: m.expiration_date || "" };
        })
        .sort((a, b) => (b.tools === "yes") - (a.tools === "yes") || b.ctx - a.ctx);
      console.log("free text models right now (" + rows.length + ")");
      console.log("      ctx  tools  choice  model");
      for (const r of rows) {
        console.log(String(r.ctx).padStart(9) + "  " + r.tools.padEnd(5) + "  " +
          r.choices.padEnd(6) + "  " + r.id + (r.ends ? "  (ends " + r.ends + ")" : ""));
      }
      console.log("\nClaude Code needs tool calling — use rows with tools=yes.");
      console.log("Set one with: ./setup.sh --free --key sk-or-v1-... (OPENROUTER_FREE_MODEL=<id> to override)");
    });'
  exit 0
fi

if [ "$SCOPE" = "user" ]; then
  SETTINGS_FILE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
else
  SETTINGS_FILE="$PWD/.claude/settings.local.json"
fi

# Removes the managed shell-profile block; prints the files it touched.
strip_profile_block() {
  local rc="$1"
  [ -f "$rc" ] || return 0
  node -e '
    const fs = require("fs"), [file, begin, end] = process.argv.slice(1);
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("\\n?" + esc(begin) + "[\\s\\S]*?" + esc(end) + "\\n?", "g");
    const text = fs.readFileSync(file, "utf8");
    const next = text.replace(re, "\n").replace(/\n{3,}/g, "\n\n");
    if (next !== text) { fs.writeFileSync(file, next); console.log("  cleaned " + file); }
  ' "$rc" "$BLOCK_BEGIN" "$BLOCK_END"
}

# "+4h" / "4h" / "90m" / "2d" / ISO-8601 -> epoch seconds.
parse_expiry() {
  node -e '
    const raw = process.argv[1].trim();
    const m = raw.match(/^\+?(\d+(?:\.\d+)?)\s*([smhd])$/i);
    if (m) {
      const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()];
      console.log(Math.floor(Date.now() / 1000 + parseFloat(m[1]) * mult));
    } else {
      const t = Date.parse(raw);
      if (Number.isNaN(t)) { console.error("cannot parse expiry: " + raw); process.exit(1); }
      console.log(Math.floor(t / 1000));
    }
  ' "$1"
}

# --- uninstall -------------------------------------------------------------
if [ "$UNINSTALL" = "1" ]; then
  say "Removing the OpenRouter provider from Claude Code"
  MANAGED_KEYS="$MANAGED_KEYS" node -e '
    const fs = require("fs"), file = process.argv[1];
    const keys = JSON.parse(process.env.MANAGED_KEYS);
    if (!fs.existsSync(file)) process.exit(0);
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (cfg.env && typeof cfg.env === "object") {
      for (const k of keys) delete cfg.env[k];
      if (Object.keys(cfg.env).length === 0) delete cfg.env;
    }
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
    console.log("  cleaned " + file);
  ' "$SETTINGS_FILE"
  strip_profile_block "$HOME/.bashrc"
  strip_profile_block "$HOME/.zshrc"
  rm -f "$ENV_FILE" "$KEY_FILE" "$META_FILE"
  say "Done. Start a new shell and run /login in Claude Code if you want Anthropic back."
  exit 0
fi

# --- resolve the key -------------------------------------------------------
if [ -z "$KEY" ]; then KEY="${OPENROUTER_API_KEY:-}"; fi
if [ -z "$KEY" ] && [ -f "$KEY_FILE" ]; then KEY="$(tr -d '\r\n' < "$KEY_FILE")"; fi
if [ -z "$KEY" ] && [ -t 0 ]; then
  printf 'OpenRouter API key (sk-or-v1-..., input hidden): ' >&2
  IFS= read -rs KEY || true
  printf '\n' >&2
fi
[ -n "$KEY" ] || die "no API key. Pass --key, set OPENROUTER_API_KEY, or create $KEY_FILE"
case "$KEY" in
  sk-or-v1-*) ;;
  *) die "that does not look like an OpenRouter key (expected the sk-or-v1- prefix)" ;;
esac

# --- free mode -------------------------------------------------------------
if [ "$FREE" = "1" ]; then
  FABLE_MODEL="$FREE_MAIN_MODEL"
  OPUS_MODEL="$FREE_MAIN_MODEL"
  SONNET_MODEL="$FREE_MAIN_MODEL"
  HAIKU_MODEL="$FREE_FAST_MODEL"
  SUBAGENT_MODEL="$FREE_MAIN_MODEL"
fi

for m in "$FABLE_MODEL" "$OPUS_MODEL" "$SONNET_MODEL" "$HAIKU_MODEL" "$SUBAGENT_MODEL"; do
  [ -n "$m" ] || die "empty model id"
  if [ "$FREE" = "1" ]; then
    # Ignore Claude Code's [1m] suffix and OpenRouter's ~ alias marker.
    bare="${m%\[1m\]}"
    bare="${bare#\~}"
    case "$bare" in
      *:free|openrouter/free) ;;
      *) die "model '$m' is not a :free model — free mode must not spend credits" ;;
    esac
  fi
done

# --- store the key out of band --------------------------------------------
mkdir -p "$(dirname "$KEY_FILE")" "$(dirname "$META_FILE")"
umask 077
printf '%s\n' "$KEY" > "$KEY_FILE"
chmod 600 "$KEY_FILE"

EXPIRES_AT=""
MODE="$([ "$FREE" = 1 ] && echo free || echo paid)"
if [ -n "$EXPIRES" ]; then
  EXPIRES_AT="$(parse_expiry "$EXPIRES")" || die "bad --expires value: $EXPIRES"
  node -e '
    require("fs").writeFileSync(process.argv[1], JSON.stringify({
      expires_at: Number(process.argv[2]),
      set_at: Math.floor(Date.now() / 1000),
      mode: process.argv[3],
    }, null, 2) + "\n", { mode: 0o600 });
  ' "$META_FILE" "$EXPIRES_AT" "$MODE"
elif [ -f "$META_FILE" ]; then
  EXPIRES_AT="$(node -e '
    try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).expires_at || "") }
    catch (e) {}
  ' "$META_FILE")"
fi

# --- merge the env block into the settings file ---------------------------
mkdir -p "$(dirname "$SETTINGS_FILE")"
ENV_JSON="$(MODELS="$(node -e '
  const [fable, opus, sonnet, haiku, subagent] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({ fable, opus, sonnet, haiku, subagent }));
' "$FABLE_MODEL" "$OPUS_MODEL" "$SONNET_MODEL" "$HAIKU_MODEL" "$SUBAGENT_MODEL")" \
  KEY="$KEY" FREE="$FREE" BASE_URL="$BASE_URL" node -e '
  const m = JSON.parse(process.env.MODELS);
  const env = {
    OPENROUTER_API_KEY: process.env.KEY,
    ANTHROPIC_BASE_URL: process.env.BASE_URL,
    ANTHROPIC_AUTH_TOKEN: process.env.KEY,
    // Present AND empty: merely unset makes Claude Code fall back to Anthropic.
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_SUBAGENT_MODEL: m.subagent,
    ANTHROPIC_DEFAULT_FABLE_MODEL: m.fable,
    ANTHROPIC_DEFAULT_OPUS_MODEL: m.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: m.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: m.haiku,
    ENABLE_TOOL_SEARCH: "true",
  };
  if (process.env.FREE === "1") {
    // No credit: hide the paid catalog, and stop background calls eating the
    // 50-requests-a-day free allowance.
    env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "0";
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  } else {
    env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
    env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK = "1";
  }
  process.stdout.write(JSON.stringify(env));
')"

ENV_JSON="$ENV_JSON" MANAGED_KEYS="$MANAGED_KEYS" node - "$SETTINGS_FILE" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const env = JSON.parse(process.env.ENV_JSON);
const managed = JSON.parse(process.env.MANAGED_KEYS);

let cfg = {};
if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() !== '') {
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`error: ${file} is not valid JSON (${err.message}); fix it first`);
    process.exit(1);
  }
}
// Drop keys from the other mode first (e.g. fast-mode opt-in or a stale model
// list left behind when switching to free), then apply this mode's values.
cfg.env = Object.assign({}, cfg.env);
for (const k of managed) delete cfg.env[k];
Object.assign(cfg.env, env);
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
NODE

# --- env file + shell profile ---------------------------------------------
cat > "$ENV_FILE" <<EOF
# Generated by examples/openrouter/setup.sh — contains a secret, keep it 0600.
# Sourced from your shell profile so non-Claude tools (SDKs, scripts) see it too.
export OPENROUTER_API_KEY="\${OPENROUTER_API_KEY:-$KEY}"
export ANTHROPIC_BASE_URL="$BASE_URL"
export ANTHROPIC_AUTH_TOKEN="\$OPENROUTER_API_KEY"
export ANTHROPIC_API_KEY=""
EOF
chmod 600 "$ENV_FILE"

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

# --- summary ---------------------------------------------------------------
say ""
if [ "$FREE" = "1" ]; then
  say "OpenRouter (FREE MODELS ONLY) is now the backend for Claude Code."
else
  say "OpenRouter is now the backend for Claude Code."
fi
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

if [ -n "$EXPIRES_AT" ]; then
  say ""
  say "Key expires: $(date -d "@$EXPIRES_AT" '+%Y-%m-%d %H:%M %Z' 2>/dev/null || date -r "$EXPIRES_AT" '+%Y-%m-%d %H:%M %Z' 2>/dev/null || echo "$EXPIRES_AT")"
  say "  When it does: $(dirname "$0")/setup.sh --free --expires 4h --key sk-or-v1-<new>"
fi

if [ "$FREE" = "1" ]; then
  say ""
  say "Free-tier limits (one pool shared by every :free model on the account):"
  say "  20 requests/minute, 50 requests/day until \$10 of lifetime credit is bought"
  say "  (then 1,000/day). One Claude Code turn is several requests, so expect only"
  say "  a handful of turns per day. Model discovery is off so the picker cannot"
  say "  choose a paid model, and nonessential background traffic is disabled."
  say "  See what is still free: $(dirname "$0")/setup.sh --list-free"
  say "  Change the model:       OPENROUTER_FREE_MODEL=<id>:free $(dirname "$0")/setup.sh --free"
fi

say ""
say "Next: open a NEW shell, then run 'claude' and '/status'."
say "  Expect: 'Auth token: ANTHROPIC_AUTH_TOKEN' and base URL $BASE_URL."
say "  If you were signed in to Anthropic, run /logout once first."
say "Check the credential with: $(dirname "$0")/verify.sh"
