# Unified Model Router

[![CI](https://github.com/mirzahusadzic/unified-model-router/actions/workflows/ci.yml/badge.svg)](https://github.com/mirzahusadzic/unified-model-router/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![Node.js 20+](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![Codex CLI 0.166](https://img.shields.io/badge/Codex%20CLI-0.166-111111)
![macOS · Linux · Windows](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-lightgrey)

A loopback-only Responses API router: local programs get one endpoint for OpenAI, DeepSeek, Claude, Muse Spark and other OpenRouter models, with each session's history and privacy boundaries kept across model switches. Codex is its first client: the installer sets Codex up to switch models from its own picker within one thread, and Codex's requests are what the tests replay.

- **Claude on Anthropic's API:** With `ANTHROPIC_API_KEY`, Claude runs on the Messages API with prompt caching and signed thinking, and moves to OpenRouter if the key, credits or spend limit fail; without the key it runs on OpenRouter.
- **Agent orchestration:** Ultra Spark lets DeepSeek coordinate up to 10 Muse Spark workers with `fork_context: false`, on endpoints that do not train, or on Meta's cheaper training tier as Ultra Spark Contributor.
- **Privacy boundaries:** Training-tier sessions cannot mix with native OpenAI, Claude, or non-training Ultra Spark sessions, and after any of them a session reaches only OpenRouter endpoints that keep no data.
- **Provider compatibility:** Repairs reasoning and tool history, handles DeepSeek JSON-mode structured output, normalizes problematic tool arguments, and never silently substitutes models.
- **Resilient streaming:** Bounded recovery for OpenRouter and Anthropic, context-overflow signaling for Codex compaction, router diagnostics, and disconnect cancellation.
- **Router-run web search:** Every model except native OpenAI ones searches through OpenRouter, and the results stay in the thread for later turns.
- **Local operations:** Loopback binding, token authentication, private credential storage, launchd/systemd/Windows startup, backups, verifiers, and daemon version pinning.
- **Minimal footprint:** Node.js 20+, zero npm runtime dependencies.

---

### How it works

Codex talks to the router as one model provider. The router picks the upstream from the model slug, adapts each request to that provider, and streams the response back. Native OpenAI and Claude models never share a tracked Codex session with training-tier models; requests without a session ID are not tracked. [How routing works](docs/routing.md#routing-and-compatibility) has the details.

**Key:** 🟢 router · 🟡 OpenRouter · 🔵 DeepSeek · 🟠 Anthropic · ⚪ OpenAI · 🔴 training tier, where Meta trains on the inputs.

```mermaid
---
config:
    layout: elk
    look: neo
    themeVariables:
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif'
    flowchart:
        wrappingWidth: 220
        padding: 20
    themeCSS: >-
        foreignObject { overflow: visible; }
        [data-look="neo"] * { filter: none !important; }
        .node foreignObject, .node foreignObject *, .edgeLabel, .edgeLabel * {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif !important; line-height: 1.5 !important; }
        .node foreignObject, .node foreignObject * { white-space: nowrap !important; }
        code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo,
        Consolas, monospace; font-size: 0.9em; line-height: inherit;
        color: inherit !important; text-shadow: none !important;
        padding: 0 4px; border-radius: 4px;
        background: color-mix(in srgb, currentColor 14%, transparent)
        !important; }
        .edgeLabel, .edgeLabel p, .edgeLabel span {
        background: transparent !important; }
        .edgeLabel rect { fill: transparent !important; }
        .labelBkg { --knock: var(--vscode-editor-background,
        var(--bgColor-default, rgb(from currentColor
        clamp(30, (128 - r) * 100, 255) clamp(30, (128 - r) * 100, 255)
        clamp(30, (128 - r) * 100, 255)))); --ring: var(--knock);
        --fill: color-mix(in srgb, var(--ring) 30%, var(--knock));
        background: var(--fill) !important; border-radius: 4px;
        box-shadow: 0 0 0 5px var(--fill), 0 0 0 7px var(--ring); }
        .label[data-id^="L_CX_RT_"] .labelBkg {
        --ring: #2e9e5b; }
        .label[data-id^="L_RT_OR_"] .labelBkg,
        .label[data-id^="L_OR_CL_"] .labelBkg,
        .label[data-id^="L_OR_DS_"] .labelBkg {
        --ring: #e3a008; }
        .label[data-id^="L_RT_AN_"] .labelBkg {
        --ring: #d97757; }
        .label[data-id^="L_RT_OA_"] .labelBkg {
        --ring: #b5bcc6; }
        .label[data-id^="L_US_MU_"] .labelBkg,
        .label[data-id^="L_OA_TT_"] .labelBkg,
        .label[data-id^="L_CL_TT_"] .labelBkg {
        --ring: #c94a4a; }
        .edgeLabel p, .edgeLabel span, .edgeLabel text {
        --halo: var(--fill, var(--vscode-editor-background,
        var(--bgColor-default,
        rgb(from currentColor clamp(0, (128 - r) * 100, 255)
        clamp(0, (128 - r) * 100, 255) clamp(0, (128 - r) * 100, 255)))));
        text-shadow: 1px 0 var(--halo), -1px 0 var(--halo),
        0 1px var(--halo), 0 -1px var(--halo), 1px 1px var(--halo),
        -1px -1px var(--halo), 1px -1px var(--halo), -1px 1px var(--halo),
        0 0 3px var(--halo), 0 0 4px var(--halo); }
---
flowchart TB
    CX["<b>Codex</b><br/>CLI and app-server"]
    RT["<b>Unified Model Router</b><br/>127.0.0.1, local token"]
    OA["<b>ChatGPT Codex backend</b><br/>needs a ChatGPT plan"]
    AN["<b>Anthropic API</b><br/>optional API key"]
    OR["<b>OpenRouter</b><br/>required key<br/>cataloged models<br/><b>web search for all</b><br/><b>but native models</b>"]
    CL["<b>Claude Sonnet · Opus 5.5</b><br/>prompt-cached"]
    DS["<b>DeepSeek V4.1 Flash</b><br/>default; its own<br/>endpoint may train"]
    subgraph TT["Training tier"]
        direction LR
        US["<b>Ultra Spark Contributor</b><br/>DeepSeek leading workers"]
        MU["<b>Muse Spark 1.3 Contributor</b><br/>Meta, trains on inputs"]
    end
    CX -->|"Responses API"| RT
    RT -->|"native models"| OA
    RT -->|"anthropic/ with an Anthropic key"| AN
    RT -->|"deepseek/ · ultra-spark/ · ultra-spark-private/ · openrouter/"| OR
    AN --> CL
    OR -->|"no Anthropic key, or fallback"| CL
    OR -->|"after OpenAI, Claude, or non-training Ultra Spark: data-collecting endpoints blocked"| DS
    OR --> TT
    US -->|"up to 10 workers"| MU
    OA -.-|"refused in the same session"| TT
    CL -.-|"refused in the same session"| TT

    classDef default fill:#8a96a82e,stroke:#8a96a8,stroke-width:1px
    classDef router fill:#2e9e5b4d,stroke:#2e9e5b,stroke-width:2px
    classDef openrouter fill:#e3a0084d,stroke:#e3a008,stroke-width:2px
    classDef deepseek fill:#4d6bfe4d,stroke:#4d6bfe,stroke-width:2px
    classDef openai fill:#b5bcc633,stroke:#b5bcc6,stroke-width:2px
    classDef anthropic fill:#d977574d,stroke:#d97757,stroke-width:2px
    classDef training fill:#c94a4a4d,stroke:#c94a4a,stroke-width:2px
    classDef trainingTier fill:#c94a4a14,stroke:#c94a4a,stroke-width:2px,stroke-dasharray:6 4
    class RT router
    class OR openrouter
    class DS,US deepseek
    class CX,OA openai
    class AN,CL anthropic
    class MU training
    class TT trainingTier
```

<p align="center"><em>All requests go through the router; labels show the route. A dotted line joins models the router never mixes in one session.</em></p>

---

### Install

Requires Codex CLI (tested with **0.166.0**), **Node.js 20+**, and an **OpenRouter API key**. Windows also needs PowerShell 5.1 or later.

Skip the first command if you already have Codex 0.166.0. The first install asks for your OpenRouter API key:

```sh
npm install -g @openai/codex@0.166.0
git clone https://github.com/mirzahusadzic/unified-model-router.git
cd unified-model-router
node install.mjs
node install.mjs --verify
```

#### Keys

| Key | Serves |
| --- | --- |
| OpenRouter (required) | DeepSeek, Ultra Spark, Muse, and other OpenRouter models; Claude without an Anthropic key, or as its fallback; web search for every model except native OpenAI ones |
| Anthropic (optional) | Claude on Anthropic's API first; a thread keeps the route it started on ([which key when](docs/routing.md#claudes-two-routes)) |
| ChatGPT login | Native OpenAI models |

To add the Anthropic key, create an API key at [platform.claude.com](https://platform.claude.com/), put `ANTHROPIC_API_KEY=<the key>` in `~/.codex/unified-router/openrouter.env`, which the installer keeps, and rerun `node install.mjs`.

`install.mjs` runs the installer for your platform from [`platform/`](platform/README.md). Common variations:

| To | Run |
| --- | --- |
| Replace the stored OpenRouter key; it asks for the new one | `node install.mjs --change-api-key` |
| Read the key from a file instead of asking | `node install.mjs --api-key-file ~/openrouter.key` |
| Hide native OpenAI models from `/model` | `CODEX_ROUTER_NATIVE_MODELS=hide node install.mjs` |
| Keep Codex analytics on | `CODEX_ROUTER_DISABLE_ANALYTICS=0 node install.mjs` |
| Let shell commands reach the network without asking | `CODEX_ROUTER_SANDBOX_NETWORK=1 node install.mjs` |

On an existing Codex configuration, the installer asks before merging into it and backs it up first. By default, it also hides native OpenAI models when Codex's login shows no active ChatGPT plan, turns off Codex analytics, ChatGPT connector tools, and the guardian that sends transcripts to OpenAI for review, and allows 10 parallel agents. `node install.mjs --help` summarizes the options; [Installer settings](docs/setup.md#installer-settings) explains each one with its default.

**Start a new thread after installation.** The installer restarts a running Codex app-server daemon for you and pins it to the CLI's Codex, so it no longer updates itself to versions the router has not been tested with ([why](docs/setup.md#daemon-updates)); restart other open Codex windows yourself ([details](docs/setup.md#activate-the-provider)).

---

### Use

Start Codex with the default, DeepSeek V4.1 Flash 1017, or pick another model with `-m`:

```sh
codex
codex -m ultra-spark-private/deepseek-v4.1-flash-1017
codex -m ultra-spark/deepseek-v4.1-flash-1017
codex -m openrouter/meta/muse-spark-1.3-contributor
codex -m anthropic/claude-sonnet-5-5
codex -m anthropic/claude-opus-5-5
```

| Model | Best for |
| --- | --- |
| **DeepSeek V4.1 Flash 1017** (default) | Everyday agentic coding with a long context. [Details](docs/setup.md#deepseek-context-window) |
| **DeepSeek · Ultra Spark** | Broad tasks such as reviews, audits, and changes across many files, on private code: no endpoint in its session trains on inputs. [Details](docs/setup.md#ultra-spark-mode) |
| **DeepSeek · Ultra Spark Contributor** | The same on public code, cheaper, with workers on Meta's training tier. [Details](docs/setup.md#ultra-spark-contributor) |
| **Muse Spark 1.3** | Muse on private code: its endpoint does not train on inputs, at a higher price. [Details](docs/setup.md#muse-spark-13) |
| **Muse Spark 1.3 Contributor** | Fast, inexpensive work on public code. [Details](docs/setup.md#muse-spark-13-contributor) |
| **Claude Sonnet 5.5 · Claude Opus 5.5** | Hard problems that need Anthropic's models; prompt caching keeps long threads affordable. Runs on Anthropic's API when you add `ANTHROPIC_API_KEY` to the [router settings](docs/setup.md#router-settings), otherwise on OpenRouter. [Details](docs/setup.md#claude-sonnet-55-and-claude-opus-55) |
| **Any `openrouter/<vendor>/<model>`** | Trying another model; [add a catalog entry](docs/setup.md#add-a-model) to list it in `/model`. |
| **Native OpenAI**, such as `gpt-6-astra` | Requires a ChatGPT plan. |

Muse Spark 1.3 Contributor and Ultra Spark Contributor's workers use Meta's contributor tier, which trains on everything it receives, so use them only for code you are willing to share. DeepSeek's own endpoint may train on prompts too; after a native OpenAI or Claude model, or in a non-training Ultra Spark session, a session's OpenRouter requests go only to endpoints that keep no data, so pin DeepSeek to one to use it there. The router refuses to mix them with native OpenAI, Claude, or non-training Ultra Spark models in a tracked Codex session; requests without a session ID are not tracked ([details](docs/routing.md#provider-isolation)).

Without a ChatGPT login, add `--profile unified-openrouter` to any of the commands above, Ultra Spark included ([details](docs/setup.md#openrouter-only-profile)). To prefer specific OpenRouter endpoints, set [`CODEX_ROUTER_PROVIDER_ORDER`](docs/setup.md#openrouter-endpoint-preferences).

---

### Develop

```sh
node --test
```

CI tests Linux, macOS, and Windows, checks script syntax, and validates the model catalog. Tests need no API keys or network access.

---

[Configuration](docs/setup.md) · [How routing works](docs/routing.md) · [Services & troubleshooting](docs/operations.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Apache-2.0](LICENSE) · [Notices](NOTICE)
