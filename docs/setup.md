# Setup and configuration

The [README](../README.md) has the commands most installations need. This page covers what the installer changes, every setting it reads, and the models in the catalog; [How routing works](routing.md) covers what the router does with each request.

- [Installation](#installation): what changes, [installer settings](#installer-settings), and [activating the provider](#activate-the-provider)
- [Router settings](#router-settings): runtime options in `unified-router/openrouter.env`, including [endpoint preferences](#openrouter-endpoint-preferences)
- [Managed Codex configuration](#managed-codex-configuration): the Codex settings the installer owns, and the [OpenRouter-only profile](#openrouter-only-profile)
- [Models](#models): DeepSeek, Muse, Claude, Ultra Spark, and [adding a model](#add-a-model)
- [License and template provenance](#license-and-template-provenance)

---

### Installation

The [README](../README.md#install) has the commands. This section covers what the installer changes, the settings it reads, and how to start using the router.

#### What the installer changes

The installer configures `~/.codex`, or `CODEX_HOME` when set. Each run:

1. Backs up the existing configuration and catalog files.
2. Builds `models.json` from Codex's bundled models and every entry in [`catalog/`](../catalog/), hiding native OpenAI models without an active ChatGPT plan.
3. Merges its [managed settings](#managed-codex-configuration) into `config.toml`, preserving everything else.
4. Merges transport settings into `unified-openrouter.config.toml`, the [OpenRouter-only profile](#openrouter-only-profile).
5. Installs the router and stores the OpenRouter key under `unified-router/`.
6. Starts the router as a service, checks its health, and restarts a running Codex app-server daemon.

The helper scripts behind these steps are listed in [CONTRIBUTING.md](../CONTRIBUTING.md#scripts).

#### Installer settings

Pass settings to `node install.mjs` as flags or environment variables on every run; the installer stores none of them, and `node install.mjs --help` summarizes them. An unknown flag or invalid value stops it before it asks anything or changes a file.

```sh
node install.mjs --api-key-file ~/openrouter.key
CODEX_ROUTER_NATIVE_MODELS=hide CODEX_ROUTER_AGENT_THREADS=6 \
  node install.mjs
```

```powershell
$env:CODEX_ROUTER_NATIVE_MODELS = 'hide'
node install.mjs
```

- **Platform scripts:** `install.mjs` runs `platform/unix/install.sh` or `platform/windows/install.ps1` and translates its flags; run directly, the Windows script spells them `-Force`, `-NoService`, `-ChangeApiKey`, and `-ApiKeyFile`.
- **Verifier:** run it with the same `CODEX_ROUTER_DISABLE_APPS`, `CODEX_ROUTER_DISABLE_GUARDIAN`, `CODEX_ROUTER_DISABLE_ANALYTICS`, `CODEX_ROUTER_AGENT_THREADS`, `CODEX_ROUTER_SANDBOX_NETWORK`, and `CODEX_ROUTER_PIN_DAEMON` values.

| Setting | Values | Effect |
| --- | --- | --- |
| `--verify` | flag | Verifies an existing installation instead of installing; accepts `--no-service`. |
| `--force` | flag | Merges into an existing configuration without asking. Needed only where no terminal is available for the question, such as in scripts. |
| `--no-service` | flag | Writes configuration and router files without starting a service or restarting the Codex daemon. |
| `--change-api-key` | flag | Asks for a new OpenRouter key, hidden as you type, and replaces the stored one. Needs a terminal; use `--api-key-file` in scripts. |
| `--api-key-file <path>` | file path; also `--api-key-file=<path>` | Reads the OpenRouter key from the file, which must contain one key line, and replaces any stored key. Without it, the first install asks for the key without echoing it, and later installs reuse the stored key. |
| `OPENROUTER_API_KEY` | API key | Also supplies or replaces the key, for automation that cannot use a file. Prefer the prompt or `--api-key-file`: environment variables can leak to other processes and logs. |
| `CODEX_HOME` | path; default `~/.codex` | Codex home directory to configure. |
| `CODEX_ROUTER_NATIVE_MODELS` | `auto` (default), `show`, `hide` | Whether native OpenAI models appear in `/model`. See [Native OpenAI models](#native-openai-models). |
| `CODEX_ROUTER_DISABLE_APPS` | `1` (default), `0` | `1` turns off Codex's ChatGPT connector tools; `0` leaves them to you. See [ChatGPT apps](#chatgpt-apps). |
| `CODEX_ROUTER_DISABLE_GUARDIAN` | `1` (default), `0` | `1` turns off Codex's guardian, which sends the agent transcript to OpenAI to review some actions; `0` leaves it to you. See [Codex guardian](#codex-guardian). |
| `CODEX_ROUTER_DISABLE_ANALYTICS` | `1` (default), `0` | `1` turns off Codex analytics; `0` leaves them to you. See [Codex analytics](#codex-analytics). |
| `CODEX_ROUTER_AGENT_THREADS` | `10` (default), `1`–`999`, `0` | Spawned-agent limit per session; `0` leaves it to Codex. See [Spawned-agent limit](#spawned-agent-limit). |
| `CODEX_ROUTER_SANDBOX_NETWORK` | `0` (default), `1` | `1` lets shell commands in Codex's sandbox reach the network without asking; `0` leaves it to you. See [Sandbox network access](#sandbox-network-access). |
| `CODEX_ROUTER_RESTART_DAEMON` | `1` (default), `0` | `0` skips restarting a running Codex app-server daemon. See [Activate the provider](#activate-the-provider). |
| `CODEX_ROUTER_PIN_DAEMON` | `1` (default), `0` | `1` pins the Codex app-server daemon to the CLI's Codex, so it stops updating itself; `0` leaves its updates to Codex. See [Daemon updates](#daemon-updates). |

#### Codex version

The router is tested with Codex **0.166.0**, and newer versions can change what it relies on. `node install.mjs` warns, without stopping, when the CLI or the running daemon differs; `codex app-server daemon version` shows both.

| Codex | Changed for the router |
| --- | --- |
| 0.163.0 | Renamed the `session_id` header to `session-id` |
| 0.164.0 | Began recording native models' tool declarations in thread history |
| 0.166.0 | Refuses to continue a thread under a provider other than the one it was created with |

| To | Do |
| --- | --- |
| Install the tested version | `npm install -g @openai/codex@0.166.0` |
| Change Codex versions | Install the CLI version you want, rerun `node install.mjs`, which rebuilds the catalog from its bundled models and pins the daemon to it, then run `node install.mjs --verify` |
| Go back to an earlier version | Use its `codex-<version>` tag, the last router commit verified with it; see [Return to an earlier Codex version](operations.md#return-to-an-earlier-codex-version) |

##### Daemon updates

The shared app-server daemon keeps its own copy of Codex under `packages/app-server-daemon/` in your Codex home. Unpinned, it checks chatgpt.com hourly and installs each release ahead of the CLI and the tested version, and a release can break what the router relies on, as 0.164.0 did for threads that switch from a native model to DeepSeek. So the installer pins it to the CLI's Codex by default:

```sh
codex app-server daemon update --from-cli --yes
```

| Case | The installer |
| --- | --- |
| Default | Pins the daemon: it runs the CLI's version, never updates itself, and changes only when you update the CLI and rerun the installer. Pinning restarts a running daemon. |
| `--no-service`, `CODEX_ROUTER_RESTART_DAEMON=0` while the daemon runs, or Codex running the installer | Skips pinning and prints the command to run instead |
| The daemon is stopped | Pins it without starting it |
| Codex has not installed the daemon yet | Does not pin it, and says so, as does the verifier; rerun the installer after Codex first starts it |
| Pinning fails, for example without a packaged CLI such as the npm package | Warns and restarts the daemon instead |

- **Verifier:** fails while the daemon updates itself or runs a different version from the CLI.
- **Unpin:** install with `CODEX_ROUTER_PIN_DAEMON=0`, run `codex app-server daemon update` to return to production updates, and run the verifier with the same setting.

#### Existing configuration

When `config.toml` or `unified-openrouter.config.toml` exists without router settings, the installer lists the files and asks before merging into them. Both are backed up first, and later runs update the managed blocks without asking.

- **Answering no, or no terminal without `--force`:** the installer stops before anything changes.
- **In the profile:** the managed blocks own only `model_provider`, `model_catalog_json`, and `[model_providers.unified]`; keep custom models, reasoning settings, instructions, and other tables outside them.

#### Automatic startup

| Platform | The router runs under |
| --- | --- |
| macOS | launchd |
| Linux | `systemd --user`; without a working user service session, the installer prints a manual startup command |
| Windows | A hidden Startup-folder supervisor |

To manage the service, see [Service management](operations.md#service-management).

#### Activate the provider

Restart Codex windows that were open before installation, and start a new thread. Existing threads keep the provider they were created with, and Codex 0.166.0 refuses to continue one under another ("This chat uses openai, but your current provider is unified"), so resume an older thread with its own provider, such as `codex resume <id> -c model_provider=openai`.

The shared app-server daemon keeps the configuration and catalog it started with, so the installer restarts a running one by pinning it, which interrupts its open sessions. With `--no-service`, with `CODEX_ROUTER_RESTART_DAEMON=0`, or when Codex itself runs the installer, it skips the restart: restart the daemon once yourself, or pin and restart it with `codex app-server daemon update --from-cli --yes`.

```sh
codex app-server daemon restart
```

Once a thread uses the unified provider, switching models needs no restart.

---

### Router settings

The router reads these at startup from `unified-router/openrouter.env` in your Codex home, or from its service environment. Prefer the file: the installer keeps your additions there but regenerates the service environment. Restart the router after a change, for example by rerunning the installer.

The installer writes the first two lines of `~/.codex/unified-router/openrouter.env`; add your settings below them:

```sh
OPENROUTER_API_KEY=...
CODEX_ROUTER_TOKEN=...
CODEX_ROUTER_LOG_LEVEL=info
CODEX_ROUTER_PROVIDER_ORDER=deepseek/deepseek-v4.1-flash-1017=deepseek
ANTHROPIC_API_KEY=<Anthropic API key>
```

| Variable | Default | Effect |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | set by the installer | OpenRouter key. To replace it, run `node install.mjs --change-api-key`. |
| `CODEX_ROUTER_TOKEN` | generated by the installer | Local token that Codex sends with each request. Do not edit; the installer keeps it in sync with the Codex configuration. |
| `ANTHROPIC_API_KEY` | unset | Anthropic API key, never a Claude sign-in token. With it, Claude runs on Anthropic's API. Add it to the file yourself; the installer keeps it. |
| `CODEX_ROUTER_LOG_LEVEL` | `error` | `error`, `info`, or `debug`. See [Structured logs](operations.md#structured-logs). |
| `CODEX_ROUTER_REJECTED_REQUEST_DIR` | unset | Directory for private copies of OpenRouter-rejected request bodies and up to 256 KiB of each response body. On Windows, only `unified-router` itself is accepted. See [Capture rejected requests](operations.md#capture-rejected-requests). |
| `CODEX_ROUTER_PROVIDER_ORDER` | unset | Preferred OpenRouter endpoints per model. See [OpenRouter endpoint preferences](#openrouter-endpoint-preferences). |
| `CODEX_ROUTER_TRAINING_MODELS` | unset | Comma-separated upstream slugs to add to the training tier. See [Provider isolation](routing.md#provider-isolation). |

- **Comments:** put them on their own lines; a `#` after a value becomes part of the value.
- **Left to the installer:** the service environment also sets `CODEX_ROUTER_ENV_FILE`, `CODEX_MODEL_CATALOG`, and `CODEX_ROUTER_PORT` (`18766`), which the managed Codex configuration expects.

#### OpenRouter endpoint preferences

OpenRouter picks an endpoint for each request. To prefer particular endpoints for a model, set `CODEX_ROUTER_PROVIDER_ORDER` and restart the router:

```sh
CODEX_ROUTER_PROVIDER_ORDER=deepseek/deepseek-v4.1-flash-1017=deepseek
```

How the value is read and applied:

- **Key:** The upstream model slug, without the `openrouter/` prefix; both Ultra Spark entries share DeepSeek's key
- **Value:** Endpoint tags from `https://openrouter.ai/api/v1/models/<model>/endpoints`, separated by commas; separate models with `;`
- **Request:** `provider: { order: [...] }`, added only when the request has no `provider` field; after a native OpenAI or Claude model, with `data_collection: "deny"` beside it. The router's own web searches follow the same order for their model.
- **Fallbacks:** Stay enabled, so an outage of the preferred endpoint costs a cache miss instead of failing the turn; OpenRouter's own sticky routing does not apply while an order is set
- **Errors:** A malformed value stops the router at startup; `request.forwarded` logs the applied `providerOrder`

---

### Managed Codex configuration

The installer manages these settings in `config.toml` between `# BEGIN/END codex-unified-router` markers, with the real catalog path and a random local token. Reruns reapply them and keep the token; `model` and `model_reasoning_effort` are first-install defaults, so later runs keep what Codex saves when you pick a model with `/model`, and restore a default only if its line is missing.

```toml
model = "deepseek/deepseek-v4.1-flash-1017"
model_provider = "unified"
model_reasoning_effort = "xhigh"
model_catalog_json = "/absolute/path/to/.codex/models.json"

[model_providers.unified]
name = "Codex Unified Model Router"
base_url = "http://127.0.0.1:18766/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
http_headers = { "X-Codex-Router-Token" = "<generated-by-installer>" }

[features]
apps = false
guardian_approval = false

[analytics]
enabled = false

[agents]
max_concurrent_threads_per_session = 10
```

- **Sandbox network:** with `CODEX_ROUTER_SANDBOX_NETWORK=1`, the installer also manages `network_access = true` in `[sandbox_workspace_write]`.
- **Existing tables:** it edits `[features]`, `[analytics]`, `[agents]`, and `[sandbox_workspace_write]` in place and keeps their other keys. Move top-level dotted keys, such as `features.apps`, into their table first.
- **Codex's own settings** between the markers, such as project trust or MCP servers, survive reruns; tables the router does not own move out of its blocks.
- **The OpenRouter-only profile** inherits these settings.

#### ChatGPT apps

Codex's apps feature adds ChatGPT connector tools, such as GitHub, Sites, and ChatGPT spaces, to every request, whatever the model. With Codex 0.163.0 and apps connected, they made up about 237,000 characters (roughly 65,000 tokens) of a 270 KB request that was 32 KB without them; OpenRouter bills them on every uncached request, and they slow cold starts.

To keep the apps, install with:

```sh
CODEX_ROUTER_DISABLE_APPS=0 node install.mjs
```

For one session, `codex --enable apps` or `codex --disable apps` overrides the configuration.

#### Codex guardian

Codex 0.163.0 checks some agent actions, such as writes outside the workspace, with a hidden guardian thread on `codex-auto-review`, a native OpenAI model, even when `approvals_reviewer` is `user`. It sends that model the agent transcript, tool calls and results included.

- **Why it is off:** in a session that used Muse Spark 1.3 Contributor or Ultra Spark Contributor, provider isolation refuses those requests, so the action stalls; in other sessions, the transcript goes to OpenAI and needs a ChatGPT plan.
- **Default:** `guardian_approval = false` in `[features]`, so approval requests go to you as configured.
To keep the guardian, for example for `approvals_reviewer = "auto_review"`, which runs on it, install with:

```sh
CODEX_ROUTER_DISABLE_GUARDIAN=0 node install.mjs
```

For one session, `codex --enable guardian_approval` overrides the configuration.

#### Codex analytics

Codex sends usage analytics and metrics to OpenAI by default. The installer manages `enabled = false` in `[analytics]`, which also turns off Codex's default metrics exporter, so model choices and usage stay on your machine.

To leave analytics to Codex, install with:

```sh
CODEX_ROUTER_DISABLE_ANALYTICS=0 node install.mjs
```

`/feedback` still sends a report only when you submit one.

#### Native OpenAI models

Codex's bundled models are native OpenAI models and need a ChatGPT plan. Hidden ones stay usable by name, such as `codex -m gpt-6-astra`; rerun the installer after your plan changes.

| `CODEX_ROUTER_NATIVE_MODELS` | `/model` lists native models |
| --- | --- |
| `auto` (default) | Unless Codex's login (`auth.json`, read locally) is missing or its plan has lapsed. The plan claims date from Codex's last token refresh, so an unclear result keeps them listed. |
| `show` | Always |
| `hide` | Never |

To list them whatever the plan, install with:

```sh
CODEX_ROUTER_NATIVE_MODELS=show node install.mjs
```

- **Approvals need no plan:** `approvals_reviewer` defaults to `user`, so you answer prompts yourself. `auto_review` hands them to `codex-auto-review`, a native OpenAI model that fails without a plan; full access is not needed to work without one.

#### Spawned-agent limit

`max_concurrent_threads_per_session` caps the spawned agents a session can keep open, not counting the main thread. The installer sets it to 10, so Ultra Spark can run 10 workers in parallel, and replaces Codex's legacy `max_threads` alias.

For another limit, from 1 to 999, or `0` to leave it to Codex, install with:

```sh
CODEX_ROUTER_AGENT_THREADS=6 node install.mjs
```

#### Sandbox network access

Codex's `workspace-write` sandbox keeps shell commands off the network: a command that needs it, such as `gh api` or a package download, asks for your approval and then runs outside the sandbox. Web search does not depend on it, because it is a tool, not a shell command.

To let commands reach the network without asking, pass the setting on every run:

```sh
CODEX_ROUTER_SANDBOX_NETWORK=1 node install.mjs
```

The installer then manages `network_access = true` in `[sandbox_workspace_write]`; a run without the setting removes the router's block and leaves the setting to you. For one session, `codex -c sandbox_workspace_write.network_access=true` turns it on.

> [!WARNING]
> It applies to every model, native OpenAI included: a command written after reading a malicious page or file can send data out without asking.

#### OpenRouter-only profile

The installer writes `unified-openrouter.config.toml` beside `config.toml`, with the same local token and catalog. It sets `requires_openai_auth = false`, so OpenRouter models and Claude need no ChatGPT login, and sends the `preserve-model-v1` header.

```sh
codex --profile unified-openrouter \
  --model deepseek/deepseek-v4.1-flash-1017
codex --profile unified-openrouter \
  --model ultra-spark/deepseek-v4.1-flash-1017
codex --profile unified-openrouter \
  --model openrouter/meta/muse-spark-1.3-contributor
codex --profile unified-openrouter \
  --model anthropic/claude-sonnet-5-5
```

- **Models:** any router model in the catalog, and Ultra Spark's Muse workers use the same profile; use the main configuration for native OpenAI models.
- **Not a sandbox:** it supplies transport settings, not prompts, plugins, or task policies, and still inherits your other user and project settings. Codex 0.166.0 does not load it with `--ignore-user-config`.
- **Isolated execution:** clients that need it must manage their own Codex home, instructions, tools, permissions, and output validation.

---

### Models

| Model | Slug | Context | Notes |
| --- | --- | --- | --- |
| **DeepSeek V4.1 Flash 1017** (default) | `deepseek/deepseek-v4.1-flash-1017` | 960,000 tokens | DeepSeek's own endpoint may train on its inputs; see [DeepSeek context window](#deepseek-context-window) |
| **DeepSeek V4.1 Flash 1017 · Ultra Spark** | `ultra-spark-private/deepseek-v4.1-flash-1017` | 960,000 tokens | Delegates to Muse Spark 1.3 workers, off endpoints that train; see [Ultra Spark mode](#ultra-spark-mode) |
| **DeepSeek V4.1 Flash 1017 · Ultra Spark Contributor** | `ultra-spark/deepseek-v4.1-flash-1017` | 960,000 tokens | Delegates to Muse Contributor workers; see [Ultra Spark Contributor](#ultra-spark-contributor) |
| **Muse Spark 1.3** | `openrouter/meta/muse-spark-1.3` | 1,048,576 tokens | Its endpoint does not train on its inputs; see [Muse Spark 1.3](#muse-spark-13) |
| **Muse Spark 1.3 Contributor** | `openrouter/meta/muse-spark-1.3-contributor` | 1,048,576 tokens | Meta trains on its inputs; see [Muse Spark 1.3 Contributor](#muse-spark-13-contributor) |
| **Claude Sonnet 5.5** | `anthropic/claude-sonnet-5-5` | 1,000,000 tokens | Anthropic's API or OpenRouter; see [Claude Sonnet 5.5 and Claude Opus 5.5](#claude-sonnet-55-and-claude-opus-55) |
| **Claude Opus 5.5** | `anthropic/claude-opus-5-5` | 1,000,000 tokens | Anthropic's API or OpenRouter, as for Sonnet |
| Native OpenAI models | for example `gpt-6-astra` | bundled limits | Require a ChatGPT plan |

#### DeepSeek context window

[`catalog/deepseek-model.json`](../catalog/deepseek-model.json) preconfigures `deepseek/deepseek-v4.1-flash-1017`. The installer merges it into `models.json` and points `model_catalog_json` at it, so no manual context setting is needed.

It is the default model; to select it in a thread that runs another one:

```sh
codex -m deepseek/deepseek-v4.1-flash-1017
```

> [!WARNING]
> DeepSeek's own endpoint may train on prompts and completions, according to OpenRouter's data policy, and OpenRouter can route DeepSeek there unless you pin another endpoint. Codex sends file contents and command output with each step, so on that endpoint use DeepSeek only for code you are willing to share.

| Catalog setting | Value | Meaning |
| --- | --- | --- |
| `context_window` | `960000` | Configured context window in tokens. |
| `max_context_window` | `960000` | Maximum context window declared by this entry. |
| `effective_context_window_percent` | `95` | Effective budget of **912,000 tokens** (`960,000 × 95%`). |
| `auto_compact_token_limit` | `null` | No explicit compaction threshold supplied by the catalog. |

- **The budget** covers the whole conversation context, including instructions, messages, and tool results; it is not a maximum output length. These are the project's configured limits, not a live measurement of upstream capacity, and native OpenAI models keep their bundled limits.
- **After a native OpenAI or Claude model:** DeepSeek runs only on an endpoint that does not collect data, such as one you pin with `CODEX_ROUTER_PROVIDER_ORDER`.

#### Muse Spark 1.3

[`catalog/muse-standard-model.json`](../catalog/muse-standard-model.json) adds `openrouter/meta/muse-spark-1.3`, the same model and settings as the Contributor entry below, outside Meta's contributor tier. OpenRouter lists its endpoint as one that does not train on inputs, so it also runs in sessions that used a native OpenAI or Claude model; it costs more than the Contributor tier.

```sh
codex -m openrouter/meta/muse-spark-1.3
```

#### Muse Spark 1.3 Contributor

[`catalog/muse-model.json`](../catalog/muse-model.json) adds `openrouter/meta/muse-spark-1.3-contributor` with OpenRouter's published **1,048,576-token** context and a 95% effective budget. Reasoning is mandatory upstream, so the entry offers `low` through `max` (default `medium`) and no `none`; it declares no parallel tool calls.

```sh
codex -m openrouter/meta/muse-spark-1.3-contributor
```

> [!WARNING]
> This is Meta's contributor tier, cheaper because Meta uses prompts and completions to improve its products, and Codex sends file contents and command output with each step. Use it only for code you are willing to share, such as public repositories.

OpenRouter routes to it only after you allow endpoints that may train on inputs in your OpenRouter privacy settings.

#### Claude Sonnet 5.5 and Claude Opus 5.5

[`catalog/claude-sonnet-model.json`](../catalog/claude-sonnet-model.json) and [`catalog/claude-opus-model.json`](../catalog/claude-opus-model.json) add `anthropic/claude-sonnet-5-5` and `anthropic/claude-opus-5-5` with a **1,000,000-token** context and a 95% effective budget. Thinking cannot be turned off, so the entries offer `low` through `max` (default `medium`) and no `none`.

With `ANTHROPIC_API_KEY` in the [router settings](#router-settings), Claude runs on Anthropic's API; without it, Claude runs on OpenRouter's copy of the same model. Both routes charge the same per-token prices, but credits from a Claude plan work only on Anthropic's API, and only there does Claude's signed thinking carry from step to step. A thread keeps the route it started on, and moves to OpenRouter if Anthropic refuses the key, the credits, a spend limit, or the model; see [Claude's two routes](routing.md#claudes-two-routes).

```sh
codex -m anthropic/claude-sonnet-5-5
codex -m anthropic/claude-opus-5-5
```

- **Reasoning effort:** `codex -m` keeps your configured effort, `xhigh` from the installer; to spend less, pick a lower one with `/model` or `-c model_reasoning_effort=medium`. On Anthropic's API, `none` and `minimal` become `low`.
- **API key only:** use an Anthropic API key from [platform.claude.com](https://platform.claude.com/); it bills its organization's API credits. Anthropic does not allow Claude sign-in tokens (`sk-ant-oat…`) in other tools, so the router ignores one and logs `anthropic.sign_in_token_ignored`, and the verifier fails.
- **Older threads:** `openrouter/anthropic/claude-sonnet-5.5` and `openrouter/anthropic/claude-opus-5.5` are hidden from `/model` but still work by name, for threads that started on them.
- **Isolation:** Claude never shares a session with Muse Spark 1.3 Contributor, Ultra Spark Contributor, or other training-tier models, on either route.

#### Ultra Spark mode

**DeepSeek V4.1 Flash 1017 · Ultra Spark** (`ultra-spark-private/deepseek-v4.1-flash-1017`) is the same upstream DeepSeek model with [`prompts/ultra-spark-private.md`](../prompts/ultra-spark-private.md) added, which makes delegation the default. No endpoint in its session trains on inputs, so it suits private code. Switch it on or off in a thread with `/model`.

```sh
codex -m ultra-spark-private/deepseek-v4.1-flash-1017
```

- **Workers:** it splits broad tasks such as reviews across parallel Muse Spark 1.3 workers, up to 10 at once, and hands them chores such as code searches, test runs, and mechanical edits through Codex's `spawn_agent` tool. Workers are spawned with `fork_context: false`, so they see only their task.
- **The lead:** design decisions, final edits, and verification stay in the DeepSeek thread; the default reasoning effort is `max`.
- **No training:** from its first request, with or without a session ID, every OpenRouter request in its session, the router's searches included, carries `provider.data_collection: "deny"`. DeepSeek then runs on an endpoint that does not collect data instead of DeepSeek's own, so your OpenRouter settings must allow one, such as Fireworks.
- **Isolation:** the router refuses the training tier in its session, so a worker spawned on Muse Spark 1.3 Contributor gets HTTP 409. It may share a session with native OpenAI and Claude models.
- **Cost:** Muse Spark 1.3 workers cost more than Contributor workers.

#### Ultra Spark Contributor

**DeepSeek V4.1 Flash 1017 · Ultra Spark Contributor** (`ultra-spark/deepseek-v4.1-flash-1017`) runs the same policy, [`prompts/ultra-spark.md`](../prompts/ultra-spark.md), with Muse Spark 1.3 Contributor workers, which cost less because Meta trains on their inputs. The router counts it as training-tier, so it refuses it in a session that already used a native OpenAI or Claude model.

```sh
codex -m ultra-spark/deepseek-v4.1-flash-1017
```

> [!WARNING]
> Workers inherit Muse's contributor terms, so use the mode only for code you are willing to share.

##### Forked-context backstop

The router also catches workers forked with the lead's history, by their tool call IDs. It remembers, in memory, the tool call IDs in Ultra Spark Contributor requests from a main thread, whose thread ID Codex sets equal to the session ID; a spawned agent in the same session that sends one of them to Muse or another training-tier model other than Ultra Spark Contributor gets HTTP 409 (`forked_lead_context`), and nothing is sent upstream. Switching the lead thread itself to Muse with `/model` is still allowed.

The check matches tool call IDs only, so it misses:

- a fork made before the lead's first tool call;
- a lead that is itself a spawned agent rather than a main thread;
- requests without both a session ID and a thread ID, which Codex 0.163 and later send as `session-id` and `thread-id`;
- the lead's IDs that aged out of the most recent 4,096 kept per session, that belong to a session beyond the 256 most recently active Ultra Spark Contributor leads, or that were forgotten when the router restarted, until the lead's next request records them again.

#### Add a model

Native models come from Codex's bundled catalog: update Codex and rerun the installer to refresh them. For an OpenRouter model:

1. Copy `catalog/deepseek-model.json` to another JSON file in `catalog/`.
2. Set `slug` to `openrouter/<exact-openrouter-model-slug>`.
3. Update the display name, description, context limits, reasoning levels, and other capabilities to match the model.
4. Refresh the prompts, then rerun the installer:

```sh
node scripts/render-openrouter-entries.mjs
node install.mjs
```

- **Slugs:** catalog entries must start with `anthropic/`, `deepseek/`, `openrouter/`, `ultra-spark/`, or `ultra-spark-private/` and name a model after it; the router removes `openrouter/` before forwarding.
- **Build checks:** the catalog build fails on an unsupported slug prefix, a duplicate slug, a slug that matches a bundled Codex model, or a missing prompt file.
- **Prompts:** every router entry uses the maintained instructions in [`prompts/`](../prompts/), which the installer also injects into its generated catalog. An entry can append one more prompt from that directory by naming it in `router_instructions_suffix`, as Ultra Spark does; the generated Codex catalog omits that field.

---

### License and template provenance

This project is licensed under [Apache-2.0](../LICENSE), and [NOTICE](../NOTICE) preserves the applicable OpenAI attribution. It is an independent community project.

- **Catalog templates:** the DeepSeek entry includes model-message templates that match the bundled catalog of `@openai/codex` **0.166.0**, whose package metadata declares Apache-2.0; its [adjacent file notice](../catalog/deepseek-model.json.license) identifies those sections and the modifications. The Muse, Ultra Spark, and Claude entries derive from the same template, as their notices record ([Muse](../catalog/muse-model.json.license), [Ultra Spark](../catalog/deepseek-ultra-spark-model.json.license), [Claude Sonnet](../catalog/claude-sonnet-model.json.license), [Claude Opus](../catalog/claude-opus-model.json.license), and the OpenRouter-only [Sonnet](../catalog/claude-sonnet-openrouter-model.json.license) and [Opus](../catalog/claude-opus-openrouter-model.json.license) entries).
- **Redistributing:** keep the licenses and applicable notices with an entry or a modified copy, and record your own changes.
- **Prompts:** the main and persistent instructions in `prompts/` are maintained separately and are not verbatim copies of the corresponding instructions in the installed Codex catalog; this comparison does not establish originality against other sources. Native model entries are read from the user's installed Codex during installation.
- **Service terms:** the software license does not grant access to models or hosted services. Access to OpenAI, OpenRouter, and each model provider, including Meta's contributor tier, remains subject to their respective service terms.
