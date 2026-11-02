# How routing works

What the router does with each request once it is [set up](setup.md): which upstream serves it, what changes on the way, and which models never share a session. Everyday use needs none of this; the [README](../README.md) covers it.

- [Routing and compatibility](#routing-and-compatibility): which upstream serves each model, and how requests are adapted
- [Claude's two routes](#claudes-two-routes): Anthropic's API or OpenRouter, fallback, caching, and the translation
- [Web search](#web-search): searches the router runs for OpenRouter models and Claude
- [Provider isolation](#provider-isolation): models that never share a session
- [Routing policy](#routing-policy), [router capabilities](#router-capabilities), and [credentials and logging](#credentials-and-logging)

---

### Routing and compatibility

The same catalog serves main threads, spawned agents, and any interface that exposes a model field. The model slug picks the upstream:

| Requested model | Upstream service | Upstream model |
| --- | --- | --- |
| `gpt-6-astra` | Native Codex backend | `gpt-6-astra` |
| `deepseek/deepseek-v4.1-flash-1017` | OpenRouter | `deepseek/deepseek-v4.1-flash-1017` |
| `ultra-spark/deepseek-v4.1-flash-1017` | OpenRouter | `deepseek/deepseek-v4.1-flash-1017` |
| `openrouter/meta/muse-spark-1.3-contributor` | OpenRouter | `meta/muse-spark-1.3-contributor` |
| `anthropic/claude-sonnet-5-5` | Anthropic's API, or OpenRouter | `claude-sonnet-5-5`, or `anthropic/claude-sonnet-5.5` |
| `anthropic/claude-opus-5-5` | Anthropic's API, or OpenRouter | `claude-opus-5-5`, or `anthropic/claude-opus-5.5` |
| `openrouter/vendor/model` | OpenRouter | `vendor/model` |

On the way, the router adapts each request to its upstream:

- **Reasoning effort:** DeepSeek accepts only `low`, `high`, `max`, and `none`, so `minimal` becomes `low`, `medium` becomes `high`, and `xhigh` or `ultra` becomes `max`. Other OpenRouter requests keep it, and OpenRouter translates it for each provider; native OpenAI requests keep it too, and on Anthropic's API, `none` and `minimal` become `low`.
- **Reasoning in history:** Messages, tool calls, and tool results always pass. OpenAI gets encrypted reasoning but not OpenRouter's plaintext reasoning; Claude's signed thinking goes only to Anthropic's API, which gets no other provider's reasoning.
- **Native tool declarations:** Left out of OpenRouter requests, which reject them: Codex 0.164 records `additional_tools` items in history for Responses Lite models such as GPT-6, and the request's `tools` field already lists the model's tools.
- **Prompt caching:** Claude requests get a top-level `cache_control`, unless the caller sets one (on OpenRouter) or picks another breakpoint with a header; see [Claude's two routes](#claudes-two-routes). Other models keep their providers' implicit caching.
- **Tool arguments:** Codex rejects a float where it expects an integer, so for OpenRouter models, whole numbers such as DeepSeek's `"timeout_ms": 60000.0` become integers in the finished arguments Codex parses. Strings, other numbers, and the streamed deltas stay as sent.
- **Response state:** OpenRouter keeps none, so the router removes `previous_response_id` and turns off `store: true`; Codex sends the full history in `input` anyway.
- **Rejected steps:** A pre-stream 400 never reaches Codex as HTTP 400. An overflow, or a request too large for the upstream (HTTP 413) or the router's 64 MiB limit, ends with `context_length_exceeded`, so Codex compacts; other 400s get one trimmed retry, then a completed `[router diagnostic]`. See [Rejected steps](operations.md#rejected-steps).
- **OpenRouter 401, 402, 403, 404:** End with a `[router diagnostic]`: Codex would answer a 401 by refreshing its ChatGPT sign-in, and retry the others unchanged.
- **Structured output:** Stays on the selected model; see [Routing policy](#routing-policy).
- **Streaming:** Responses pass through as they arrive, and a client disconnect cancels the unfinished upstream request.

---

### Claude's two routes

With `ANTHROPIC_API_KEY` set, Claude runs on Anthropic's Messages API, and the router translates between it and Codex's Responses API; without the key, Claude runs on OpenRouter's copy of the same model. The entries and the key are described in [Claude Sonnet 5.5 and Claude Opus 5.5](setup.md#claude-sonnet-55-and-claude-opus-55).

Add the key to `~/.codex/unified-router/openrouter.env`:

```sh
ANTHROPIC_API_KEY=<Anthropic API key>
```

| Situation | Claude runs on |
| --- | --- |
| A new thread | Anthropic's API with `ANTHROPIC_API_KEY`, otherwise OpenRouter |
| A thread that already ran | The same route; adding the key does not move a thread off OpenRouter |
| Anthropic refuses the key, the credits, a spend limit, or the model | OpenRouter, for that thread from then on and for every Claude request in the next hour |
| Anthropic rate-limits or is overloaded | Anthropic's API; Codex retries |
| An `openrouter/anthropic/…` slug | OpenRouter |
| Web search, on either route | OpenRouter, with its key |

Each route keeps its own cache and signed thinking:

- **Why threads stay put:** Prompt caches and signed thinking belong to the route that made them, so a move costs a full cache write and the earlier reasoning.
- **Route records:** Each session's route, without content, in `unified-router/claude-routes.json` for 30 days after its last request, so routes survive restarts.
- **Fallback:** A refusal no retry fixes sends the same request to OpenRouter, or returns a `[router diagnostic]` without an OpenRouter key; `anthropic.refused` logs it. For the next hour, or until the router restarts, every Claude request goes to OpenRouter, and threads that move stay there.
- **The same model:** The router never uses Anthropic's server-side `fallbacks`, which can answer with another model.
- **Prompt caching:** A top-level `cache_control` keeps the cache breakpoint on the last cacheable block as the thread grows. Cache writes cost 1.25 times the input price and reads 5% of it; the cache expires after 5 idle minutes.
- **A caller's breakpoint:** A caller other than Codex can send `X-Codex-Router-Prompt-Cache`: `instructions` puts the only breakpoint at the end of the system prompt, so one-shot calls that share it read it back, and `none` sets none.
- **That header on OpenRouter:** OpenRouter takes only a breakpoint over the whole prompt, so either value leaves it off there. An unknown value gets HTTP 400, and the header never reaches a provider.
- **OpenRouter's cache:** Codex's `prompt_cache_key` keeps a thread on one endpoint while its cache is warm.

The breakpoint the router adds to Claude requests:

```json
{ "cache_control": { "type": "ephemeral" } }
```

#### On Anthropic's API

The translation keeps each request a prefix of the next, which keeps Claude's cache and signed thinking valid:

- **System prompt:** Codex's opening developer messages join it; a later developer message becomes a system message just before Claude's next turn.
- **Turns:** Each step's thinking, text, and calls form one assistant turn, with their results in the next user turn.
- **Thinking:** Claude's thinking blocks, signatures included, travel in the reasoning items' `encrypted_content`, which Codex sends back.
- **Changed conversations:** Anthropic is asked to drop, rather than reject, a thinking block whose conversation changed, such as after compaction; `anthropic.thinking_dropped` counts them.
- **Thinking on OpenRouter:** OpenRouter returns the signature in a field Codex does not keep, so on that route earlier thinking may not reach Claude.
- **Tool names:** Grouped tools such as `multi_agent_v1.spawn_agent` reach Claude as `multi_agent_v1__spawn_agent` and return under their own names.
- **Tool choice:** The entries declare parallel tool calls. Claude 5.5 models reject a forced tool choice, so `required` asks without forcing.
- **Web search:** Not offered without an OpenRouter key; see [Web search](#web-search).
- **Rejected steps:** A request over the context window ends with `context_length_exceeded`, so Codex compacts; another 400 gets one retry without Claude's thinking, then a `[router diagnostic]`.

---

### Web search

Native OpenAI models keep Codex's hosted search. For OpenRouter models and Claude, on either route, the router runs search itself through OpenRouter, so it needs the OpenRouter key; a search costs about one to two cents, depending on the model.

How a search runs, from the call to later turns:

- **Why the router runs it:** OpenRouter's own search returns results only as citations, which models do not treat as their own results in later turns, and for some models it fails the step.
- **The call:** Codex's hosted tool becomes a `web_search` function. Each call runs through OpenRouter's web plugin on the selected model with the Exa engine, five results whose excerpts share 10,000 characters, and Codex sees a native `web_search_call` item.
- **Limit:** At most eight searches per step.
- **The answer:** When the model has no other call pending, the router continues the same response with the results; otherwise Codex runs its calls first, and the next request carries the search.
- **Later turns:** Requests from the same session carry each search back as a function call with its output, so the model sees what it found and an earlier search reads the same each time.
- **Storage:** `unified-router/web-search-results.json`, up to 1,000 searches, for 30 days after the session last sends them; a request without a session ID gets its results within the response, and none are kept.
- **A refused continuation:** Ends as a first request would: Codex compacts after `context_length_exceeded`, retries after a rate limit or server error, and retries on OpenRouter after an Anthropic refusal no retry fixes. Other refusals, or a continuation that breaks off, end with a `[router diagnostic]`.

---

### Provider isolation

Native OpenAI and Claude models never share a tracked Codex session with models whose provider trains on their inputs; OpenAI and Claude may share one. Anthropic's terms bar using Claude's output to train competing models, so Claude is kept from the training tier as OpenAI is. Once a tracked session uses one side, the router refuses the other:

> [!IMPORTANT]
> A refused request gets HTTP 409 (`provider_isolation`) and a message to start a new thread; nothing is sent upstream.

| A session that has used | Cannot use |
| --- | --- |
| A native OpenAI model or a Claude model | Muse Spark 1.3 Contributor, Ultra Spark, or another training-tier model |
| Muse Spark 1.3 Contributor or Ultra Spark | A native OpenAI model or a Claude model |

The rule covers models on either route, and whole agent trees:

- **Claude:** Counts on either route, `openrouter/anthropic/…` slugs included.
- **Ultra Spark:** Counts as training-tier, because its workers run on Muse.
- **Spawned agents:** Share their parent's session, so the rule covers whole agent trees: a Muse worker spawned by a native OpenAI thread is refused.
- **DeepSeek and other OpenRouter models:** Work with either side. After a native OpenAI or Claude model, a session's OpenRouter requests, the router's own searches included, carry `provider.data_collection: "deny"`, so they reach only endpoints that do not collect data; DeepSeek's own endpoint, which may train on prompts, is left out.
- **No such endpoint:** Codex receives a `[router diagnostic]` instead of OpenRouter's HTTP 404: pin the model to another endpoint or start a new thread. `request.forwarded` logs `dataCollection`.
- **Records:** Each session's side, without content, in `unified-router/session-sides.json` for 30 days after its last request, so the rule survives restarts.
- **Opt-out:** None; `CODEX_ROUTER_TRAINING_MODELS` can only add models to the training tier.

The rule follows session IDs, not content, so three cases start a new record:

- **Forked sessions:** `codex fork` copies a thread's history into a new session, which starts without a side, so its OpenRouter requests no longer carry `data_collection: "deny"`. Fork a thread that used native OpenAI or Claude models only onto a model outside the training tier that you pin to an endpoint that does not collect data, or start a new thread instead.
- **Sessions from before this router version:** Their first request after the upgrade decides their side.
- **Requests without a session ID:** Such as from clients other than Codex: not tracked.

---

### Routing policy

The router always forwards the model you selected and never substitutes another, structured output included:

- **DeepSeek with a `json_schema` response format:** DeepSeek's endpoint rejects JSON schemas, so the request becomes JSON mode with the schema appended as the final developer instruction. Replies follow the schema, but the provider does not enforce it, and the unchanged history keeps its cache hits.
- **That instruction:** Asks for the object at the top level and leaves out the response format's name, which DeepSeek otherwise took as a key to wrap some answers in; `request.forwarded` logs `structuredOutputAdapted`.
- **Other OpenRouter models:** Receive the schema unchanged.
- **`X-Codex-Routing-Policy: preserve-model-v1`:** Sent by the OpenRouter-only profile; still accepted, and matches the default. Unknown policy values get HTTP 400.
- **Forwarding:** The policy header and the local token never reach providers.

```http
X-Codex-Routing-Policy: preserve-model-v1
```

---

### Router capabilities

`GET /health` (also `/v1/health`) reports the running router's capabilities, whether its OpenRouter and Anthropic keys are set (`openrouter`, `anthropic`), and `revision`, a SHA-256 over its source files. Clients can check compatibility and spot outdated installed copies without an inference request.

```sh
curl -s http://127.0.0.1:18766/health
```

| Field | Meaning |
| --- | --- |
| `capabilities.routingPolicies` | Supported routing policies (`preserve-model-v1`). |
| `capabilities.openrouterRejectionRecovery` | The bounded OpenRouter 400 recovery contract. |
| `capabilities.providerIsolation` | The [provider isolation](#provider-isolation) rule (`session-v3`: `session-v2` added Claude to the protected side, and `session-v3` sends OpenRouter requests in protected sessions only to endpoints that do not collect data). |
| `capabilities.promptCacheModes` | Values of `X-Codex-Router-Prompt-Cache` (`instructions`, `none`), which places Claude's cache breakpoint. |
| `capabilities.revisionPrecondition` | Support for the `X-Codex-Router-Revision` header below. |
| `revision` | SHA-256 over the running router's entry file and the modules beside it. |
| `pid` | The router's process ID. The installer and the verifier accept it only from the service's process or one that process started, such as the real node under a version manager's shim. It is self-reported, so the check catches a stray copy of the router, not a process that lies about its PID. |

These fields do not attest upstream model identity, account access, or the whole runtime configuration. To hold a revision across requests, a client can send:

```http
X-Codex-Router-Revision: <lowercase-sha256-from-health>
```

| Header | Result |
| --- | --- |
| Malformed digest | HTTP 400, after local authentication |
| A different revision | HTTP 409 (`router_revision_mismatch`), before contacting either upstream |
| Matching, or absent | Routing unchanged; the header is never forwarded |

- **Check the capability first:** older routers may ignore the header.
- **Scope:** the precondition detects a changed source, not a restart of identical code or a service configuration change.

---

### Credentials and logging

The router binds only to `127.0.0.1`, and Codex's ChatGPT credentials never leave for OpenRouter or Anthropic. Logs never include request or response bodies, authorization headers, or API keys; see [Structured logs](operations.md#structured-logs).

| Requests to | Endpoint | Credential |
| --- | --- | --- |
| Native OpenAI models | `https://chatgpt.com/backend-api/codex/responses` | Codex's own authentication |
| OpenRouter | `https://openrouter.ai/api/v1/responses` | The OpenRouter key |
| Claude on Anthropic's API | `https://api.anthropic.com/v1/messages` | The Anthropic key |

The keys and the token stay in private files:

- **Storage:** The OpenRouter key, the optional Anthropic key, and the local token live in `unified-router/openrouter.env` under your Codex home, outside this repository.
- **Unix:** Credential-bearing files, the OpenRouter-only profile included, get mode `600` in a private router directory.
- **Windows:** The installer replaces inherited and explicit access rules with a current-user-only list before writing or reusing credentials.
- **Backups:** Backups and temporary installation directories are private too.

> [!NOTE]
> These permissions do not isolate the files from software running as your own user or an administrator.

Requests are checked before anything is forwarded:

- **Local token:** Codex sends it through its provider `http_headers` setting, and the router removes it before forwarding. Model requests and model listings need it; the health endpoint does not.
- **Origin and headers:** The router rejects browser origins, unexpected Host headers, and non-JSON model requests; per-provider header allowlists keep unrelated credentials from being forwarded.
- **Size:** Request bodies are limited to 64 MiB; a larger one ends with `context_length_exceeded`, so Codex compacts the thread. This is a local single-user service, not a shared network gateway.

The verifier checks the installation against this repository:

- **Configuration:** Both configurations against the stored token, their managed settings, and private ownership and permissions.
- **Router:** The installed router and every module beside it must match this repository, and reinstalling removes modules it no longer has. Readiness requires the current capabilities, including `providerIsolation: "session-v3"`, and the installed source's SHA-256, so a reachable older router does not pass, and the process answering must be the service's own or one it started; health redirects are rejected.