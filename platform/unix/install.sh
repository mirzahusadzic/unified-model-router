#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
stamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="$codex_home/backups/codex-unified-router-$stamp-$$"
service_label="com.mirza.codex-unified-router"
platform="$(uname -s)"
launch_agent=""
linux_service="codex-unified-router.service"
linux_unit=""
router_dir="$codex_home/unified-router"
router_file="$router_dir/router.mjs"
router_env="$router_dir/openrouter.env"
force=0
service=1

case "$platform" in
  MINGW*|MSYS*|CYGWIN*)
    printf 'Native Windows uses the PowerShell installer: platform/windows/install.ps1\n' >&2
    exit 2
    ;;
esac

api_key_file=""
change_api_key=0
# install.mjs owns the help text and runs this script with validated options.
usage_error() {
  printf '%s\nRun '\''node install.mjs --help'\'' for usage.\n' "$1" >&2
  exit 2
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) force=1 ;;
    --no-service) service=0 ;;
    --change-api-key) change_api_key=1 ;;
    --api-key-file)
      [[ $# -ge 2 && -n "$2" ]] || usage_error '--api-key-file needs a path, for example: --api-key-file ~/openrouter.key'
      api_key_file="$2"
      shift
      ;;
    -h|--help) exec node "$repo_dir/install.mjs" --help ;;
    *) usage_error "Unknown option: $1" ;;
  esac
  shift
done
if [[ -n "$api_key_file" && "$change_api_key" -eq 1 ]]; then
  usage_error 'Use either --api-key-file or --change-api-key, not both.'
fi

for setting in CODEX_ROUTER_RESTART_DAEMON CODEX_ROUTER_PIN_DAEMON; do
  if [[ "${!setting:-1}" != 0 && "${!setting:-1}" != 1 ]]; then
    printf '%s must be 0 or 1\n' "$setting" >&2
    exit 2
  fi
done

native_models="${CODEX_ROUTER_NATIVE_MODELS:-auto}"
case "$native_models" in
  auto|show|hide) ;;
  *)
    printf 'CODEX_ROUTER_NATIVE_MODELS must be auto, show, or hide\n' >&2
    exit 2
    ;;
esac
# merge-config.mjs applies these; checking them here fails before any prompt.
for setting in CODEX_ROUTER_DISABLE_APPS CODEX_ROUTER_DISABLE_GUARDIAN CODEX_ROUTER_DISABLE_ANALYTICS CODEX_ROUTER_SANDBOX_NETWORK; do
  if [[ -n "${!setting+set}" && "${!setting}" != 0 && "${!setting}" != 1 ]]; then
    printf '%s must be 0 or 1\n' "$setting" >&2
    exit 2
  fi
done
if [[ -n "${CODEX_ROUTER_AGENT_THREADS+set}" && ! "$CODEX_ROUTER_AGENT_THREADS" =~ ^(0|[1-9][0-9]{0,2})$ ]]; then
  printf 'CODEX_ROUTER_AGENT_THREADS must be 0 or a whole number from 1 to 999\n' >&2
  exit 2
fi

for command_name in codex node; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$command_name" >&2
    exit 1
  fi
done

existing_config="$codex_home/config.toml"
existing_profile="$codex_home/unified-openrouter.config.toml"

# Merging into a configuration the router does not manage yet needs consent:
# a yes at the prompt, or --force where no terminal is available. Only a real
# marker line counts as managed, never one inside a TOML string or comment.
unmanaged=()
for file in "$existing_config" "$existing_profile"; do
  if [[ -f "$file" ]] && ! node "$repo_dir/scripts/config-managed.mjs" "$file"; then unmanaged+=("$file"); fi
