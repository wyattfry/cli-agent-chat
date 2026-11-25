#!/usr/bin/env bash
set -euo pipefail
umask 077

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required for CLI Agent Chat." >&2
  exit 1
fi

app_dir="$HOME/.local/share/cli-agent-chat"
pid_file="$app_dir/server.pid"
mkdir -p "$app_dir"
chmod 700 "$app_dir"

printf '%s' '${SERVER_JS_BASE64}' | base64 --decode > "$app_dir/server.js"
printf '%s' '${INDEX_HTML_BASE64}' | base64 --decode > "$app_dir/index.html"
printf '%s' '${MCP_JS_BASE64}' | base64 --decode > "$app_dir/mcp-ask-user.js"
printf '%s' '${PACKAGE_JSON_BASE64}' | base64 --decode > "$app_dir/package.json"
printf '%s' '${PACKAGE_LOCK_BASE64}' | base64 --decode > "$app_dir/package-lock.json"

lock_hash="$(sha256sum "$app_dir/package-lock.json" | cut -d ' ' -f1)"
if [ ! -d "$app_dir/node_modules" ] || [ "$(cat "$app_dir/installed-lock.sha256" 2>/dev/null || true)" != "$lock_hash" ]; then
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix "$app_dir"
  printf '%s' "$lock_hash" > "$app_dir/installed-lock.sha256"
fi

if [ -f "$pid_file" ]; then
  old_pid="$(cat "$pid_file")"
  if [[ "$old_pid" =~ ^[0-9]+$ ]] && [ -r "/proc/$old_pid/cmdline" ] &&
     tr '\0' ' ' < "/proc/$old_pid/cmdline" | grep -Fq -- "$app_dir/server.js"; then
    kill "$old_pid" 2>/dev/null || true
  fi
fi

nohup env PORT='${PORT}' node "$app_dir/server.js" > "$app_dir/server.log" 2>&1 &
printf '%s\n' "$!" > "$pid_file"
