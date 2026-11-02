# Repository guide

Small loopback router that fits Codex's model picker and thread workflow, and serves other local Responses API clients. Prefer catalog changes and focused compatibility fixes; add no CLI commands, frameworks, or runtime dependencies. Options for other clients are opt-in request headers, never forwarded, that leave Codex's requests byte-identical.

---

### Map

- Docs: `README.md` (install, use), `docs/setup.md` (configuration, models, limits), `docs/routing.md` (routing, Claude's routes, web search, isolation, credentials), `docs/operations.md` (services, logs, troubleshooting, rollback), `CONTRIBUTING.md` (layout, scripts).
- Dev: Node.js 20+, no dependencies, no build. `node --test` runs offline, without credentials, against fake upstreams.

| Task | Source |
| --- | --- |
| Request handling, recovery flow, diagnostics, health | `router/unified-router.mjs` |
| Routes, upstream headers and transport, error bodies, usage tap | `router/upstream.mjs` |
| History normalization, request shaping per upstream, recovery payloads | `router/adapt.mjs` |
| Router-run web search, stream rewriter | `router/web-search.mjs` |
| Provider isolation, Claude routes, Ultra Spark lead call IDs | `router/sessions.mjs` |
| Router settings, keys, logging | `router/config.mjs` |
| Claude on Anthropic's API: Messages translation, refusals | `router/anthropic.mjs` |
| OpenRouter models | `catalog/*.json` |
| Shared OpenRouter prompts | `prompts/openrouter-instructions.md`, `prompts/openrouter-persistent.md` |
| Ultra Spark delegation policy | `prompts/ultra-spark.md` |
| Catalog generation, prompt rendering | `scripts/build-catalog.mjs`, `scripts/openrouter-prompts.mjs` |
| Managed Codex settings, TOML handling | `scripts/merge-config.mjs`, `scripts/toml-lines.mjs` |
| Installation, service startup | `install.mjs` (entry), `platform/unix/install.sh`, `platform/windows/install.ps1`; the service's process lookup in `platform/*/service-pids.*` |
| Codex daemon restart and pinning | `scripts/codex-daemon.mjs` |
| Tested Codex version | `testedCodexVersion` in `install.mjs`, plus the docs' references; see [Upgrade Codex](#upgrade-codex) |

---

### Catalog

- Slugs: `openrouter/` is stripped; `deepseek/` is kept; `ultra-spark/` forwards as `deepseek/` with the Ultra Spark prompt; `anthropic/<model ID>` goes to Anthropic's API with `ANTHROPIC_API_KEY`, else to OpenRouter, and a session keeps its first route; anything else goes to the native Codex backend and its bundled models.
- New OpenRouter entry: copy `catalog/deepseek-model.json`, slug `openrouter/<upstream-model-slug>`, review context limits, effective context percentage, reasoning levels, tool support, and prompts. An entry does not prove upstream compatibility.
- After editing prompts or adding an entry: `node scripts/render-openrouter-entries.mjs`, and commit the updated entries. `router_instructions_suffix` appends one more `prompts/` file; the generated Codex catalog omits that field.
- Model context settings live in the catalog; native models keep their bundled limits.

---

### Preserve these behaviors

- Loopback only. No credentials or request and response bodies in logs or commits.
- Auth: OpenRouter requests replace Codex authentication with the OpenRouter key, and Claude requests on Anthropic's API replace it with the Anthropic API key, never a Claude sign-in token; native OpenAI requests keep Codex's authentication.
- History: keep messages, tool calls and results, and encrypted reasoning. Strip unsupported plaintext reasoning from OpenAI requests, `additional_tools` items from OpenRouter requests, and Claude's signed thinking from every request outside Anthropic's API.
- Messages translation is append-only, each request a prefix of the next, so Claude's cache and signed thinking stay valid. Claude's breakpoint is a top-level `cache_control` that moves with the thread; only a caller's `X-Codex-Router-Prompt-Cache` (`instructions`: end of the system prompt; `none`) replaces it, on both routes.
- Pre-stream OpenRouter or Anthropic 400: at most one bounded recovery, never HTTP 400 to Codex. Context overflow: streamed `response.failed` with `context_length_exceeded`, so Codex compacts. Failed recovery: completed router diagnostic; the real rejection is logged, bodies only with capture enabled.
- Anthropic refusals no retry fixes (credits, spend limits, the key, model access) go to OpenRouter, or end in a router diagnostic without an OpenRouter key. A 401 never reaches Codex, which would refresh its ChatGPT sign-in.
- Never substitute a model, across Claude's routes included; never send Anthropic's `fallbacks`. Structured output stays on the selected model; DeepSeek, which rejects JSON schemas, gets JSON mode plus the schema as the final developer instruction: object at the top level, response format's name left out.
- Stream chunks as they arrive; cancel unfinished upstream requests on client disconnect.
- Training tier: Muse and the Ultra Spark workers send inputs to Meta's contributor tier, which trains on them; say so in docs and catalog descriptions. Ultra Spark spawns workers with `fork_context: false`. Backstop: refuse Muse and other non-Ultra Spark training-tier requests from spawned agents carrying tool call IDs from an Ultra Spark main thread.
- Isolation: native OpenAI and Claude models never share a session with the training tier. After either, the session's OpenRouter requests, router searches included, carry `provider.data_collection: "deny"`, keeping their output off endpoints that may train, such as DeepSeek's own.
- Web search for OpenRouter models and Claude: Codex's hosted `web_search` becomes a router function run through OpenRouter's web plugin; Codex sees a native `web_search_call`; later requests carry the stored results as its output. Keep a step's calls ahead of their outputs, so DeepSeek sees one assistant turn. Never log the query.
- Defaults: Codex analytics and the OpenAI-hosted guardian reviewer off; no router data to third parties; the sandbox's network setting left to Codex unless `CODEX_ROUTER_SANDBOX_NETWORK=1`.
- Unix and Windows installers stay aligned, backups and preservation of unrelated configuration included.
- The Codex app-server daemon is pinned to the CLI's Codex by default, and never restarted when Codex runs the installer or restarts are turned off.

---

### Upgrade Codex

The tested version is `testedCodexVersion` in `install.mjs`. An unpinned daemon can run a newer release than the CLI: compare `codex --version` with `codex app-server daemon version`.

1. Diff `rust-v<old>..rust-v<new>` in `openai/codex` for: the `session-id` and `thread-id` headers (a main thread's ID equals its session ID), the `upstreamHeaders` allowlist, request fields, input item types, `spawn_agent`'s `fork_context`, the keys `scripts/merge-config.mjs` writes, guardian gating, and the `codex app-server daemon` `version`, `restart`, and `update --from-cli` commands with the `auto-update-version` marker `scripts/codex-daemon.mjs` checks.
2. Compare `codex debug models --bundled` from both versions, in a scratch `CODEX_HOME`. Template changes: update the catalog entries, their `.license` files, and `NOTICE`.
3. In a scratch `CODEX_HOME`, point a provider at a local capture server and compare both versions' requests for a fresh OpenRouter thread and a native-to-OpenRouter switch. Replay the turns through the installed router with `codex exec -c model_provider=...`, resuming by session ID with the recording provider: `resume --last` misses other providers' sessions, and Codex 0.166.0 refuses another provider. Pass `-m`; keep test traffic off Muse and Ultra Spark.
4. Fix incompatibilities with regression tests. Update every tested-version reference, escaped regex forms such as `0\.163\.0` included (`git grep -n 163`), but keep statements about the version that introduced a behavior. With the new CLI, run `node --test` (`tests/prompt-budget.test.mjs` flags changed tools, request size, or features for router models; review each change before updating expectations), the installer, and `node install.mjs --verify`.
5. `git tag -a codex-<new>` on the verified commit; it is the fallback in `docs/operations.md`, "Return to an earlier Codex version". Move it with `git tag -f -a` when a later commit passes the same checks. Before raising the pin, `codex-<old>` must mark the last commit verified with the old version. Tags stay local until pushed.

---

### Validate and document

- Router behavior change: focused regression test in `tests/unified-router.test.mjs`, then `node --test`, which also checks the rendered prompts in catalog entries.
- Shell edits: `bash -n` on each changed script. CI (`.github/workflows/ci.yml`) also checks JavaScript and PowerShell syntax and the model JSON.
- Docs: README brief, details in `docs/`; docs-only changes need link and fact checks, not a full test run. Shape: top-level sections are `###` headings under a `---` rule, since GitHub underlines `#` and `##`; section leads of two or three sentences at most; tables only for tabular data, run-in lists otherwise; explanation before a code block, no comments inside; at most one alert per section; each link once per page.
- Commits: a Conventional Commits subject of at most 72 characters, a blank line, then a body hard-wrapped at 72; check with `git log --format=%B origin/main..main | awk 'length > 72'`.
- Deploy only when the task includes it. Edit sources first; the running router is an installed copy under the Codex home. Installing changes live configuration and restarts the router and a running Codex daemon, interrupting active requests. Then run `node install.mjs --verify`; local health does not prove upstream model access.
