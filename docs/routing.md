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
| `ultra-spark-private/deepseek-v4.1-flash-1017` | OpenRouter | `deepseek/deepseek-v4.1-flash-1017` |
| `ultra-spark/deepseek-v4.1-flash-1017` | OpenRouter | `deepseek/deepseek-v4.1-flash-1017` |
| `openrouter/meta/muse-spark-1.3` | OpenRouter | `meta/muse-spark-1.3` |
| `openrouter/meta/muse-spark-1.3-contributor` | OpenRouter | `meta/muse-spark-1.3-contributor` |
| `openrouter/openai/gpt-6.1-sol` | OpenRouter | `openai/gpt-6.1-sol` |
| `anthropic/claude-fable-5-2` | Anthropic's API, or OpenRouter | `claude-fable-5-2`, or `anthropic/claude-fable-5.2` |
| `anthropic/claude-opus-5-5` | Anthropic's API, or OpenRouter | `claude-opus-5-5`, or `anthropic/claude-opus-5.5` |
| `anthropic/claude-sonnet-5-5` | Anthropic's API, or OpenRouter | `claude-sonnet-5-5`, or `anthropic/claude-sonnet-5.5` |
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
- **Effort changes:** A new top-level effort restarts Claude's cache, so when Codex changes the effort in the middle of a thread, the top-level effort stays the one the thread started with, and the change goes in just before the user message whose request first carried it: an effort-only system message on Anthropic's API, sent with the `mid-conversation-output-config-2026-07-01` beta, or a `configuration_update` item on OpenRouter. Later requests place it again, so the cache holds. A thread whose effort never changed, a request without a session ID, and a declared thinking budget go out as before; on Anthropic's API, so does a move between `none`, `minimal`, and `low`, which Claude runs alike at `low`.
- **Models that take them:** On Anthropic's API, Claude Fable 5.2 and 5.1, Mythos 5.2 and 5.1, Opus 5.5 and 5, Sonnet 5.5, and Haiku 5.5. OpenRouter lists only Claude Fable 5.2 and 5.1 and Opus 5, so there an effort change on Opus 5.5 or Sonnet 5.5 still restarts the cache. Other models keep the top-level effort.
- **Effort records:** Each thread's starting effort and changes, at the count of its user messages, in `unified-router/claude-efforts.json` for 30 days after its last request, with a SHA-256 fingerprint of the user messages up to each, not their text. Spawned agents share their parent's session ID but keep their own records. A change goes in again only while the history holds the same messages: after compaction or a rewind, the thread starts again at the current effort, at the top level, and so does a thread past 64 changes. A request that resends an older part of the thread leaves the later changes in place. Only Codex's effort names are recorded, and a retry with trimmed history sets the current effort at the top level again.
- **Progress notes:** The notes Claude writes between tool calls reach Codex inside its reasoning summaries, on both routes, since Anthropic's API is asked for summarized thinking and OpenRouter summarizes by default. With `model_reasoning_summary = "none"`, Anthropic's API returns none, and the notes stay hidden too.
- **Fallback:** A refusal no retry fixes sends the same request to OpenRouter, or returns a `[router diagnostic]` without an OpenRouter key; `anthropic.refused` logs it. For the next hour, or until the router restarts, every Claude request goes to OpenRouter, and threads that move stay there. A caller can opt out with `X-Codex-Router-Fallback: none`, under Routing policy.
- **The same model:** The router never uses Anthropic's server-side `fallbacks`, which can answer with another model.
- **Prompt caching:** A top-level `cache_control` keeps the cache breakpoint on the last cacheable block as the thread grows. Cache writes cost 1.25 times the input price and reads 5% of it; the cache expires after 5 idle minutes.
- **A caller's breakpoint:** A caller other than Codex can send `X-Codex-Router-Prompt-Cache`: `instructions` puts the only breakpoint at the end of the system prompt, so one-shot calls that share it read it back, and `none` sets none.
- **That header on OpenRouter:** OpenRouter takes only a breakpoint over the whole prompt, so either value leaves it off there, even one in the caller's own request body. An unknown value gets HTTP 400, and the header never reaches a provider.
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
- **Usage:** Claude's thinking tokens, part of `output_tokens`, arrive as `output_tokens_details.reasoning_tokens` when Anthropic reports them.

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

OpenAI models, Claude models, and Ultra Spark never share a tracked Codex session with the training tier, a list the router declares: the Contributor models, whose terms let Meta train on their inputs, and any added with `CODEX_ROUTER_TRAINING_MODELS`. They may share one with each other. Anthropic's terms bar using Claude's output to train competing models, so Claude is kept from the training tier as OpenAI is. Once a tracked session uses one side, the router refuses the other:

> [!IMPORTANT]
> A refused request gets HTTP 409 (`provider_isolation`) and a message to start a new thread; nothing is sent upstream.

| A session that has used | Cannot use |
| --- | --- |
| An OpenAI model, a Claude model, or Ultra Spark | Muse Spark 1.3 Contributor, Ultra Spark Contributor, or another training-tier model |
| Muse Spark 1.3 Contributor or Ultra Spark Contributor | An OpenAI model, a Claude model, or Ultra Spark |

