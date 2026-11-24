# Integration coverage

Repeatable environment and compatibility checks that stay offline: scratch
`CODEX_HOME` directories, loopback servers and ports, synthetic keys, and no
model traffic. Each suite skips safely when its prerequisites are absent, so
`node --test` stays green on machines without the Codex CLI.

---

### Contents

| File | Covers |
| --- | --- |
| `codex-capture.mjs` | Shared capture harness, also runnable directly; see `--help` |
| `codex-capture.test.mjs` | Fresh and resumed request capture, append-only history, provider-switch refusal, baseline comparison, cross-version comparison |
| `service-lifecycle.mjs` | Scratch install, verify, and ephemeral-router orchestration; `--check` runs it, `--real-smoke` prints release smoke |
| `service-lifecycle.test.mjs` | Fake-supervisor lookups plus the full scratch lifecycle |
| `prompt-budget-compat.test.mjs` | Single-model prompt-budget probe for macOS CI with the tested CLI |

---

### Run locally

```sh
node --test tests/integration/
node tests/integration/codex-capture.mjs --out /tmp/captures
node tests/integration/service-lifecycle.mjs --check
```

Captures, baselines, and version comparisons use environment knobs, all optional:

| Variable | Does |
| --- | --- |
| `CODEX_CAPTURE_MODEL`, `CODEX_CAPTURE_PROMPT` | Which model and prompt a capture sends |
| `CODEX_CAPTURE_OUT` | Directory for normalized captures and diff reports |
| `CODEX_CAPTURE_BASELINE` | Directory of earlier captures to compare against; differences fail |
| `CODEX_CAPTURE_VERSIONS` | Two versions to compare, for example `0.171.0,0.172.0`, fetched as public `@openai/codex` packages through npx |
| `CODEX_CAPTURE_STRICT` | `1` fails a version comparison on any difference; unset only reports it for review |

The harness captures a fresh thread and a same-provider resume by explicit
session ID, and asserts that Codex still refuses a provider switch. The exact
native-to-router continuation cannot run on Codex 0.166 or later. Replaying
turns through an installed router stays manual because its upstream base URL is
not redirectable; follow the upgrade steps in `AGENTS.md` with a local capture
server.

---

### Release smoke

CI never restarts services. On a release machine, after the checks above pass:

```sh
node tests/integration/service-lifecycle.mjs --real-smoke
node install.mjs && node install.mjs --verify
```

---

### Limitations

The exact native-to-router switch is impossible in supported Codex releases;
the harness verifies the refusal and same-provider append-only resume instead.
Fake supervisors cover launchd and systemd lookups; Windows startup coverage
stays in the existing installer tests. The full
`tests/prompt-budget.test.mjs` suite stays authoritative for budgets.
