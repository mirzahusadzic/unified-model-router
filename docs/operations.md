# Services and troubleshooting

Run, check, debug, and roll back the router. The router and Codex's app-server daemon are separate processes, and restarting either interrupts its active requests.

| After | Restart |
| --- | --- |
| Running the installer | Nothing: it restarts the router and a running Codex daemon, and pins the daemon to the CLI's Codex ([why](setup.md#daemon-updates)) |
| `--no-service`, `CODEX_ROUTER_RESTART_DAEMON=0`, or a manual configuration change | The Codex daemon: `codex app-server daemon restart` |
| Changing the router's installed code or service environment by hand | The router; see [Service management](#service-management) |
| Switching models in a thread on the unified provider | Nothing |

---

### Verify an installation

```sh
node install.mjs --verify
```

The verifier checks four parts of the installation:

- **Configuration:** The main and OpenRouter-only configurations, their matching local tokens and private permissions, and the managed apps and agent settings
- **Catalog:** The entries and their rendered prompts
- **Router:** The installed router and every module beside it match this repository; local health advertises the supported routing policy, the revision precondition, and the installed source's revision. The process answering health must be the service's own or one it started, so redirects, stale running copies, and stray copies of the same code fail.
- **Startup:** The platform's startup setup, and the Codex daemon pinned to the CLI's Codex

The verifier does not check upstream keys or model access.

---

### Service management

| Platform | Status | Restart | Logs (`info`, `error`) |
| --- | --- | --- | --- |
| macOS | `launchctl print "gui/$(id -u)/com.mirza.codex-unified-router"` | `launchctl kickstart -k "gui/$(id -u)/com.mirza.codex-unified-router"` | `~/Library/Logs/codex-unified-router.log`, `~/Library/Logs/codex-unified-router.error.log` |
| Linux | `systemctl --user status codex-unified-router.service` | `systemctl --user restart codex-unified-router.service` | Both in the user journal: `journalctl --user -u codex-unified-router.service -f` |
| Windows | None; check the log files | Rerun the installer | `router.log`, `router.error.log` in `%USERPROFILE%\.codex\unified-router` (or `%CODEX_HOME%\unified-router`) |

- **Linux after logout:** `loginctl enable-linger "$USER"` keeps the user service running, if your system policy allows it.
- **Windows startup:** the installer puts `Codex Unified Router.vbs` in the current user's Startup folder; it starts a hidden supervisor from `unified-router/start-router.cmd`.

---

### Install without automatic startup

| Command | Does |
| --- | --- |
| `node install.mjs --no-service` | Writes the configuration and router files, without registering or starting a service |
| `node install.mjs --verify --no-service` | Checks those files |

Both still need Codex and an OpenRouter key; pass `--api-key-file` when no terminal is available for the prompt.

---

### Structured logs

The router writes one JSON object per line, on every platform. Logs never include request or response bodies, authorization headers, API keys, the router token, cookies, or environment values.

| `CODEX_ROUTER_LOG_LEVEL` | Records |
| --- | --- |
| `error` (default) | Errors, on standard error |
| `info` | Also successful requests and timings, on standard output |
| `debug` | Accepted, for future diagnostic detail |

- **Where to set it:** `unified-router/openrouter.env`, which the installer keeps, or the service environment, which it regenerates.
- **Correlation:** one request's events share a `requestId`; upstream events add `generationId`, `providerName`, `upstreamRequestId`, and `cloudflareRayId` when the headers are present.

#### Read the logs