The rule covers models on either route, and whole agent trees:

- **OpenAI:** Counts on either route, `openrouter/openai/…` slugs included.
- **Claude:** Counts on either route, `openrouter/anthropic/…` slugs included.
- **Ultra Spark Contributor:** Counts as training-tier, because its workers run on Muse Spark 1.3 Contributor.
- **Ultra Spark:** Counts with OpenAI and Claude, and its lead's requests stay off collecting endpoints even without a session ID.
- **The deny data policy:** A request with `X-Codex-Router-Data-Policy: deny` counts with them too, with or without a session ID; see Routing policy.
- **Spawned agents:** Share their parent's session, so the rule covers whole agent trees: a Muse worker spawned by an OpenAI thread is refused.
- **DeepSeek and other OpenRouter models:** Work with either side. After an OpenAI or Claude model or Ultra Spark, a session's OpenRouter requests, the router's own searches included, carry `provider.data_collection: "deny"`, so they reach only the endpoints OpenRouter's own records count as not collecting data, whatever the router's list says; today that leaves out DeepSeek's own endpoint.
- **No such endpoint:** Codex receives a `[router diagnostic]` instead of OpenRouter's HTTP 404: pin the model to another endpoint or start a new thread. `request.forwarded` logs `dataCollection`.
- **Records:** Each session's side, without content, in `unified-router/session-sides.json` for 30 days after its last request, so the rule survives restarts. A `private` session's record never expires, so its thread stays off the training tier however long it sits idle: one that used non-training Ultra Spark, or whose first request asked for the deny data policy.
- **Opt-out:** None; `CODEX_ROUTER_TRAINING_MODELS` can only add models to the training tier.

The rule follows session IDs, not content, so three cases start a new record:

- **Forked sessions:** `codex fork` copies a thread's history into a new session, which starts without a side, so its OpenRouter requests no longer carry `data_collection: "deny"`. Fork a thread that used OpenAI or Claude models only onto a model outside the training tier that you pin to an endpoint that does not collect data, or start a new thread instead.
- **Sessions from before this router version:** Their first request after the upgrade decides their side.
- **Requests without a session ID:** Such as from clients other than Codex: not tracked.

---

### Routing policy

The router always forwards the model you selected and never substitutes another, structured output included. Callers other than Codex steer the rest with request headers, which never reach a provider.

| Structured output for | What the router sends |
| --- | --- |
| DeepSeek, with a `json_schema` response format | JSON mode, with the schema as the final developer instruction: the object at the top level, without the format's name, which DeepSeek took as a key to wrap some answers in. Replies follow the schema, but the provider does not enforce it. The history is unchanged, so it keeps its cache hits; `request.forwarded` logs `structuredOutputAdapted`. |
| Other OpenRouter models and Claude | The schema as sent. |

The headers a caller can send:

| Header | Values | Effect |
| --- | --- | --- |
| `X-Codex-Router-Token` | The local token | Required on every request except `GET /health`. |
| `X-Codex-Routing-Policy` | `preserve-model-v1` | Matches the default; sent by the OpenRouter-only profile. Unknown values get HTTP 400. |
| `X-Codex-Router-Prompt-Cache` | `instructions`, `none` | Places Claude's cache breakpoint, as described under Claude's two routes. Unknown values get HTTP 400. |
| `X-Codex-Router-Revision` | A SHA-256 from `/health` | Holds the router's revision, as described under Router capabilities. |
| `X-Codex-Router-Data-Policy` | `deny` | Keeps the request off the training tier, which gets HTTP 409 (`data_policy`), and sends its OpenRouter requests, searches included, only to endpoints that do not collect data, in the router's endpoint order when the request has no `provider` field. A session with no side yet becomes non-training. Unknown values get HTTP 400. |
| `X-Codex-Router-Endpoints` | Up to 16 OpenRouter endpoint tags, separated by commas, such as `deepinfra/fp8,fireworks` | Sends OpenRouter requests to those endpoints in that order, with no fallbacks, in place of the router's endpoint order, the router's own searches included. A request that also sets `provider.order` gets HTTP 400. |
| `X-Codex-Router-Fallback` | `none` | Keeps an `anthropic/` request on Anthropic's API, after a refusal and in the hour after one. A refusal no retry fixes gets HTTP 502 with `error.code` `anthropic_refused` and `error.reason`, or, on the step after a search, `response.failed` with that code; a session already moved to OpenRouter gets HTTP 409 (`route`). The router's searches still run through OpenRouter. Unknown values get HTTP 400. |
| `X-Codex-Router-Thinking-Budget` | Tokens, from 1,024 to below the request's `max_tokens`: its `max_output_tokens` up to 128,000, or 64,000 when unset | On an `anthropic/` model, sends `thinking: {"type": "enabled", "budget_tokens": N}` in place of adaptive thinking and `reasoning.effort`, so Claude thinks on every response within that budget, and implies `X-Codex-Router-Fallback: none`. Only models that still take a budget accept it, such as Claude Sonnet 4.6, Opus 4.6 and Haiku 4.5; later ones answer 400, which ends in a `[router diagnostic]`. Other models and invalid values get HTTP 400. |
| `X-Codex-Router-Report` | `provider` | On a streamed response, adds `provider` to the final event's response at once: `Anthropic` or `OpenAI` on those routes, and `unknown` on OpenRouter, which records the provider only some seconds after the stream ends. Beside it, `route` names the upstream the request went to: `anthropic`, `openrouter` or `openai`. A request pinned to one endpoint also gets `endpoint`, its tag, when an upstream produced the final event. A final event the router writes after its search carries `provider` `unknown`; answers the router writes alone, such as a `[router diagnostic]`, carry neither `provider` nor `route`. |

