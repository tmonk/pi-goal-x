#!/usr/bin/env bash
# Common config + helpers for pi-goal experiment harness.
# Source from run.sh / extract.sh / grade.sh.

set -euo pipefail

# ---- Test model config ----
#
# TARGET (per goal): provider=fireworks, model=accounts/fireworks/routers/kimi-k2p6-turbo
#
# Credential resolution uses the Fireworks access value in
# ~/.pi/agent/auth.json when present, then falls back to FIREWORKS_API_KEY.
# Never record or print credential values in this repository.
PROVIDER="${PI_GOAL_TEST_PROVIDER:-fireworks}"
MODEL="${PI_GOAL_TEST_MODEL:-accounts/fireworks/routers/kimi-k2p6-turbo}"
THINKING="${PI_GOAL_TEST_THINKING:-high}"
TURN_TIMEOUT="${TURN_TIMEOUT:-360}"  # per-turn wall clock (seconds). 360s gives headroom for sisyphus autoContinue chains of 3-5 steps with thinking=high.

# Resolve a working FIREWORKS_API_KEY if the shell-exported one is invalid.
# Strategy: prefer ~/.pi/agent/auth.json's fireworks.access (the OAuth fpk_ token,
# which fireworks accepts as a bearer). Fall back to whatever was already in env.
resolve_fireworks_key() {
  local fpk
  fpk="$(jq -r '.fireworks.access // empty' "${HOME}/.pi/agent/auth.json" 2>/dev/null)"
  if [[ -n "${fpk}" ]]; then
    echo "${fpk}"
    return
  fi
  echo "${FIREWORKS_API_KEY:-}"
}

if [[ "${PROVIDER}" == "fireworks" ]]; then
  RESOLVED_FW_KEY="$(resolve_fireworks_key)"
  if [[ -n "${RESOLVED_FW_KEY}" ]]; then
    export FIREWORKS_API_KEY="${RESOLVED_FW_KEY}"
  fi
fi

# ---- Provider smoke validation ----
# Fast-fail before burning runs on an invalid key / missing model. Uses the
# selected MODEL (not a hardcoded one), validates HTTP status and JSON shape,
# and caps the reported response text.
validate_provider() {
  if [[ "${PROVIDER}" != "fireworks" ]]; then
    return 0
  fi
  local key="${FIREWORKS_API_KEY:-}"
  if [[ -z "${key}" ]]; then
    echo "ERROR: No FIREWORKS_API_KEY resolved. Check ~/.pi/agent/auth.json or env." >&2
    return 1
  fi
  local body
  body="$(cat <<JSON
{"model":"${MODEL}","messages":[{"role":"user","content":"hi"}],"max_tokens":5}
JSON
)"
  local resp status
  resp="$(curl -sS -X POST "https://api.fireworks.ai/inference/v1/chat/completions" \
    -H "Authorization: Bearer ${key}" \
    -H "Content-Type: application/json" \
    -d "${body}" -w "\n%{http_code}" 2>&1)"
  status="$(printf '%s' "${resp}" | tail -n1 | tr -d '[:space:]')"
  local payload
  payload="$(printf '%s' "${resp}" | sed '$d')"
  if [[ "${status}" != "200" ]]; then
    local capped
    capped="$(printf '%s' "${payload}" | head -c 200)"
    echo "ERROR: Provider smoke test failed (HTTP ${status}). Response: ${capped}" >&2
    return 1
  fi
  if ! printf '%s' "${payload}" | grep -q '"choices"'; then
    local capped2
    capped2="$(printf '%s' "${payload}" | head -c 200)"
    echo "ERROR: Provider smoke test returned unexpected JSON shape. Response: ${capped2}" >&2
    return 1
  fi
  echo "Provider smoke OK (${PROVIDER}/${MODEL})." >&2
}

# ---- Paths ----
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENTS_DIR="${PI_GOAL_EXPERIMENTS_DIR:-$(cd "${HARNESS_DIR}/.." && pwd)}"
REPO_DIR="${PI_GOAL_REPO_DIR:-$(cd "${EXPERIMENTS_DIR}/.." && pwd)}"
EXTENSION_PATH="${REPO_DIR}/extensions/goal.ts"

