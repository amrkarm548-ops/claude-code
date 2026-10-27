# Claude Code on OpenRouter

Run Claude Code with **OpenRouter as its AI backend**: every request — main
model, subagents, background/summarization tasks, the `/model` picker, `/fast`
and tool use — goes to OpenRouter instead of Anthropic directly.

OpenRouter exposes an Anthropic-compatible `/v1/messages` endpoint ("Anthropic
skin"), so no local proxy is needed. Claude Code speaks its native protocol
straight to `https://openrouter.ai/api`.

```
Claude Code ──/v1/messages──▶ https://openrouter.ai/api ──▶ anthropic/claude-*
 (ANTHROPIC_BASE_URL)           (OpenRouter routing)         openai/*, google/*, …
```

## Quick start — one command

```bash
./examples/openrouter/env.sh --install --free --expires 4h --key sk-or-v1-...
```

`env.sh` runs the whole environment in five checked steps and is safe to re-run:

1. **prerequisites** — Node ≥ 18, npm
2. **CLI** — finds `claude`, or installs `@anthropic-ai/claude-code` with `--install`
3. **config** — writes the key + provider env (`--free` for free-only models)
4. **verify** — settings, key expiry, and — when the network allows — a live
   `/v1/messages` call with tool use and streaming
5. **dashboard** — starts the web UI on port 4173 and prints the URL

```bash
./env.sh --check      # re-verify an existing setup
./env.sh --stop       # stop the dashboard it started
./env.sh --demo       # prove the wiring with no network at all
```

Then, in a new shell:

```bash
claude
> /status      # Auth token: ANTHROPIC_AUTH_TOKEN, base URL https://openrouter.ai/api
> /model       # every model class is listed
```

Lower-level pieces, if you prefer them separately:

```bash
./examples/openrouter/setup.sh --free --key sk-or-v1-...   # config only
./examples/openrouter/verify.sh                            # checks only
node examples/openrouter/dashboard/server.mjs              # dashboard only
```

## Free-only mode (no credit on the account)

A key with no balance can only use models whose id ends in `:free`. Free mode
pins every model class to a free model, refuses to write a paid model at all,
and turns off the features that would silently cost money or burn the daily
allowance:

```bash
./examples/openrouter/setup.sh --free --expires 4h --key sk-or-v1-...
./examples/openrouter/setup.sh --list-free      # what is free right now
```

| | paid setup | `--free` setup |
|---|---|---|
| model classes | `anthropic/claude-*` | `:free` ids only (script rejects anything else) |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` (picker) | `0` — the picker can't hand you a paid model |
| `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK` | `1` | removed (no fast mode without credit) |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | — | `1` — no background calls eating free requests |

**The limits are the real constraint.** Every `:free` model on the account
shares one pool: **20 requests/minute**, and **50 requests/day** until the
account has bought $10 of credit in its lifetime (then 1,000/day). One Claude
Code turn is several requests (tool loop + summaries), so plan for a handful of
turns per day, not an all-day session. `verify.sh` prints the daily budget and
the expiry countdown.

**Expiring keys.** `--expires 4h` (or `90m`, `2d`, an ISO timestamp) is recorded
in `${XDG_CONFIG_HOME:-~/.config}/openrouter/key_meta.json`; `verify.sh` then
shows a countdown and fails once the key is dead, so you notice before Claude
Code starts returning 401s. Renew with the same command and a fresh key — it
overwrites the old one everywhere.

**Free model ids rotate.** They are added and retired constantly
(`poolside/laguna-*:free` even carries an `expiration_date`). `--list-free`
prints the live list with context size and whether each one supports tool
calling — Claude Code needs tool calling, so only `tools=yes` rows are usable.
Override the choice without editing files:

```bash
OPENROUTER_FREE_MODEL=poolside/laguna-s-2.1:free \
OPENROUTER_FREE_FAST_MODEL=nvidia/nemotron-3.5-lightning:free \
  ./examples/openrouter/setup.sh --free --key sk-or-v1-...
```

Free models are also weaker at long agentic loops than Claude; keep tasks small
and expect the agent to need more nudges.

## Run it

```bash
claude                      # interactive
claude -p "explain src/x.ts" # headless
> /status                   # Auth token: ANTHROPIC_AUTH_TOKEN, base URL https://openrouter.ai/api
> /model                    # the classes you pinned
```

`claude --version` should report 2.1.x or newer; `claude update` upgrades.

### Gateway model ids and the context window

Claude Code only knows Anthropic's own ids, so on a gateway it prints a harmless
notice per unknown id:

```
Claude Code doesn't recognize the model "thinkingmachines/inkling-small:free",
so it assumes a context window of 200k tokens.
[claude-code:unrecognized_model] ...
```

Two things follow from that:

- **`[1m]` suffix** — for a model with a 1M window, write the id as
  `thinkingmachines/inkling-small:free[1m]`. Claude Code strips the suffix
  before the request (the API only ever sees `thinkingmachines/inkling-small:free`)
  and assumes 1M instead of 200K. `--free` presets already do this; `verify.sh`
  and the dashboard strip it too.
- **Any other window** — set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the real size,
  e.g. `262144` for `google/gemma-4-31b-it:free`. Without `[1m]` (or a `claude-`
  id) the variable applies on its own.

The notice itself is expected on a gateway and can be ignored; it does not
affect requests.

### Prove the wiring without a network

If the machine you are on cannot reach `openrouter.ai`, run Claude Code against
the bundled stand-in. It answers with a fixed string — it is not a model — but
it shows settings, model resolution, tool declaration, streaming and output all
work:

```bash
node examples/openrouter/dashboard/dev-mock-server.mjs &     # :8787
CLAUDE_CONFIG_DIR=/tmp/demo claude -p "hi"                   # point a throwaway config at it
curl -s localhost:8787/__log                                  # what it received
```

The log line proves the important part: the request arrives as
`{"model":"thinkingmachines/inkling-small:free","stream":true,"tools":12,"auth":"present"}`.

## Dashboard (live status + playground)

A zero-dependency web UI that reads the real config and can test the key:

```bash
node examples/openrouter/dashboard/server.mjs      # http://localhost:4173
PORT=8080 HOST=127.0.0.1 node examples/openrouter/dashboard/server.mjs
```

It shows:

- every settings check (base URL, auth token, the deliberately empty
  `ANTHROPIC_API_KEY`, free-only models, discovery state);
- the masked key and its source, plus a **live countdown** to `--expires`;
- the free catalog (live, falling back to a bundled snapshot when there is no
  egress) with context size, tool-calling and vision flags;
- a **real test button** that sends `/v1/messages` with a tool definition — the
  same call shape Claude Code uses — and prints latency, usage and the model
  that actually served it;
- a small chat box for a quick sanity check;
- credit balance and the free-tier request caps.

The key is read server-side only and reported masked; it never reaches the
browser. When the host running the dashboard cannot reach `openrouter.ai`, the
page says so up front instead of looking like a bad config.

## What gets configured

| Variable | Value | Why |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `https://openrouter.ai/api` | Anthropic wire format. No `/v1` — Claude Code appends `/v1/messages`. |
| `ANTHROPIC_AUTH_TOKEN` | your `sk-or-v1-…` key | Sent as `Authorization: Bearer`, which is what OpenRouter reads. |
| `ANTHROPIC_API_KEY` | `""` (present **and empty**) | Unset is not enough: a stale value makes Claude Code fall back to Anthropic auth/billing. |
| `OPENROUTER_API_KEY` | your key | Lets SDKs, scripts and subprocesses reach OpenRouter too. |
| `ANTHROPIC_MODEL` | the main model | Session default. Without it a gateway session asks for Claude Code's built-in default id, which OpenRouter may not serve. |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | `~anthropic/claude-fable-latest[1m]` | Long-horizon reasoning class; hidden from `/model` on a gateway unless pinned. |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `anthropic/claude-opus-5` | Pinned to a concrete ID so `/fast` actually sends `speed: "fast"`. `--free` swaps this for a `:free` model. |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `~anthropic/claude-sonnet-latest[1m]` | General coding. |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `~anthropic/claude-haiku-latest` | Quick completions, titles, summaries. |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `~anthropic/claude-opus-latest[1m]` | Task/subagent fan-out. |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` | Unlocks the gateway model picker (curated top models, not the whole catalog). |
| `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK` | `1` | `/fast` works without an Anthropic org. |
| `ENABLE_TOOL_SEARCH` | `true` | Tool search across a large tool set stays available. |

Every model class can be repointed, e.g. to run the whole agent on a
non-Anthropic model:

```bash
./setup.sh --key sk-or-v1-... --opus deepseek/deepseek-chat
# or afterwards:
export ANTHROPIC_DEFAULT_SONNET_MODEL="openrouter/auto"   # let OpenRouter pick
```

OpenRouter only *guarantees* Claude Code compatibility for Anthropic
first-party models; other providers work but may not implement every
Anthropic-only feature (thinking blocks, prompt caching). If a non-Anthropic
model misbehaves, pin back to `anthropic/*`.

## Where the files go

| Path | Contents | Permissions |
|---|---|---|
| `~/.claude/settings.json` (or `./.claude/settings.local.json` with `--scope project`) | the `env` block above, merged into your existing settings | `0600` |
| `${XDG_CONFIG_HOME:-~/.config}/openrouter/api_key` | the raw key, single line | `0600` |
| `~/.openrouter.env` | `export` lines sourced from your shell profile | `0600` |
| `~/.bashrc`, `~/.zshrc` | one guarded block sourcing `~/.openrouter.env` | — |

The key is **never** written into this repository or any tracked file — read it
back from the key file, or from the environment:

```bash
export ANTHROPIC_AUTH_TOKEN="$(cat ~/.config/openrouter/api_key)"
```

Override the locations with `OPENROUTER_KEY_FILE`, `OPENROUTER_ENV_FILE`,
`CLAUDE_CONFIG_DIR`, or skip the profile edit with `--no-profile`.

## Undo

```bash
./examples/openrouter/setup.sh --uninstall   # also removes the key file
```

Then start a new shell and run `/logout` in Claude Code if you want to sign in
to Anthropic again.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Every request 401 / `No auth credentials` | key defined after the line that expands it, or `ANTHROPIC_API_KEY` holds a stale value | re-run `setup.sh`; it writes the key file first, then references it |
| Requests still bill Anthropic | `ANTHROPIC_API_KEY` unset rather than empty | it must be `""`, not absent |
| `/status` shows a Claude account | a cached login wins over the gateway credential | `/logout`, then relaunch |
| `404 /v1/v1/messages` | `ANTHROPIC_BASE_URL` ends in `/v1` or `/` | use exactly `https://openrouter.ai/api` |
| Model not found (`openrouter/auto`, picker entry) | stale settings / discovery off | `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` and restart Claude Code |
| `404` on a `:free` model that worked yesterday | the free id was retired | `setup.sh --list-free`, then re-run with `--free` |
| `429` mid-session | 20 RPM or the 50/1,000 RPD free cap | wait for `Retry-After`; free mode is meant for short sessions |
| `402 insufficient credits` | account balance negative (blocks free models too) | free mode only works on a zero/positive balance |
| `/fast` missing | free mode removes the org-check bypass | expected: fast mode needs credit |
| `/fast` says ON but bills standard | Opus alias instead of a concrete model | pin `ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic/claude-opus-5` |
| Non-Anthropic model garbles tool calls | provider doesn't implement Anthropic semantics | stick to `anthropic/*`, or test with `verify.sh --model …` |

Manage or rotate keys at <https://openrouter.ai/settings/keys>, and watch
requests live at <https://openrouter.ai/activity>.

## Files here

| File | Purpose |
|---|---|
| `env.sh` | one command: prerequisites → CLI → config → verify → dashboard (`--demo`, `--check`, `--stop`) |
| `setup.sh` | install, reconfigure (`--free`, `--expires`), `--list-free`, or `--uninstall` |
| `verify.sh` | end-to-end check: catalog, credit, key, text, tool use, streaming, settings |
| `settings.openrouter.json` | reference `env` block (paid / Claude models) |
| `settings.openrouter-free.json` | reference `env` block for free-only mode |
| `dashboard/` | web UI: status, free catalog, key test, chat (`server.mjs`, no deps) |
| `dashboard/report.mjs` | bakes a standalone HTML report (no server, no network) |
| `dashboard/dev-mock-server.mjs` | local Anthropic-shaped stand-in, for offline wiring checks |
