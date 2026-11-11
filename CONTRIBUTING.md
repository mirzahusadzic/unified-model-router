# Contributing

Thanks for helping improve the router. It is deliberately small: a local compatibility layer that fits Codex's existing model picker and thread workflow. Read [AGENTS.md](AGENTS.md) first; it lists where each kind of change belongs and the behaviors every change must preserve.

---

### Development

Node.js 20 or later is the only requirement; there are no dependencies to install and no build step.

| To | Run |
| --- | --- |
| Run all tests, offline and without credentials | `node --test` |
| Check shell syntax | `bash -n platform/unix/*.sh` |
| Render the catalog entries after editing `prompts/` or adding an entry | `node scripts/render-openrouter-entries.mjs` |

The installed router is a separate copy under your Codex home directory. Run `node install.mjs` to try a change in Codex, and `node install.mjs --verify` afterward.

---

### Project layout

| Path | Contents |
| --- | --- |
| `router/unified-router.mjs` | The router's entry: the local HTTP server, request handling, the recovery flow, and diagnostics. The installers copy it as `router.mjs`, with the modules below beside it. |
| `router/upstream.mjs` | Routes from model slugs, upstream headers, the shared request opener, error bodies, and the usage tap. |
| `router/adapt.mjs` | Request shaping for each upstream (history normalization, reasoning, structured output, caching) and the bounded recovery payload. |
| `router/web-search.mjs` | Router-run web search and the stream rewriter that runs it and normalizes tool arguments. |
| `router/sessions.mjs` | Per-session state: provider isolation sides, Claude routes, Claude threads' effort changes, and Ultra Spark lead call IDs. |
| `router/served-by.mjs` | The served-by report: marks the final event with the provider, and looks up OpenRouter's record of a generation when a caller asks. |
| `router/config.mjs` | Router settings from `openrouter.env` and the environment, keys, logging, and private state writes. |
| `router/anthropic.mjs` | Claude on Anthropic's API: Responses-to-Messages request translation, the streamed-event translation back, and refusals that move Claude to OpenRouter. |
| `router/common.mjs` | Helpers shared by the router's modules and the health verifier, including the source revision. |
| `catalog/` | Router model entries for the Codex catalog (OpenRouter models and Claude), in folders by vendor. Their license notice is in `REUSE.toml`. |
| `prompts/` | Shared OpenRouter instructions and the two Ultra Spark delegation policies. |
| `install.mjs` | Cross-platform entry point that runs the installer or verifier for the current OS. |
| `platform/` | Per-OS installers and verifiers in `unix/` and `windows/`, plus the Windows access-control helper; see the [platform index](platform/README.md). |
| `scripts/` | Verifiers, installer helpers, and development tools; see [Scripts](#scripts). |
| `tests/` | `node --test` suites, plus a Windows access-control test; see [Tests](#tests). |
| `docs/` | [Setup and configuration](docs/setup.md), [how routing works](docs/routing.md), and [services and troubleshooting](docs/operations.md). |

#### Scripts

Scripts you run:

| Script | Purpose |
| --- | --- |
| `node install.mjs [--verify]` | Install, or with `--verify` check, through the platform scripts below. `--help` lists every option and setting; keep it in step with [Installer settings](docs/setup.md#installer-settings), which a test enforces. |
| `platform/unix/verify-install.sh`, `platform/windows/verify-install.ps1` | Verify an installation: configuration, tokens, permissions, catalog prompts, router health, and the service. Pass `--no-service` (Windows: `-NoService`) after an install without a service. |
| `scripts/render-openrouter-entries.mjs` | Render the maintained prompts into the checked-in catalog entries. Run it after editing `prompts/` or adding an entry. |
| `scripts/chatgpt-plan.mjs <codex-home>` | Print `active`, `inactive`, or `unknown` for the ChatGPT plan in Codex's login, as the installer's `CODEX_ROUTER_NATIVE_MODELS=auto` check sees it. |

Helpers the installers and verifiers call:

| Script | Purpose |
| --- | --- |
| `scripts/build-catalog.mjs` | Build `models.json` from Codex's bundled models and `catalog/`, applying prompts, hiding native models on request, and rejecting duplicate or colliding slugs. |
| `scripts/catalog-files.mjs` | List the catalog entry files in their vendor folders, in the order the catalog build reads them. |
| `scripts/merge-config.mjs` | Merge the managed settings into `config.toml` and the OpenRouter-only profile, preserving everything else. |
| `scripts/prepare-credentials.mjs` | Write `unified-router/openrouter.env`, keeping the local token and any extra router settings. |
| `scripts/config-managed.mjs` | Report through its exit status whether a configuration already has the managed marker, which decides whether the installer asks before merging into it. |
| `scripts/verify-credentials.mjs` | Check the managed blocks, local tokens, and private permissions. |
| `scripts/verify-health.mjs` | Check the running router's health, capabilities, and source revision. |
| `scripts/verify-router.mjs` | Check that the installed router and every module beside it match this repository. |
| `scripts/codex-daemon.mjs [--verify] <codex-home>` | Restart Codex's app-server daemon after an installation and pin it to the CLI's Codex, or with `--verify`, check that it follows the CLI. Both installers and verifiers use it. |
| `scripts/verify-catalog.mjs [--report] <models.json>` | Check that a generated or installed catalog carries every router entry with the repository's context limits and prompts, and no router entry the repository lacks, or with `--report`, print what `/model` lists. Both installers and verifiers use it. |
| `platform/windows/private-path.ps1` | On Windows, restrict a file or directory to the current user. |
| `platform/unix/service-pids.sh`, `platform/windows/service-pids.ps1` | Find the service's router process and the processes it started, which the installers' readiness wait and the verifiers pass to `verify-health.mjs`. |

Shared modules: `scripts/openrouter-prompts.mjs` holds the prompt rules for OpenRouter entries, and `scripts/toml-lines.mjs` reads TOML line by line without mistaking strings or comments for keys, tables, or markers.

#### Tests

`node --test` runs every `.test.mjs` file on macOS, Linux, and Windows. The tests use synthetic upstreams and need no credentials or network. `tests/prompt-budget.test.mjs` also needs the tested Codex CLI and skips without it, as in CI.

[CI](.github/workflows/ci.yml) runs on pushes, pull requests, and manual dispatch. It tests Linux with Node.js 20, 22, and 24, plus macOS and Windows with Node.js 24, checks JavaScript, Bash, and Windows PowerShell syntax, and validates the model JSON. Live provider compatibility and background-service installation need separate manual verification.

| Test file | Covers | Platforms |
| --- | --- | --- |
| `tests/unified-router.test.mjs` | Routing, history repair, reasoning and structured-output adaptation, OpenRouter recovery, provider isolation, endpoint preferences, header allowlists, streaming, web search, Claude's Messages translation and route fallback, and logs. | All |
| `tests/credentials.test.mjs` | Credential files and configuration merging: tokens, managed apps, analytics, and agent settings, and TOML strings and comments. | All |
| `tests/catalog.test.mjs` | Catalog entries, rendered prompts and the Codex tools they must not mention, prompt suffixes, catalog-build validation, and `verify-catalog.mjs`. | All |
| `tests/native-models.test.mjs` | ChatGPT plan detection and hiding native models. | All |
| `tests/install.test.mjs` | End-to-end installs without a service through `install.mjs` and the platform scripts, collision guards, key sources, setting validation, the closing summary and verifier report, the help text and argument errors, the daemon restart and pin step, and that the Unix scripts need no `jq`. Runs `platform/unix/install.sh` on macOS and Linux and `platform/windows/install.ps1` on Windows. | All, per-platform installer |
| `tests/log-level.test.mjs` | Router startup settings: log levels, endpoint preferences, and a corrupt isolation record. | All |
| `tests/verify-health.test.mjs` | The health verifier's capability, revision, redirect, and service-process checks. | All |
| `tests/session-retention.test.mjs` | Session sides and Claude routes expiring 30 days after their last request while the router keeps running. | All |
| `tests/service-pids.test.mjs` | The Unix service-process lookup and the installers' readiness wait, with fake `launchctl`, `systemctl`, and `pgrep`. | macOS, Linux |
| `tests/prompt-budget.test.mjs` | What the installed Codex sends router models under the installer's configuration, through a local fake upstream: the tool list, request and tool-definition sizes, the features it turns on, and that apps and guardian stay off. Skips without the tested Codex CLI or reviewed expectations for the platform. | macOS (reviewed); others skip |
| `platform/windows/private-path.test.ps1` | Current-user-only access control lists on Windows. CI runs it in a separate step. | Windows |

---

### Making changes

- **Router behavior:** add a focused regression test in `tests/unified-router.test.mjs`.
- **New OpenRouter model:** copy `catalog/deepseek/deepseek.json` into its vendor's folder, use `openrouter/<upstream-model-slug>`, and review every capability: context limits, reasoning levels, tool support, and prompts. A catalog entry alone does not prove compatibility, so try the model in Codex before proposing it.
- **Installers:** keep `platform/unix/install.sh` and `platform/windows/install.ps1` aligned, including backups and preservation of unrelated configuration.
- **Documentation:** keep the README brief and put details in `docs/`.

---

### Pull requests

- Keep each pull request to one focused change, with a [Conventional Commits](https://www.conventionalcommits.org/) message such as `fix:`, `feat:`, or `docs:`.
- Describe how you verified the change, including any live run.
- Never include credentials, router tokens, Codex session files, or captured request bodies.

Report security issues privately as described in [SECURITY.md](SECURITY.md).
