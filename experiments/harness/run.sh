#!/usr/bin/env bash
# bash 3.2 compatible (macOS default). Don't use globstar or nullglob.
# Usage: run.sh <case-id-or-dir> [--grade]
#
# Drives a pi AgentSession via the SDK driver (drive.mjs), not `pi -p`,
# because `pi -p` exits before slash-command-queued continuation turns
# can be drained. The driver awaits each `session.prompt()` so queued
# drafting turns complete before we move on.
#
# Multi-turn input via INPUT.md lines:
#   TURN: <user prompt>
#   SLEEP: <ms>           (optional; rarely needed)
#   #  ... comment
#
# Output:
#   <run-dir>/raw.ndjson      — NDJSON event stream (pi --mode json shape, plus
#                               _turn_marker / _turn_done / _drive_error helpers)
#   <run-dir>/stderr.log      — driver stderr
#   <run-dir>/meta.json       — run metadata
#   <run-dir>/sandbox/        — pi's cwd; disk artifacts (.pi/goals/...) land here
#   <run-dir>/sessions/       — isolated pi session files
#   <run-dir>/agent-dir/      — isolated $AGENT_DIR (no host skills/themes leak)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

# Parse arguments: run.sh <case-id-or-dir> [--count N] [--grade] [--no-smoke] [--allow-unsupported]
CASE_ARG="${1:?usage: run.sh <case-id-or-dir> [--count N] [--grade] [--no-smoke] [--allow-unsupported]}"
shift || true
RUN_COUNT=1
GRADE_AFTER=0
SKIP_SMOKE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --count) RUN_COUNT="${2:?--count requires a number}"; shift 2 ;;
    --grade) GRADE_AFTER=1; shift ;;
    --no-smoke) SKIP_SMOKE=1; shift ;;
    --allow-unsupported) ALLOW_UNSUPPORTED=1; export ALLOW_UNSUPPORTED; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

CASE_DIR="$(resolve_case_dir "${CASE_ARG}")"
INPUT_FILE="${CASE_DIR}/INPUT.md"
[[ -f "${INPUT_FILE}" ]] || { echo "Missing ${INPUT_FILE}" >&2; exit 2; }

# Optional pre-seed script (sets up sandbox before driver runs)
SEED_SCRIPT="${CASE_DIR}/seed.sh"

# ---- Provider validation (fast-fail if credentials broken) ----
if [[ "${SKIP_SMOKE}" -eq 0 ]]; then
  validate_provider
fi

# Driver does its own timeout per turn; we still wrap with an outer guard at
# turn_timeout * (estimated turn count) to bound total wall clock.
TURN_COUNT="$(grep -cE '^TURN: ' "${INPUT_FILE}")"
[[ "${TURN_COUNT}" -lt 1 ]] && TURN_COUNT=1
OUTER_TIMEOUT="$(( TURN_TIMEOUT * (TURN_COUNT + 1) ))"

# Single run helper.
run_one() {
  local idx="$1"
  local run_dir="$2"
  local sandbox="${run_dir}/sandbox"
  local raw_ndjson="${run_dir}/raw.ndjson"
  local stderr_log="${run_dir}/stderr.log"
  local meta_file="${run_dir}/meta.json"

  # Pre-seed sandbox if seed.sh exists and is executable.
  if [[ -x "${SEED_SCRIPT}" ]]; then
    ( cd "${sandbox}" && bash "${SEED_SCRIPT}" ) >> "${run_dir}/seed.log" 2>&1
  fi

  local start_ts end_ts rc
  start_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  set +e
  RTK_DISABLED=1 \
  PI_GOAL_TEST_EXTENSION="${EXTENSION_PATH}" \
  PI_GOAL_TEST_PROVIDER="${PROVIDER}" \
  PI_GOAL_TEST_MODEL="${MODEL}" \
  PI_GOAL_TEST_THINKING="${THINKING}" \
  PI_GOAL_TEST_TURN_TIMEOUT="${TURN_TIMEOUT}" \
    ${TIMEOUT_PREFIX} "${OUTER_TIMEOUT}" \
      node "${SCRIPT_DIR}/drive.mjs" "${CASE_DIR}" "${run_dir}" \
      > "${raw_ndjson}" \
      2> "${stderr_log}"
  rc=$?
  set -e

  end_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  cat > "${meta_file}" <<JSON
{
  "case": "$(basename "${CASE_DIR}")",
  "run_index": ${idx},
  "started_at": "${start_ts}",
  "ended_at": "${end_ts}",
  "turns_declared": ${TURN_COUNT},
  "provider": "${PROVIDER}",
  "model": "${MODEL}",
  "thinking": "${THINKING}",
  "turn_timeout": ${TURN_TIMEOUT},
  "outer_timeout": ${OUTER_TIMEOUT},
  "driver_exit": ${rc}
}
JSON

  echo "Run[${idx}] done: ${run_dir} (exit ${rc})"
  if [[ "${rc}" -ne 0 ]]; then
    echo "  (see ${stderr_log})"
  fi

  if [[ "${GRADE_AFTER}" -eq 1 ]]; then
    "${SCRIPT_DIR}/extract.sh" "${run_dir}"
    "${SCRIPT_DIR}/grade.sh" "${run_dir}"
  fi
}

# Fireworks router supports up to 5 concurrent requests.
MAX_CONCURRENT=5

if [[ "${RUN_COUNT}" -eq 1 ]]; then
  RUN_DIR="$(new_run_dir "${CASE_DIR}")"
  echo "Run dir: ${RUN_DIR}"
  run_one 1 "${RUN_DIR}"
else
  echo "Running ${RUN_COUNT} instances (max concurrent ${MAX_CONCURRENT}) ..."
  declare -a RUN_DIRS
  for i in $(seq 1 "${RUN_COUNT}"); do
    RUN_DIRS+=("$(new_run_dir "${CASE_DIR}")")
  done
  for i in $(seq 1 "${RUN_COUNT}"); do
    # Throttle to MAX_CONCURRENT background jobs.
    while [[ $(jobs -r | wc -l | tr -d ' ') -ge ${MAX_CONCURRENT} ]]; do
      sleep 0.3
    done
    run_one "${i}" "${RUN_DIRS[$((i-1))]}" &
  done
  wait
  echo "All ${RUN_COUNT} runs complete."
fi