done
if [[ "$force" -eq 0 && ${#unmanaged[@]} -gt 0 ]]; then
  if [[ ! -t 0 ]]; then
    printf 'Existing Codex configuration found: %s\n' "${unmanaged[*]}" >&2
    printf 'Run the installer in a terminal to confirm merging into it, or pass --force. The files are backed up first.\n' >&2
    exit 2
  fi
  printf 'Existing Codex configuration found:\n' >&2
  printf '  %s\n' "${unmanaged[@]}" >&2
  printf 'The installer backs these files up, then adds its settings and keeps everything else.\n' >&2
  read -r -p 'Merge into them? [y/N] ' answer
  case "$answer" in
    [yY]|[yY][eE][sS]) force=1 ;;
    *)
      printf 'Nothing was changed.\n' >&2
      exit 2
      ;;
  esac
fi

# The OpenRouter key comes from --api-key-file, OPENROUTER_API_KEY, or the
# stored key; otherwise ask for it without echoing. It never appears in a
# command line, where other processes could read it.
prompted_key=""
if [[ -n "$api_key_file" && ! -f "$api_key_file" ]]; then
  printf 'API key file not found: %s\n' "$api_key_file" >&2
  exit 2
fi
# --change-api-key asks for a new key even when one is stored or set.
if [[ "$change_api_key" -eq 1 ]] || [[ -z "$api_key_file" && -z "${OPENROUTER_API_KEY:-}" && ! -f "$router_env" ]]; then
  if [[ ! -t 0 ]]; then
    printf 'No terminal to ask for the OpenRouter API key. Run the installer in a terminal, or pass --api-key-file <path>.\n' >&2
    exit 1
  fi
  printf 'Enter your OpenRouter API key (create one at https://openrouter.ai/keys).\n' >&2
  printf 'Typing is hidden: paste the key and press Enter.\n' >&2
  read -r -s -p 'OpenRouter API key: ' prompted_key
  printf '\n' >&2
  if [[ -z "$prompted_key" ]]; then
    printf 'No OpenRouter API key entered.\n' >&2
    exit 1
  fi
fi

# Progress goes to standard error, so the final summary stays on standard output.
step() { printf '==> %s\n' "$*" >&2; }

step "Installing the Codex Unified Model Router into $codex_home"
if [[ -n "$prompted_key" ]]; then step "Using the OpenRouter API key you entered"
elif [[ -n "$api_key_file" ]]; then step "Reading the OpenRouter API key from $api_key_file"
elif [[ -n "${OPENROUTER_API_KEY:-}" ]]; then step "Using the OpenRouter API key from OPENROUTER_API_KEY"
else step "Using the stored OpenRouter API key"
fi

step "Backing up the current configuration to $backup_dir"
mkdir -p "$codex_home" "$backup_dir" "$router_dir"
chmod 700 "$router_dir" "$backup_dir"

for existing_file in config.toml deepseek.config.toml unified-openrouter.config.toml models.json; do
  if [[ -f "$codex_home/$existing_file" ]]; then
    cp -p "$codex_home/$existing_file" "$backup_dir/$existing_file"
  fi
done

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/codex-unified-router.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

step "Building the model catalog"
codex debug models --bundled > "$tmp_dir/bundled-models.json"

# Native OpenAI models need a ChatGPT plan. In auto mode, hide them from /model
# only when Codex's login shows a missing or lapsed plan.
native_reason="CODEX_ROUTER_NATIVE_MODELS=hide"
if [[ "$native_models" == auto ]]; then
  native_models=show
  if [[ "$(node "$repo_dir/scripts/chatgpt-plan.mjs" "$codex_home")" == inactive ]]; then
    native_models=hide
    native_reason="no active ChatGPT plan"
  fi
fi

node "$repo_dir/scripts/build-catalog.mjs" \
  --bundled "$tmp_dir/bundled-models.json" \
  --catalog-dir "$repo_dir/catalog" \
  --instructions "$repo_dir/prompts/openrouter-instructions.md" \
  --persistent "$repo_dir/prompts/openrouter-persistent.md" \
  --native-models "$native_models" \
  --output "$tmp_dir/models.json"
if [[ "$native_models" == hide ]]; then step "Hiding native OpenAI models from /model ($native_reason)"; fi

step "Updating the Codex configuration"

# Credentials are prepared with the other generated files and installed with
# them, so a failed merge leaves the stored ones untouched.
staged_env="$tmp_dir/openrouter.env"
if [[ -f "$router_env" ]]; then install -m 600 "$router_env" "$staged_env"; fi
if [[ -n "$prompted_key" ]]; then
  printf '%s\n' "$prompted_key" | node "$repo_dir/scripts/prepare-credentials.mjs" "$staged_env" --api-key-stdin
  prompted_key=""
elif [[ -n "$api_key_file" ]]; then
  node "$repo_dir/scripts/prepare-credentials.mjs" "$staged_env" --api-key-file "$api_key_file"
else
  node "$repo_dir/scripts/prepare-credentials.mjs" "$staged_env"
fi
merge_flags=()
if [[ "$force" -eq 1 ]]; then merge_flags+=(--force); fi
node "$repo_dir/scripts/merge-config.mjs" "$existing_config" "$codex_home" "$tmp_dir/config.toml" "$staged_env" "$tmp_dir/unified-openrouter.config.toml" ${merge_flags[@]+"${merge_flags[@]}"}

node "$repo_dir/scripts/verify-catalog.mjs" "$tmp_dir/models.json"

step "Installing the loopback router at 127.0.0.1:18766"
install -m 600 "$staged_env" "$router_env"
install -m 600 "$tmp_dir/config.toml" "$codex_home/config.toml"
install -m 600 "$tmp_dir/unified-openrouter.config.toml" "$codex_home/unified-openrouter.config.toml"
install -m 600 "$tmp_dir/models.json" "$codex_home/models.json"
# The router's modules sit beside its entry file, which is installed as router.mjs.
# A module this version no longer has is removed, since the revision covers every one.
for module in "$router_dir"/*.mjs; do
  [[ -e "$module" ]] || continue
  name="$(basename "$module")"
  [[ "$name" == router.mjs || ( "$name" != unified-router.mjs && -f "$repo_dir/router/$name" ) ]] || rm -f "$module"
done
for module in "$repo_dir"/router/*.mjs; do
  [[ "$(basename "$module")" == unified-router.mjs ]] || install -m 600 "$module" "$router_dir/$(basename "$module")"
done
install -m 600 "$repo_dir/router/unified-router.mjs" "$router_file"

if [[ -f "$codex_home/deepseek.config.toml" ]]; then
  mv "$codex_home/deepseek.config.toml" "$backup_dir/deepseek.config.toml.retired"
fi

# shellcheck source=service-pids.sh
source "$repo_dir/platform/unix/service-pids.sh"

# The router answering must be the service's own, not a stray copy holding the
# port, which would otherwise pass while the service's router keeps failing.
wait_for_router() {
  wait_for_service_router "$platform" "$service_label" "$linux_service" \
    "$repo_dir/scripts/verify-health.mjs" "$router_file" http://127.0.0.1:18766/health
}

systemd_environment_line() {
  local name="$1"
  local value="$2"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf 'Environment="%s=%s"\n' "$name" "$value"
}

systemd_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '"%s"' "$value"
}

print_manual_start() {
  printf 'Automatic router startup was not configured. Start it manually with:\n' >&2
  printf '  CODEX_ROUTER_ENV_FILE=%q CODEX_MODEL_CATALOG=%q CODEX_ROUTER_PORT=18766 node %q\n' \
    "$router_env" "$codex_home/models.json" "$router_file" >&2
  printf 'Verify this installation with: node install.mjs --verify --no-service\n' >&2
}

if [[ "$service" -eq 1 ]]; then
  case "$platform" in
    Darwin)
      if ! command -v launchctl >/dev/null 2>&1; then
        print_manual_start
      else
        launch_agent="$HOME/Library/LaunchAgents/$service_label.plist"
        mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
        cat > "$launch_agent" <<EOF_PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$service_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$router_file</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_ROUTER_ENV_FILE</key>
    <string>$router_env</string>
    <key>CODEX_MODEL_CATALOG</key>
    <string>$codex_home/models.json</string>
    <key>CODEX_ROUTER_PORT</key>
    <string>18766</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/codex-unified-router.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/codex-unified-router.error.log</string>
</dict>
</plist>
EOF_PLIST

        step "Starting the router service with launchd and checking its health"
        launchctl bootout "gui/$(id -u)" "$launch_agent" >/dev/null 2>&1 || true
        launchctl bootstrap "gui/$(id -u)" "$launch_agent"
        launchctl kickstart -k "gui/$(id -u)/$service_label"

        if ! wait_for_router; then
          printf 'The Codex Unified Model Router was installed but did not become healthy. Check %s.\n' "$HOME/Library/Logs/codex-unified-router.error.log" >&2
          exit 1
        fi
      fi
      ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
        linux_unit="$HOME/.config/systemd/user/$linux_service"
        node_bin="$(command -v node)"
        mkdir -p "$(dirname "$linux_unit")"
        {
          printf '[Unit]\n'
          printf 'Description=Codex Unified Model Router\n'
          printf 'After=network-online.target\n\n'
          printf '[Service]\n'
          printf 'Type=simple\n'
          systemd_environment_line CODEX_ROUTER_ENV_FILE "$router_env"
          systemd_environment_line CODEX_MODEL_CATALOG "$codex_home/models.json"
          systemd_environment_line CODEX_ROUTER_PORT 18766
          printf 'ExecStart=%s %s\n' "$(systemd_quote "$node_bin")" "$(systemd_quote "$router_file")"
          printf 'Restart=always\n'
          printf 'RestartSec=2\n\n'
          printf '[Install]\n'
          printf 'WantedBy=default.target\n'
        } > "$linux_unit"

        step "Starting the router service with systemd and checking its health"
        systemctl --user daemon-reload
        systemctl --user enable "$linux_service"
        systemctl --user restart "$linux_service"

        if ! wait_for_router; then
          printf 'The Codex Unified Model Router was installed but did not become healthy. Check:\n' >&2
          printf '  journalctl --user -u %s\n' "$linux_service" >&2
          exit 1
        fi
      else
        print_manual_start
      fi
      ;;
    *)
      print_manual_start
      ;;
  esac
fi

run_by_codex_daemon() {
  local pid=$$ command
  while [[ -n "$pid" && "$pid" -gt 1 ]]; do
    command="$(ps -o command= -p "$pid" 2>/dev/null)" || return 1
    [[ "$command" =~ ^([^[:space:]]*/)?codex[[:space:]]+app-server([[:space:]]|$) ]] && return 0
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  done
  return 1
}

