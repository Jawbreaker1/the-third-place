#!/bin/zsh

set -eu

ROOT_DIR="${0:A:h}"
SCRIPT_PATH="${ROOT_DIR}/third-place.sh"
SERVER_ENTRY="${ROOT_DIR}/dist-server/server/index.js"
WEB_BUILD="${ROOT_DIR}/dist/index.html"

SERVICE_LABEL="${THIRD_PLACE_SERVICE_LABEL:-com.johanengwall.the-third-place}"
SERVICE_TARGET="gui/$(id -u)/${SERVICE_LABEL}"
STDOUT_LOG="${THIRD_PLACE_STDOUT_LOG:-/tmp/the-third-place.stdout.log}"
STDERR_LOG="${THIRD_PLACE_STDERR_LOG:-/tmp/the-third-place.stderr.log}"
APP_URL="${THIRD_PLACE_APP_URL:-http://127.0.0.1:4000}"
APP_PORT="${THIRD_PLACE_APP_PORT:-4000}"

NGROK_SERVICE_LABEL="${THIRD_PLACE_NGROK_SERVICE_LABEL:-${SERVICE_LABEL}.ngrok}"
NGROK_SERVICE_TARGET="gui/$(id -u)/${NGROK_SERVICE_LABEL}"
NGROK_API_URL="${THIRD_PLACE_NGROK_API_URL:-http://127.0.0.1:4040/api/tunnels}"
NGROK_TARGET="${THIRD_PLACE_NGROK_TARGET:-http://localhost:${APP_PORT}}"
NGROK_STDOUT_LOG="${THIRD_PLACE_NGROK_STDOUT_LOG:-/tmp/the-third-place.ngrok.stdout.log}"
NGROK_STDERR_LOG="${THIRD_PLACE_NGROK_STDERR_LOG:-/tmp/the-third-place.ngrok.stderr.log}"

usage() {
  cat <<'USAGE'
Usage: ./third-place.sh <start|stop|restart|status>

  start    Start The Third Place and ensure an ngrok tunnel is available
  stop     Stop the app and any ngrok tunnel started by this script
  restart  Restart the app and preserve or restore its ngrok tunnel
  status   Show app status and the current public ngrok address
USAGE
}

service_is_loaded() {
  launchctl print "${SERVICE_TARGET}" >/dev/null 2>&1
}

service_is_running() {
  launchctl print "${SERVICE_TARGET}" 2>/dev/null | grep -q "state = running"
}

app_is_responding() {
  curl -fsS --connect-timeout 1 --max-time 2 "${APP_URL}/" >/dev/null 2>&1
}

wait_for_app() {
  local attempt
  for attempt in {1..20}; do
    if service_is_running && app_is_responding; then
      return
    fi
    sleep 0.25
  done
  return 1
}

ngrok_service_is_loaded() {
  launchctl print "${NGROK_SERVICE_TARGET}" >/dev/null 2>&1
}

ngrok_api_payload() {
  curl -fsS --connect-timeout 1 --max-time 2 "${NGROK_API_URL}" 2>/dev/null
}

ngrok_public_url() {
  local payload node_bin
  payload="$(ngrok_api_payload)" || return 1
  node_bin="$(command -v node || true)"
  [[ -n "${node_bin}" ]] || return 1

  printf '%s' "${payload}" | "${node_bin}" -e '
    const fs = require("node:fs");
    const expectedPort = String(process.argv[1]);
    const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);
    const data = JSON.parse(fs.readFileSync(0, "utf8"));
    const tunnel = Array.isArray(data.tunnels) ? data.tunnels.find((candidate) => {
      if (candidate?.proto !== "https" || typeof candidate?.public_url !== "string") return false;
      const rawAddress = candidate?.config?.addr;
      if (typeof rawAddress !== "string") return false;
      if (/^[0-9]+$/.test(rawAddress)) return rawAddress === expectedPort;
      try {
        const address = new URL(rawAddress.includes("://") ? rawAddress : `http://${rawAddress}`);
        const port = address.port || (address.protocol === "https:" ? "443" : "80");
        return loopbackHosts.has(address.hostname) && port === expectedPort;
      } catch {
        return false;
      }
    }) : undefined;
    if (tunnel) process.stdout.write(tunnel.public_url);
  ' "${APP_PORT}"
}