# ---- Portable timeout ----
# GNU timeout is not standard on macOS. Discover, in order: timeout,
# gtimeout, then a small Node watchdog; otherwise fail with a clear
# prerequisite message.
TIMEOUT_PREFIX=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_PREFIX="timeout --foreground"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_PREFIX="gtimeout"
elif command -v node >/dev/null 2>&1; then
  TIMEOUT_PREFIX="node ${HARNESS_DIR}/watchdog.mjs"
else
  echo "ERROR: no timeout command available (tried timeout, gtimeout, node watchdog). Install coreutils (brew install coreutils) or a node runtime." >&2
  exit 1
fi
export TIMEOUT_PREFIX

# ---- Common pi flags ----
# Subshell substitutes "$@" expansion safely.
pi_base_flags() {
  printf '%s\n' \
    --provider "${PROVIDER}" \
    --model "${MODEL}" \
    --thinking "${THINKING}" \
    --no-extensions \
    -e "${EXTENSION_PATH}" \
    --no-context-files \
    --no-skills \
    --no-prompt-templates \
    --no-themes \
    --mode json
}

# Make a fresh run directory under cases/<case>/runs/<ts>-<rand>/ with sandbox + sessions.
# Includes a random suffix so concurrent runs never collide (macOS date lacks %N).
new_run_dir() {
  local case_dir="$1"
  local ts rand
  ts="$(date +%Y%m%d-%H%M%S)"
  rand="$(openssl rand -hex 2 2>/dev/null || jot -r 1 100 999 2>/dev/null || python3 -c 'import random; print(f"{random.randint(0,65535):04x}")' 2>/dev/null || echo "$$")"
  local run_dir="${case_dir}/runs/${ts}-${rand}"
  mkdir -p "${run_dir}/sandbox" "${run_dir}/sessions"
  echo "${run_dir}"
}

# Path to most recent run for a case, or empty.
latest_run_dir() {
  local case_dir="$1"
  local latest
  latest="$(ls -1d "${case_dir}/runs/"*/ 2>/dev/null | tail -n1)"
  [[ -n "${latest}" ]] && echo "${latest%/}" || true
}

# Resolve a "case id or run dir" argument to a run dir.
resolve_run_dir() {
  local arg="$1"
  if [[ -d "${arg}" && -f "${arg}/raw.ndjson" ]]; then
    echo "${arg}"; return
  fi
  local case_dir
  case_dir="$(resolve_case_dir "${arg}")"
  local run
  run="$(latest_run_dir "${case_dir}")"
  [[ -z "${run}" ]] && { echo "No runs found for case ${arg}" >&2; exit 2; }
  echo "${run}"
}

# Load the supported case-id allowlist from SUPPORTED_CASES.json.
supported_case_ids() {
  local file="${EXPERIMENTS_DIR}/SUPPORTED_CASES.json"
  jq -r '.supported[]' "${file}" 2>/dev/null || true
}

is_supported_case() {
  local id="$1"
  local sid
  while read -r sid; do
    [[ -z "${sid}" ]] && continue
    [[ "${sid}" == "${id}" ]] && return 0
  done < <(supported_case_ids)
  return 1
}

# Resolve a case id (or dir) to a case dir.
# Exact SUPPORTED_CASES.json membership is enforced BEFORE directory
# resolution. Raw case directories (INPUT.md present) require the explicit
# ALLOW_UNSUPPORTED=1 diagnostic flag.
resolve_case_dir() {
  local arg="$1"
  if [[ -d "${arg}" && -f "${arg}/INPUT.md" ]]; then
    if [[ "${ALLOW_UNSUPPORTED:-0}" != "1" ]]; then
      echo "Raw case directory requires the explicit diagnostic flag: ALLOW_UNSUPPORTED=1 (run.sh --allow-unsupported)." >&2
      echo "Supported case ids are listed in ${EXPERIMENTS_DIR}/SUPPORTED_CASES.json" >&2
      exit 2
    fi
    echo "${arg}"; return
  fi
  if ! is_supported_case "${arg}"; then
    echo "Unsupported case id: ${arg}" >&2
    echo "SUPPORTED_CASES.json is enforced: exact case-id membership is required." >&2
    echo "Use: run.sh <case-id> (e.g. C20-core-tool-selection), or run.sh <raw-case-dir> --allow-unsupported for diagnostics." >&2
    exit 2
  fi
  local d="${EXPERIMENTS_DIR}/cases/${arg}"
  if [[ ! -d "${d}" ]]; then
    echo "No such case directory even though it is listed as supported: ${arg}" >&2
    exit 2
  fi
  echo "${d}"
}