`GET /v1/generations/<id>`, with the router token, names the provider later, for the final response's `id` of a call made with the report in the last day. It answers `{"id", "status", "provider"}`: `status` is `resolved` with the provider's name, `pending` while OpenRouter has no record yet, or `unknown` after half an hour, and 404 for a generation the router no longer holds. The router asks OpenRouter only then, with its own key, at most once every few seconds per generation, and keeps only the ID, the provider and a time, in memory: the last 50,000 generations, for a day.

A one-shot client that shares its instructions across calls, and must keep its inputs off endpoints that train, sends:

```http
X-Codex-Router-Prompt-Cache: instructions
X-Codex-Router-Data-Policy: deny
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
| `capabilities.dataPolicies` | Values of `X-Codex-Router-Data-Policy` (`deny`). |
| `capabilities.endpointPins` | Support for `X-Codex-Router-Endpoints`. |
| `capabilities.fallbackPolicies` | Values of `X-Codex-Router-Fallback` (`none`). |
| `capabilities.thinkingBudgets` | Support for `X-Codex-Router-Thinking-Budget`. |
| `capabilities.reports` | Values of `X-Codex-Router-Report` (`provider`). |
| `capabilities.generationLookup` | Support for `GET /v1/generations/<id>`. |
| `capabilities.promptCacheModes` | Values of `X-Codex-Router-Prompt-Cache` (`instructions`, `none`), which places Claude's cache breakpoint. |
| `capabilities.revisionPrecondition` | Support for the `X-Codex-Router-Revision` header below. |
| `capabilities.trainingDeclarations` | Values of `training` in `GET /v1/models`, below (`declared-training`, `endpoint`, `provider-terms`, `unknown`). |
| `capabilities.modelTraining` | The meaning of those values (`training-v1`). A later version may change what a value means; a new value alone does not. |
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

`GET /v1/models`, with the router token, lists the catalog's models as `{"id", "object": "model", "training"}`. `training` is a string, never a boolean: what the router itself declares about the model's training, for the weakest route a request for it can take, also without a session ID. A client treats a value it does not know as `unknown` and fails closed.

| `training` | Meaning | Models |
| --- | --- | --- |
| `declared-training` | The router counts it as training-tier. | Muse Spark 1.3 Contributor, Ultra Spark Contributor, and each `CODEX_ROUTER_TRAINING_MODELS` entry |
| `endpoint` | OpenRouter picks the endpoint, and the router does not restrict it to endpoints that do not collect data; `X-Codex-Router-Report` names the provider afterwards. | DeepSeek, Muse Spark 1.3, other OpenRouter models, Claude through OpenRouter, and `anthropic/` models whenever an OpenRouter key is set, since a refusal can move them there |
| `provider-terms` | One provider, or endpoints restricted to those that do not collect data, so that provider's terms decide. | Native OpenAI models, non-training Ultra Spark, and `anthropic/` models without an OpenRouter key |
| `unknown` | A route the router does not classify. | None in the shipped catalog |

The listing follows the router's configuration: its training-tier list and its keys. Headers only make a request stricter: `X-Codex-Router-Data-Policy: deny` restricts OpenRouter requests to endpoints that do not collect data, and `X-Codex-Router-Fallback: none` keeps Claude on Anthropic's API.

---

### Credentials and logging

The router binds only to `127.0.0.1`, and Codex's ChatGPT credentials never leave for OpenRouter or Anthropic. Logs never include request or response bodies, authorization headers, or API keys; see [Structured logs](operations.md#structured-logs).

| Requests to | Endpoint | Credential |
| --- | --- | --- |
| Native OpenAI models | `https://chatgpt.com/backend-api/codex/responses` | Codex's own authentication |
| OpenRouter | `https://openrouter.ai/api/v1/responses` | The OpenRouter key |
| Claude on Anthropic's API | `https://api.anthropic.com/v1/messages` | The Anthropic key |

The keys and the token stay in private files:

- **Storage:** The OpenRouter key, the optional Anthropic key, and the local token live in `unified-router/openrouter.env` under your Codex home, outside this repository. The name predates the Anthropic route and stays for existing installs; each key goes only to its own provider's host.
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