print_public_url() {
  local public_url="${1}"
  if curl -fsS --connect-timeout 2 --max-time 8 "${public_url}/" >/dev/null 2>&1; then
    echo "Public ngrok address: ${public_url}"
  else
    echo "Public ngrok address: ${public_url} (registered; external response not yet verified)"
  fi
}

ensure_build() {
  local node_bin
  node_bin="$(command -v node || true)"
  if [[ -n "${node_bin}" && -f "${SERVER_ENTRY}" && -f "${WEB_BUILD}" ]] && \
      "${node_bin}" "${ROOT_DIR}/scripts/build-freshness.mjs" check; then
    return
  fi

  local npm_bin
  npm_bin="$(command -v npm || true)"
  if [[ -z "${npm_bin}" ]]; then
    echo "npm was not found, so the missing or outdated production build cannot be created." >&2
    return 1
  fi

  echo "Production build is missing or outdated; building it now..."
  (cd "${ROOT_DIR}" && "${npm_bin}" run build)
}

run_server() {
  local node_bin="${1:-}"
  if [[ -z "${node_bin}" || ! -x "${node_bin}" ]]; then
    echo "The Node.js executable is missing or invalid: ${node_bin}" >&2
    return 1
  fi

  cd "${ROOT_DIR}"
  export NODE_ENV=production
  exec "${node_bin}" "${SERVER_ENTRY}"
}

run_ngrok() {
  local ngrok_bin="${1:-}"
  local target="${2:-}"
  if [[ -z "${ngrok_bin}" || ! -x "${ngrok_bin}" ]]; then
    echo "The ngrok executable is missing or invalid: ${ngrok_bin}" >&2
    return 1
  fi

  exec "${ngrok_bin}" http "${target}" --log=stdout --log-format=logfmt
}

start_service() {
  if service_is_loaded; then
    if service_is_running && app_is_responding; then
      echo "The Third Place is already running at ${APP_URL}"
      return
    fi

    echo "Removing an unhealthy service registration before restarting..."
    launchctl remove "${SERVICE_LABEL}" >/dev/null 2>&1 || true
  fi

  ensure_build

  local node_bin
  node_bin="$(command -v node || true)"
  if [[ -z "${node_bin}" ]]; then
    echo "Node.js was not found in PATH." >&2
    return 1
  fi

  : >"${STDOUT_LOG}"
  : >"${STDERR_LOG}"

  launchctl submit \
    -l "${SERVICE_LABEL}" \
    -o "${STDOUT_LOG}" \
    -e "${STDERR_LOG}" \
    -- "${SCRIPT_PATH}" __run "${node_bin}"

  if wait_for_app; then
    echo "The Third Place is running at ${APP_URL}"
    echo "Logs: ${STDOUT_LOG} and ${STDERR_LOG}"
    return
  fi

  echo "The service was submitted, but the app did not become ready." >&2
  if [[ -s "${STDERR_LOG}" ]]; then
    echo "Last error output:" >&2
    tail -n 20 "${STDERR_LOG}" >&2
  fi
  return 1
}

stop_service() {
  if ! service_is_loaded; then
    echo "The Third Place is already stopped."
    return
  fi

  launchctl remove "${SERVICE_LABEL}"

  local attempt
  for attempt in {1..40}; do
    if ! service_is_loaded; then
      echo "The Third Place has stopped."
      return
    fi
    sleep 0.1
  done

  echo "The service is still registered after the stop request." >&2
  return 1
}

