#!/usr/bin/env bash
# Verify that the configured OpenRouter credential really works as Claude
# Code's backend: key valid, credit available, Anthropic-format /v1/messages
# reachable, tool use and streaming passed through.
#
#   ./verify.sh                 # use the stored key / OPENROUTER_API_KEY
#   ./verify.sh --key sk-or-... # test a specific key
#   ./verify.sh --model anthropic/claude-opus-5 --model deepseek/deepseek-chat
#
# Exits non-zero on the first failed check.
set -uo pipefail

KEY_FILE="${OPENROUTER_KEY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/openrouter/api_key}"
BASE="https://openrouter.ai"
MODELS=()
KEY="${OPENROUTER_API_KEY:-}"
FAILED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="${2:-}"; shift 2 ;;
    --key=*) KEY="${1#*=}"; shift ;;
    --model) MODELS+=("${2:-}"); shift 2 ;;
    --model=*) MODELS+=("${1#*=}"); shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$KEY" ] || { [ -f "$KEY_FILE" ] && KEY="$(tr -d '\r\n' < "$KEY_FILE")"; }
[ -n "$KEY" ] || { echo "FAIL  no key (run setup.sh first or pass --key)" >&2; exit 2; }
[ "${#MODELS[@]}" -gt 0 ] || MODELS=("${OPENROUTER_TEST_MODEL:-anthropic/claude-haiku-latest}")

command -v curl >/dev/null || { echo "FAIL  curl is required" >&2; exit 2; }

ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; FAILED=1; }
head2() { printf '\n%s\n' "$*"; }

api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -m 60 -X "$method" "$BASE$path"
    -H "Authorization: Bearer $KEY"
    -H "Content-Type: application/json"
    -H "HTTP-Referer: https://github.com/anthropics/claude-code"
    -H "X-Title: Claude Code")
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}"
}

OFFLINE=0
head2 "1. Reachability and model catalog"
catalog="$(api GET /api/v1/models)"
count="$(printf '%s' "$catalog" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    try { const j = JSON.parse(s); if (j.data && j.data.length) return console.log(j.data.length); }
    catch (e) {}
    process.exit(1);
  });' 2>/dev/null)" || true
if [ -n "$count" ]; then
  ok "catalog reachable ($count models listed)"
else
  bad "cannot reach $BASE/api/v1/models from this machine"
  echo "        (no DNS/TLS egress to openrouter.ai, or an HTTP proxy is not configured)" >&2
  echo "        skipping the live model checks; the settings are still inspected below" >&2
  OFFLINE=1
fi

if [ "$OFFLINE" = "0" ]; then

head2 "2. Key and credit"
credits="$(api GET /api/v1/credits)"
if printf '%s' "$credits" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const j = JSON.parse(s).data;
    if (!j) throw new Error(j);
    console.log(`total ${j.total_credits} used ${j.total_usage} left ${(j.total_credits - j.total_usage).toFixed(4)}`);
  });' 2>/dev/null | sed 's/^/  ok    /'; then
  :
else
  echo "  FAIL  key rejected or credits endpoint unavailable:" >&2
  printf '%s\n' "$credits" | head -c 300 >&2; echo >&2
  echo "        revoke/rotate at https://openrouter.ai/settings/keys" >&2
  FAILED=1
fi

keyinfo="$(api GET /api/v1/key)"
printf '%s' "$keyinfo" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const j = JSON.parse(s).data || {};
    const bits = [j.label ? `label ${j.label}` : null,
                  j.limit === null || j.limit === undefined ? "no spend cap" : `limit ${j.limit}`,
                  j.is_free_tier ? "free tier" : "paid tier",
                  j.usage !== undefined ? `usage ${j.usage}` : null].filter(Boolean);
    console.log("  ok    key: " + bits.join(", "));
  });' 2>/dev/null || true

for model in "${MODELS[@]}"; do
  head2 "3. Anthropic /v1/messages + tool use  [$model]"

  plain="$(api POST /api/v1/messages "$(node -e '
    const m = process.argv[1];
    console.log(JSON.stringify({ model: m, max_tokens: 64,
      messages: [{ role: "user", content: "Reply with exactly: pong" }] }));
  ' "$model")")"

  text="$(printf '%s' "$plain" | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const j = JSON.parse(s);
      if (j.error) { console.error(JSON.stringify(j.error).slice(0, 200)); process.exit(1); }
      const c = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
      if (!c) process.exit(1);
      console.log(c.trim().replace(/\s+/g, " ").slice(0, 80));
    });' 2>/tmp/verify.err)" || true
  if [ -n "$text" ]; then ok "text completion: \"$text\""; else bad "no text in response $(cat /tmp/verify.err)"; fi

  tools="$(api POST /api/v1/messages "$(node -e '
    const m = process.argv[1];
    console.log(JSON.stringify({
      model: m, max_tokens: 256, tool_choice: { type: "auto" },
      tools: [{ name: "get_weather", description: "Get the weather for a city",
                input_schema: { type: "object", properties: { city: { type: "string" } },
                                required: ["city"] } }],
      messages: [{ role: "user", content: "What is the weather in Cairo? Use the tool." }]
    }));
  ' "$model")")"

  tool="$(printf '%s' "$tools" | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const j = JSON.parse(s);
      if (j.error) { console.error(JSON.stringify(j.error).slice(0, 200)); process.exit(1); }
      const t = (j.content || []).find(b => b.type === "tool_use");
      if (!t) process.exit(1);
      console.log(t.name + " " + JSON.stringify(t.input));
    });' 2>/tmp/verify.err)" || true
  if [ -n "$tool" ]; then ok "tool use: $tool"; else bad "model did not emit a tool_use block $(cat /tmp/verify.err)"; fi

  stream="$(curl -sS -m 60 -N "$BASE/api/v1/messages" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    -d "$(node -e 'console.log(JSON.stringify({model: process.argv[1], max_tokens: 32, stream: true,
          messages: [{role: "user", content: "count: one two three"}]}))' "$model")" \
    | head -c 4000)"
  if printf '%s' "$stream" | grep -q 'event: \(message_start\|content_block_delta\)'; then
    ok "streaming SSE passed through"
  else
    bad "streaming did not return Anthropic SSE events"
  fi
done

fi  # end live checks

head2 "4. Claude Code settings"
settings="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
if [ -f "$settings" ]; then
  node -e '
    const fs = require("fs"); const e = (JSON.parse(fs.readFileSync(process.argv[1], "utf8")).env) || {};
    const checks = [
      ["ANTHROPIC_BASE_URL", v => v === "https://openrouter.ai/api"],
      ["ANTHROPIC_AUTH_TOKEN", v => typeof v === "string" && /^sk-or-/.test(v)],
      ["ANTHROPIC_API_KEY", v => v === ""],
      ["ANTHROPIC_DEFAULT_OPUS_MODEL", v => !!v],
      ["ANTHROPIC_DEFAULT_SONNET_MODEL", v => !!v],
      ["ANTHROPIC_DEFAULT_HAIKU_MODEL", v => !!v],
    ];
    let ok = true;
    for (const [k, test] of checks) {
      const good = test(e[k]);
      ok = ok && good;
      console.log(`  ${good ? "ok  " : "FAIL"}  ${k}=${JSON.stringify(e[k])}`);
    }
    process.exit(ok ? 0 : 1);
  ' "$settings" || FAILED=1
else
  bad "no settings file at $settings (run setup.sh)"
fi

echo
if [ "$FAILED" = "0" ]; then
  echo "PASS — OpenRouter is ready as the Claude Code backend."
else
  echo "FAIL — see the messages above." >&2
fi
exit "$FAILED"
