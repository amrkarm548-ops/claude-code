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

## Quick start

```bash
# one command: stores the key, writes settings, wires the shell profile
./examples/openrouter/setup.sh --key sk-or-v1-...

# then open a NEW shell
claude
> /status      # Auth token: ANTHROPIC_AUTH_TOKEN, base URL https://openrouter.ai/api
> /model       # every model class is listed
```

Verify the credential itself (key, credit, tool use, streaming):

```bash
./examples/openrouter/verify.sh
```

## What gets configured

| Variable | Value | Why |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `https://openrouter.ai/api` | Anthropic wire format. No `/v1` — Claude Code appends `/v1/messages`. |
| `ANTHROPIC_AUTH_TOKEN` | your `sk-or-v1-…` key | Sent as `Authorization: Bearer`, which is what OpenRouter reads. |
| `ANTHROPIC_API_KEY` | `""` (present **and empty**) | Unset is not enough: a stale value makes Claude Code fall back to Anthropic auth/billing. |
| `OPENROUTER_API_KEY` | your key | Lets SDKs, scripts and subprocesses reach OpenRouter too. |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | `~anthropic/claude-fable-latest[1m]` | Long-horizon reasoning class; hidden from `/model` on a gateway unless pinned. |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `anthropic/claude-opus-5` | Pinned to a concrete ID so `/fast` actually sends `speed: "fast"`. |
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
| `/fast` says ON but bills standard | Opus alias instead of a concrete model | pin `ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic/claude-opus-5` |
| Non-Anthropic model garbles tool calls | provider doesn't implement Anthropic semantics | stick to `anthropic/*`, or test with `verify.sh --model …` |

Manage or rotate keys at <https://openrouter.ai/settings/keys>, and watch
requests live at <https://openrouter.ai/activity>.

## Files here

| File | Purpose |
|---|---|
| `setup.sh` | install, reconfigure, or uninstall the OpenRouter backend |
| `verify.sh` | end-to-end check: catalog, credit, key, text, tool use, streaming, settings |
| `settings.openrouter.json` | reference `env` block to copy into a settings file by hand |