# Restart the shared app-server daemon so it loads the new configuration, and
# pin it to the CLI's Codex; codex-daemon.mjs explains when it skips either.
if [[ "$service" -eq 1 ]]; then
  daemon_flag=""
  if run_by_codex_daemon; then daemon_flag=--codex-runs-installer; fi
  node "$repo_dir/scripts/codex-daemon.mjs" "$codex_home" ${daemon_flag:+"$daemon_flag"}
fi

printf 'Installed the Codex Unified Model Router in %s\n' "$codex_home"
printf 'Backups: %s\n' "$backup_dir"
cat <<'EOF'

Start Codex with a model, or switch with /model:
  DeepSeek V4.1 Flash 1017 (default)
    codex
  Ultra Spark: DeepSeek delegating to non-training Muse workers
    codex -m ultra-spark-private/deepseek-v4.1-flash-1017
  Ultra Spark Contributor: DeepSeek delegating to Muse Contributor workers
    codex -m ultra-spark/deepseek-v4.1-flash-1017
  Muse Spark 1.3
    codex -m openrouter/meta/muse-spark-1.3
  Muse Spark 1.3 Contributor
    codex -m openrouter/meta/muse-spark-1.3-contributor
  Claude Sonnet 5.5
    codex -m anthropic/claude-sonnet-5-5
  Claude Opus 5.5
    codex -m anthropic/claude-opus-5-5
EOF
if [[ "$native_models" == show ]]; then
  printf '  GPT-6 Astra (requires a ChatGPT plan)\n    codex -m gpt-6-astra\n'
fi
cat <<'EOF'

Meta trains on everything sent to Muse Spark 1.3 Contributor, including
Ultra Spark Contributor's workers, so use them for share-safe code only.
EOF
if [[ "$native_models" == hide ]]; then
  printf 'Native OpenAI models are hidden from /model (%s).\n' "$native_reason"
fi
# Hidden native models stay usable by name, so the warning covers them too.
cat <<'EOF'
Tracked Codex sessions never mix native OpenAI or Claude models with
Muse Spark 1.3 Contributor or Ultra Spark Contributor.
EOF
printf 'Restart Codex windows opened before this install to pick up the changes.\n'
