# Test posture

What CI proves on every push, what it cannot prove, and which manual checks a release needs. The suite runs offline against synthetic upstreams with no credentials; anything touching real services, provider accounts, or a live Codex thread needs the checks in [Live compatibility](#live-compatibility).

- [Contract coverage](#contract-coverage): the caller-facing behavior every change must preserve
- [JavaScript coverage](#javascript-coverage): the built-in coverage and its 100% floor
- [Environment matrix](#environment-matrix): which platforms and Node versions CI runs
- [Live compatibility](#live-compatibility): the manual and release checks CI cannot do
- [Test inventory](#test-inventory): what each suite covers

---

### Contract coverage

Other programs rely on the request headers and their values, the `/health` capability keys, `GET /v1/generations/<id>`, and each catalog entry's `training` value. Keys and values are added, never renamed or removed, and the suites below fail if any of them change.

| Contract | Guarded by |
| --- | --- |
| Request headers and values (`X-Codex-Router-*`, `X-Codex-Routing-Policy`) and the upstream header allowlist | `tests/unified-router.test.mjs` |
| Ultra Spark lead and spawned-worker model tiers | `tests/unified-router.test.mjs`, `tests/router-unit-coverage.test.mjs` |
| `/health` capability keys, the served-by report, and `GET /v1/generations/<id>` | `tests/unified-router.test.mjs`, `tests/verify-health.test.mjs` |
| Catalog entries, their rendered prompts, and each entry's `training` value | `tests/catalog.test.mjs` |
| Installer help text and setting validation, matching the [installer settings](setup.md#installer-settings) | `tests/install.test.mjs` |

---

### JavaScript coverage

Node 22 and 24 legs run the suite once with the test runner's built-in coverage over exactly the files the installer ships; Node 20 runs plain `node --test`. The canonical Ubuntu Node 24 leg enforces 100% line, branch, and function thresholds, while every other leg reports coverage without thresholds so platform differences stay visible without failing the run.

The shipped files meet 100% line, branch, and function coverage. Close future gaps with focused regression tests, never by narrowing the includes. The canonical leg also writes LCOV and fails if any `install.mjs`, `router/*.mjs`, or `scripts/*.mjs` file is absent, so an unloaded file cannot disappear from the denominator. It runs this single invocation, so tests execute once, not once per report:

```sh
node --test --experimental-test-coverage \
  --test-coverage-include='router/**/*.mjs' \
  --test-coverage-include='scripts/**/*.mjs' \
  --test-coverage-include='install.mjs' \
  --test-coverage-lines=100 \
  --test-coverage-branches=100 \
  --test-coverage-functions=100
```

> [!NOTE]
> The coverage legs resolve the latest Node 22 and 24 minors, which the include and threshold flags require.

---

### Environment matrix

[CI](../.github/workflows/ci.yml) runs on pushes, pull requests, and manual dispatch. JavaScript syntax, catalog JSON validation, and the shell checks ride along on every leg.

| OS | Node 20 | Node 22 | Node 24 |
| --- | --- | --- | --- |
| Ubuntu | Plain `node --test` | Coverage, no thresholds | Coverage with 100% thresholds (canonical) |
| macOS | Not run | Not run | Coverage, no thresholds |
| Windows | Not run | Not run | Coverage, no thresholds, plus the access-control step |

`tests/prompt-budget.test.mjs` also needs the tested Codex CLI and skips without it. A separate [compatibility workflow](../.github/workflows/compatibility.yml) installs that CLI on macOS and runs both the prompt-budget suite and a smaller request probe. `tests/service-pids.test.mjs` runs with fake service managers, and the installer suite runs `platform/unix/install.sh` on macOS and Linux and `platform/windows/install.ps1` on Windows.

---

### Live compatibility

CI proves the router against synthetic upstreams; it never contacts real provider accounts. The compatibility workflow adds repeatable Codex-version capture, same-provider resume, provider-switch refusal, scratch installation, and ephemeral-router health; its manual multi-version comparison fails on request-shape drift. Run these checks by hand before any release that changes routing, installation, or the tested Codex version:

- **Services:** the scratch lifecycle installs with `--no-service`, starts the installed router on an ephemeral port, and verifies its own process. Separately, install and verify on each OS you ship with `node install.mjs` followed by `node install.mjs --verify`, and confirm the real service owns the process answering health.
- **Providers:** smoke each upstream family with a small prompt on a non-training model: native OpenAI, OpenRouter, Claude on Anthropic's API with `ANTHROPIC_API_KEY`, and Claude on OpenRouter without it. Confirm the served-by report, usage accounting, refusals, and recovery.
- **Codex upgrades:** follow the upgrade checklist for the new CLI (changed headers, request fields, and daemon commands; bundled-model comparison; capture and resume comparisons), review every `prompt-budget` expectation change before updating it, then run the full suite, the installer, and `node install.mjs --verify`.
- **Rollback:** tag the verified commit `codex-<version>` as the fallback, and roll back through it as described in [Rollback](operations.md#rollback). Installer backups cover configuration and catalog, not the router code or `openrouter.env`, so copy those before upgrading if you may want them back.

> [!WARNING]
> Live checks use small prompts on non-training models only. Logs and commits never carry credentials, router tokens, session files, or request and response bodies.

---

### Test inventory

The inventory below is the full `node --test` suite; keep it in step with the `tests/` directory when adding a suite.

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
| `tests/router-unit-coverage.test.mjs` | Direct behavioral coverage for request adaptation, Claude translation and streams, config state, served-by lookups, session limits, and web-search recovery. | All |
| `tests/script-coverage.test.mjs` | CLI edges and failure paths in catalog, credential, config, daemon, renderer, health, and verifier scripts. | All |
| `tests/integration/codex-capture.test.mjs` | Loopback Codex request capture, same-provider append-only resume, provider-switch refusal, baselines, and public-version comparisons. | Codex CLI |
| `tests/integration/service-lifecycle.test.mjs` | Fake supervisor lookups plus scratch install, verify, ephemeral router, and process-identity health. | Codex CLI |
| `tests/integration/prompt-budget-compat.test.mjs` | Fast macOS probe of the tested CLI's tools, request budget, apps, and guardian settings. | macOS compatibility workflow |
| `platform/windows/private-path.test.ps1` | Current-user-only access control lists on Windows. CI runs it in a separate step. | Windows |