ensure_ngrok_tunnel() {
  local public_url ngrok_bin
  if public_url="$(ngrok_public_url)" && [[ -n "${public_url}" ]]; then
    print_public_url "${public_url}"
    return
  fi

  if ngrok_api_payload >/dev/null 2>&1; then
    echo "ngrok is running, but none of its HTTPS tunnels target local port ${APP_PORT}." >&2
    echo "The existing ngrok process was left untouched." >&2
    return 1
  fi

  ngrok_bin="$(command -v ngrok || true)"
  if [[ -z "${ngrok_bin}" ]]; then
    echo "ngrok was not found in PATH; the local app is running without a public tunnel." >&2
    return 1
  fi

  if ngrok_service_is_loaded; then
    echo "Removing an unhealthy ngrok service registration before restarting..."
    launchctl remove "${NGROK_SERVICE_LABEL}" >/dev/null 2>&1 || true
  fi

  : >"${NGROK_STDOUT_LOG}"
  : >"${NGROK_STDERR_LOG}"
  launchctl submit \
    -l "${NGROK_SERVICE_LABEL}" \
    -o "${NGROK_STDOUT_LOG}" \
    -e "${NGROK_STDERR_LOG}" \
    -- "${SCRIPT_PATH}" __run-ngrok "${ngrok_bin}" "${NGROK_TARGET}"

  local attempt
  for attempt in {1..40}; do
    if public_url="$(ngrok_public_url)" && [[ -n "${public_url}" ]]; then
      print_public_url "${public_url}"
      echo "ngrok logs: ${NGROK_STDOUT_LOG} and ${NGROK_STDERR_LOG}"
      return
    fi
    sleep 0.25
  done

  echo "ngrok was started, but no HTTPS tunnel for port ${APP_PORT} appeared." >&2
  if [[ -s "${NGROK_STDERR_LOG}" ]]; then
    echo "Last ngrok error output:" >&2
    tail -n 20 "${NGROK_STDERR_LOG}" >&2
  fi
  return 1
}

stop_owned_ngrok() {
  if ! ngrok_service_is_loaded; then
    return
  fi

  launchctl remove "${NGROK_SERVICE_LABEL}"

  local attempt
  for attempt in {1..40}; do
    if ! ngrok_service_is_loaded; then
      echo "The script-managed ngrok tunnel has stopped."
      return
    fi
    sleep 0.1
  done

  echo "The script-managed ngrok service is still registered after the stop request." >&2
  return 1
}

start_all() {
  start_service
  ensure_ngrok_tunnel
}

stop_all() {
  local exit_status=0
  stop_service || exit_status=$?
  stop_owned_ngrok || exit_status=$?
  return "${exit_status}"
}

show_status() {
  local exit_status=0
  if ! service_is_loaded; then
    echo "The Third Place is stopped."
  elif service_is_running; then
    local pid
    pid="$(launchctl print "${SERVICE_TARGET}" | awk '$1 == "pid" && $2 == "=" { print $3; exit }')"
    echo "The Third Place is running${pid:+ (PID ${pid})} at ${APP_URL}"
  else
    echo "The service is registered, but its process is not running." >&2
    echo "Check ${STDOUT_LOG} and ${STDERR_LOG}." >&2
    exit_status=1
  fi

  local public_url
  if public_url="$(ngrok_public_url)" && [[ -n "${public_url}" ]]; then
    print_public_url "${public_url}"
  else
    echo "No ngrok HTTPS tunnel currently targets local port ${APP_PORT}." >&2
    exit_status=1
  fi

  return "${exit_status}"
}

command="${1:-}"
case "${command}" in
  __run)
    run_server "${2:-}"
    ;;
  __run-ngrok)
    run_ngrok "${2:-}" "${3:-}"
    ;;
  start)
    start_all
    ;;
  stop)
    stop_all
    ;;
  restart)
    stop_service
    start_all
    ;;
  status)
    show_status
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