Each platform keeps the logs in its own place; see [Service management](#service-management). Define a `logs` function once, and the examples on this page run unchanged with [`jq`](https://jqlang.org/), which the router itself does not need; `info` events need `CODEX_ROUTER_LOG_LEVEL=info`.

The function keeps only the router's JSON lines, because a crashed Node process can leave a stack trace among them. On macOS, it reads both log files:

```sh
logs() {
  cat ~/Library/Logs/codex-unified-router{,.error}.log \
    | grep '^{"'
}
```

On Linux, it reads the user journal:

```sh
logs() {
  journalctl --user -u codex-unified-router.service -o cat \
    | grep '^{"'
}
```

Tool-history repairs and errors:

```sh
logs | jq -c 'select(.event == "history.repaired"
  or .level == "error")'
```

Every event of one request:

```sh
logs | jq -c --arg id "<request-id>" \
  'select(.requestId == $id)'
```

On Windows, a PowerShell `logs` returns the parsed events, which `Where-Object` filters:

```powershell
function logs {
  $codexHome = $env:CODEX_HOME
  if (-not $codexHome) { $codexHome = "$HOME\.codex" }
  $dir = Join-Path $codexHome 'unified-router'
  Get-Content "$dir\router.log", "$dir\router.error.log" |
    Where-Object { $_.StartsWith('{"') } |
    ForEach-Object { $_ | ConvertFrom-Json }
}
logs | Where-Object {
  $_.event -eq 'history.repaired' -or $_.level -eq 'error'
}
```

#### Events

Each table answers a question with the event and fields to look for, and each example uses the `logs` function above.

##### Router

| To find out | Look for |
| --- | --- |
| Did the router start, with which keys and code? | `router.ready`: listener address, which keys are set, the running source `revision` |
| Why did the router stop? | `router.shutdown`: the signal |
| Why did the router fail to start? | `router.listen_failed`: host, port, and `errorCode`, such as `EADDRINUSE` when another process holds the port, or `ERR_SOCKET_BAD_PORT` for an invalid port; the service starts the router again until the port is free |

```sh
logs | jq -c 'select(.event == "router.ready")
  | {port, openrouterConfigured, anthropicConfigured,
     revision}'
```

##### Requests

| To find out | Look for |
| --- | --- |
| What went upstream? | `request.forwarded`: route, model, attempt, payload SHA-256, byte length, input item count, routing policy |
| Did the router change the request? | `request.forwarded`: `providerOrder`, `dataCollection`, `structuredOutputAdapted` (DeepSeek JSON mode), `promptCachingAdded` (Claude's `cache_control`), `promptCache` (a caller's `X-Codex-Router-Prompt-Cache`, else `default`), `webSearchOverride`, a reset of OpenRouter response state, and tool-history repairs |
| Which tool records were repaired? | `history.repaired`: invalid, duplicate, unanswered, or orphaned tool records, and native tool declarations, before an OpenRouter request |
| Were numbers in tool arguments rewritten? | `tool_arguments.normalized`: the tool whose whole-number floats became integers |
| How did the request end, and how long did it take? | `request.finished`: local HTTP status (`error` level when `status >= 400`) and total duration; `request.aborted`: the client disconnected first |

```sh
logs | jq -c 'select(.event == "request.forwarded")
  | {model, attempt, providerOrder, dataCollection,
     promptCachingAdded, promptCache}'
```

##### Upstream

| To find out | Look for |
| --- | --- |
| How fast did the upstream answer? | `upstream.response_started`: status and time to headers; `upstream.response_finished`: final status and total duration; both with trace identifiers, at `error` level when `status >= 400` |
| How many tokens, and how many were cached? | `upstream.usage` (`info` level only): the provider's own counts, such as `input_tokens`, `input_tokens_details.cached_tokens`, `cache_write_tokens`, `output_tokens`, and OpenRouter's `cost` in credits; `cached_tokens` over `input_tokens` is the cache hit rate |
| Did the connection fail? | `upstream.error`: `errorCode` and duration |

```sh
logs | jq -c 'select(.event == "upstream.usage")
  | {model, usage}'
```

##### Web search

| To find out | Look for |
| --- | --- |
| Did a search run, and what did it cost? | `web_search.executed`: result count, failure, duration, and OpenRouter's `cost`; never the query |
| Did the response continue after the search? | `web_search.continuation`: its status; `web_search.continuation_failed`: it broke off, and Codex received a `[router diagnostic]` |
| Were searches dropped? | `web_search.limit_reached`: a step asked for more than eight |
| Why did the stream stop being rewritten? | `web_search.stream_passthrough`: an oversized event switched it to plain pass-through |
| Were saved results lost? | `web_search.persist_failed`: not saved; `web_search.load_failed`: not read at startup, so earlier searches show as no longer available |

```sh
logs | jq -c 'select(.event == "web_search.executed")
  | {results, failed, durationMs, cost}'
```

##### OpenRouter

| To find out | Look for |
| --- | --- |
| Why was a step rejected? | `openrouter.request_rejected`: a pre-stream 400 from OpenRouter or Anthropic's API (`provider`), with payload hash, input count, generation and request identifiers, `contextOverflow`, and the response body's hash, never the body |
| What did the retry send? | `openrouter.recovery_attempt`: payload hash, compaction strategy, counts of retained, dropped, and dropped encrypted-reasoning items, and `omissionNotice` |
| Why did Codex get a diagnostic instead of an answer? | `openrouter.fallback_completion`: the retry failed too; `openrouter.refused`: HTTP 401, 402, 403, or 404, with `dataPolicy` true when, after a native OpenAI or Claude model, no endpoint that does not collect data was available |
| Why is a captured body missing? | `openrouter.rejection_capture_failed`: it could not be written; `openrouter.rejection_capture_refused`: its Windows location is not the private router directory |

```sh
logs | jq -c 'select(.event // "" | startswith("openrouter."))'
```

##### Anthropic

| To find out | Look for |
| --- | --- |
| Did Claude fall back to OpenRouter? | `anthropic.refused`: `reason` (`billing` for spent credits or your spend limit, `enforced_spend_limit_reached`, or another error type), `fallback`, and `continuation` for the step after a web search; Claude requests then use OpenRouter for an hour |
| Why did Claude stop? | `anthropic.stop`: `stopReason`, and a refusal's `category`; `anthropic.stream_error`: an error in the middle of the stream, and the failure code Codex received |
| Was earlier thinking dropped? | `anthropic.thinking_dropped`: block count and reasons, such as compaction or a model switch |
| Is the key a sign-in token? | `anthropic.sign_in_token_ignored`: the router does not use it |

```sh
logs | jq -c 'select(.event == "anthropic.refused")
  | {model, reason, fallback}'
```

##### Sessions

| To find out | Look for |
| --- | --- |
| Why was a request refused with HTTP 409? | `session.provider_isolation`: the recorded and requested sides; `session.forked_lead_context`: a spawned agent sent an Ultra Spark lead's tool call IDs to a training-tier model, with the model and the number of matching IDs (`forkedCallIds`) |
| Were session records lost? | `session.isolation_persist_failed`, `session.isolation_load_failed`: sides not saved, or not read at startup, so sessions start without one; `claude.routes_persist_failed`, `claude.routes_load_failed`: the same for Claude routes, so sessions pick their route again |

```sh
logs | jq -c 'select(.event == "session.provider_isolation")
  | {model, recordedSide, side}'
```

#### Rejected steps

| Rejection | What happens |
| --- | --- |
| Pre-stream 400 for a context-window overflow | No retry. Codex receives a streamed `response.failed` with `context_length_exceeded` and compacts, as for a native model; `openrouter.request_rejected` records `contextOverflow: true`. |
| Any other pre-stream 400 | One retry without encrypted reasoning items, which are bound to the provider that produced them, and with a long history trimmed (next row). No retry when neither changes the request. |
| A history over 80 items or 1 MiB | The retry keeps Codex's context (the first developer message and up to 16 user and developer messages after it, which carry `AGENTS.md`, environment context, and any compaction summary), the current developer message, the latest user message, and the newest items that fit. A `[router note]` after the context tells the model that earlier history was omitted. |
| The retry is rejected too | Codex receives a completed response with the diagnostic below. The rejection stays in the error log, never as model output. |
| A pre-stream 400 from Anthropic's API | The same rules; the retry leaves out Claude's thinking, and the diagnostic names Anthropic. |
| An Anthropic refusal no retry fixes, such as spent credits | The request moves to OpenRouter; see [Claude's two routes](routing.md#claudes-two-routes). |

```text
[router diagnostic] OpenRouter rejected this step. The thread is intact; retry or start a new thread.
```

#### Capture rejected requests

Off by default. Set the directory in `~/.codex/unified-router/openrouter.env` or the service environment, and restart the router:

```sh
CODEX_ROUTER_REJECTED_REQUEST_DIR=<private directory>
```

- **What it keeps:** each rejected request body and up to 256 KiB of its response body, as `<requestId>-attempt-<n>.request.json` and `.response.json`. For Claude on Anthropic's API, the request file is Codex's Responses request before translation; the logged payload hash and size describe that body.
- **macOS and Linux:** the router creates the directory with mode `700` and each file with mode `600`.
- **Windows:** file modes do not restrict access, so only `unified-router` itself is accepted, and new files inherit its current-user-only access list. Other locations are refused with `openrouter.rejection_capture_refused`.

> [!WARNING]
> The files can contain the whole conversation. Keep them out of synchronized folders such as Dropbox, iCloud Drive, OneDrive, or a network share, and out of commits and messages.

#### Cache and token accounting

- **Source of truth:** Codex's session JSONL. Each `token_usage_record` holds `input_tokens`, `cached_input_tokens`, and `cache_write_input_tokens`, and the file names the active model.
- **Correlation:** router events carry the same `sessionId` as the session file's `session_id` (Codex's `session-id` header, `session_id` in earlier versions). Keep the session file and the router logs together, but never append the logs to the session file.

A session's cache-read share:

```sh
jq -s '
  [.[] | select(.type == "token_usage_record") | .payload.usage] as $usage
  | ($usage | map(.input_tokens) | add // 0) as $input
  | ($usage | map(.cached_input_tokens) | add // 0) as $cached
  | {input_tokens: $input, cached_input_tokens: $cached,
     cache_read_share: (if $input > 0 then $cached / $input else null end)}
' ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
```

---

### Rollback

Each installer run prints its backup directory; stop the router and its automatic startup before restoring.

> [!IMPORTANT]
> Backups cover Codex's configuration and catalog, not the router's code (`unified-router/*.mjs`) or `unified-router/openrouter.env`. Copy those before upgrading if you may want them back.

#### Return to an earlier Codex version

Each `codex-<version>` tag marks the last commit verified with that Codex version; the [tags page](https://github.com/mirzahusadzic/codex-unified-model-router/tags) and `git tag -l 'codex-*'` list them.

```sh
npm install -g @openai/codex@0.163.0
git checkout codex-0.163.0
node install.mjs
codex app-server daemon update --from-cli --yes
node install.mjs --verify
```

- **The `update --from-cli` step** pins the daemon to the CLI you installed: installers before `codex-0.164.0` do not pin it, and a daemon pinned by a later installer keeps the later Codex.
- **Kept:** the stored key, the local token, and the isolation records.
- **To come back:** `git checkout main`, install the Codex version it is tested with, and rerun `node install.mjs`.

#### Stop automatic startup

macOS:

```sh
plist=~/Library/LaunchAgents/com.mirza.codex-unified-router.plist
launchctl bootout "gui/$(id -u)" "$plist"
mv "$plist" ~/.Trash/
```

Linux:

```sh
systemctl --user disable --now codex-unified-router.service
rm ~/.config/systemd/user/codex-unified-router.service
systemctl --user daemon-reload
```

Windows, stopping the supervisor and the router before removing the Startup entry:

```powershell
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$routerDir = Join-Path $codexHome 'unified-router'
$routerFile = Join-Path $routerDir 'router.mjs'
$startCmd = Join-Path $routerDir 'start-router.cmd'
Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -and (
      ($_.CommandLine.IndexOf($routerFile, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $_.CommandLine -match '(?i)(^|[\\/"])node(\.exe)?([" ]|$)') -or
      ($_.CommandLine.IndexOf($startCmd, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $_.CommandLine -match '(?i)(cmd\.exe|wscript\.exe|start-router\.cmd)')
    )
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

$startupEntry = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Unified Router.vbs'
Remove-Item -LiteralPath $startupEntry
```

#### Restore configuration

Restore only files present in the backup; a missing one did not exist before that installation. On macOS and Linux, with the backup path the installer printed:

```sh
backup_dir="$HOME/.codex/backups/codex-unified-router-YYYYMMDD-HHMMSS-PID"
cp -p "$backup_dir/config.toml" "$HOME/.codex/config.toml"
cp -p "$backup_dir/models.json" "$HOME/.codex/models.json"
```

| File in the backup | Restore |
| --- | --- |
| `config.toml`, `models.json` | Always; on Windows or with a custom `CODEX_HOME`, copy them into that Codex home |
| `unified-openrouter.config.toml` | If you use the OpenRouter-only profile |
| `deepseek.config.toml.retired` | As `deepseek.config.toml`, only if you still use the old `--profile deepseek` setup |

- **Router threads:** threads keep their provider, and Codex 0.166.0 refuses to continue one under another. Continue a router thread with `-c model_provider=unified` while the router runs, or start a new thread.
- **Back to before the router:** remove the generated counterpart of each file missing from the backup, and move `unified-router/` aside once the restored configuration no longer refers to it, so the stored key, local token, isolation records, and service files go with it.
- **The daemon:** the installer pinned it to the CLI's Codex; `codex app-server daemon update` returns it to production updates.
- **Then:** restart Codex and its daemon (`codex app-server daemon restart`), and start new threads.

---

### Troubleshooting

| Symptom | Check |
| --- | --- |
| Something broke after a Codex update | Compare `codex --version` and `codex app-server daemon version` with the tested version in [Codex version](setup.md#codex-version). Install it with `npm install -g @openai/codex@0.166.0`, then rerun `node install.mjs`, which also pins the daemon. |
| A new model is missing from `/model` | Rerun the installer to rebuild the catalog, then restart Codex. |
| OpenAI models are missing from `/model` | They are hidden without an active ChatGPT plan; install with `CODEX_ROUTER_NATIVE_MODELS=show` to list them anyway. |
| Ultra Spark does not spawn workers | Select `ultra-spark/deepseek-v4.1-flash-1017` ("· Ultra Spark") in a new thread, and rerun the installer so the catalog carries the current policy. Small single-step tasks run without workers by design. |
| HTTP 409 `provider_isolation` | The session already used the other side: native OpenAI or Claude, or Muse or Ultra Spark. Start a new thread; see [Provider isolation](routing.md#provider-isolation). |
| Muse requests fail before reaching a model | Allow endpoints that may train on inputs in your OpenRouter privacy settings, and check that OpenRouter guardrails allow the Muse provider. |
| A thread still uses the previous provider | [Activate the unified provider](setup.md#activate-the-provider) and start a new thread. |
| The local endpoint is unavailable | Check the service status and the router's error log. |
| The installer or verifier reports another router process answering | A router outside the service holds port 18766, and the service's own copy keeps failing with `router.listen_failed`. Stop the process the verifier names, then rerun the installer. |
| HTTP 401 about the router token | The client has an older configuration: rerun the installer, restart other open Codex windows, and start a new thread. |
| OpenRouter returns HTTP 401 | Replace the stored key with `node install.mjs --change-api-key`, or `--api-key-file <path>` without a terminal. |
| Structured output from DeepSeek misses a field or is wrapped in another key | DeepSeek gets the schema as an instruction, not an enforced format: validate the JSON in the caller, and check `structuredOutputAdapted` in `request.forwarded`. Frequent wrapping in a key named after the response format means an older installed router: rerun the installer. |
| Switching to OpenAI produces a reasoning-content error | Update and restart the installed router so history normalization is active. |
| OpenRouter rejects a step | Codex should stay in the thread with a `[router diagnostic]`, or compact after a context-window error; run `/compact` if it does not. Follow `openrouter.request_rejected`, `openrouter.recovery_attempt`, and `openrouter.fallback_completion` by `requestId`, and [capture the body](#capture-rejected-requests) before reproducing if you need it. |
| Replies are slow | Check upstream header timings and request durations. Headers can arrive before model output, so these do not measure first-token latency. |
