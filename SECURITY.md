# Security policy

---

### Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/mirzahusadzic/codex-unified-model-router/security/advisories/new)). Do not open a public issue for a vulnerability.

Include the affected commit, your platform, and the steps to reproduce. Never include real API keys, router tokens, Codex session files, or captured request bodies; use synthetic values instead.

Fixes are made on `main`; the project does not publish versioned releases yet.

---

### Scope

In scope:

- The router: loopback binding, local token authentication, Host and Origin checks, header allowlists, credential handling, and logging.
- The installers and verifiers: file permissions and access control lists, configuration merging, and backups.

Out of scope:

- Vulnerabilities in Codex, OpenRouter, or model providers. Report those to the respective project or provider.
- Attacks that require running code as the same user or as an administrator. The router is a local single-user service, and its file permissions do not isolate it from software running under your account.

---

### Security model

- The router listens only on `127.0.0.1` and requires a random local token on model requests.
- The installer asks for the OpenRouter key without echoing it, or reads it from a file, so it never appears on a command line. The key and the local token live in a private file under your Codex home directory, outside this repository.
- Logs never contain request or response bodies, authorization headers, API keys, or local tokens. Exact rejected request bodies are captured only when you opt in.
- Muse Spark 1.3 Contributor and Ultra Spark Contributor's workers send their inputs to Meta's contributor tier, which trains on them. Use them only for code you are willing to share. The router never lets them share a session with native OpenAI or Claude models, and after one of those models a session's OpenRouter requests go only to endpoints that do not collect data. DeepSeek's own endpoint may train on prompts and completions, so it is excluded from such sessions.
- The installer turns off Codex analytics by default.
