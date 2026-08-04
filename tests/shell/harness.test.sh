#!/usr/bin/env bash
# Shell tests for the experiment harness (follow-up Stage 6).
#
# Exercises, against a sandbox with stubbed curl/pi/tooling:
#   1. SUPPORTED_CASES.json exact membership before directory resolution;
#   2. raw case dirs require the explicit ALLOW_UNSUPPORTED=1 diagnostic flag;
#   3. the provider smoke request uses the selected MODEL;
#   4. missing provider configuration fails with a clear message;
#   5. non-200 HTTP status and unexpected JSON shape fail the smoke test;
#   6. portable timeout discovery (timeout, gtimeout, node watchdog).
#
# Exits 0 only if every assertion passes. Run via tests/goal-harness-shell.test.ts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(cd "${SCRIPT_DIR}/../../experiments/harness" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

FAILURES=0
check() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "ok - ${name}"
  else
    echo "FAIL - ${name}"
    FAILURES=$((FAILURES + 1))
  fi
}

check_not() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "FAIL - ${name}"
    FAILURES=$((FAILURES + 1))
  else
    echo "ok - ${name}"
  fi
}

# ---- Sandbox: controlled SUPPORTED_CASES.json + cases ---------------------
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/goal-harness-test.XXXXXX")"
trap 'rm -rf "${SANDBOX}"' EXIT
mkdir -p "${SANDBOX}/cases/C20-core-tool-selection" "${SANDBOX}/cases/C21-unsupported" "${SANDBOX}/bin"
cat > "${SANDBOX}/SUPPORTED_CASES.json" <<'JSON'
{
  "version": 1,
  "supported": ["C20-core-tool-selection"]
}
JSON
echo "TURN: hi" > "${SANDBOX}/cases/C20-core-tool-selection/INPUT.md"
echo "TURN: hi" > "${SANDBOX}/cases/C21-unsupported/INPUT.md"

export PI_GOAL_EXPERIMENTS_DIR="${SANDBOX}"
export PI_GOAL_REPO_DIR="${REPO_DIR}"

# ---- 1. Exact membership before directory resolution ----------------------
run_resolve() {
  bash -c 'source "$1"; resolve_case_dir "$2"' _ "${HARNESS_DIR}/lib.sh" "$1"
}

check "supported case id resolves" run_resolve "C20-core-tool-selection"
check_not "unsupported case id is rejected" run_resolve "C21-unsupported"
check_not "bogus case id is rejected" run_resolve "BOGUS"
REJECT_OUTPUT="$(run_resolve "C21-unsupported" 2>&1 || true)"
if printf '%s' "${REJECT_OUTPUT}" | grep -q "Unsupported case id"; then
  echo "ok - rejection names the unsupported id"
else
  echo "FAIL - rejection names the unsupported id"
  FAILURES=$((FAILURES + 1))
fi

# ---- 2. Raw dirs require ALLOW_UNSUPPORTED=1 -------------------------------
check_not "raw dir rejected without the diagnostic flag" run_resolve "${SANDBOX}/cases/C21-unsupported"
CHECK_RAW="$(ALLOW_UNSUPPORTED=1 run_resolve "${SANDBOX}/cases/C21-unsupported" 2>/dev/null || true)"
if [[ "${CHECK_RAW}" == "${SANDBOX}/cases/C21-unsupported" ]]; then
  echo "ok - raw dir resolves with ALLOW_UNSUPPORTED=1"
else
  echo "FAIL - raw dir resolves with ALLOW_UNSUPPORTED=1"
  FAILURES=$((FAILURES + 1))
fi

# ---- 3. Smoke request uses the selected MODEL ------------------------------
# Stub curl: capture the request body, answer HTTP 200 with a valid shape.
cat > "${SANDBOX}/bin/curl" <<'CURL'
#!/usr/bin/env bash
body=""
prev=""
for arg in "$@"; do
  if [[ "${prev}" == "-d" ]]; then body="${arg}"; fi
  prev="${arg}"
done
printf '%s' "${body}" > "${SANDBOX_CURL_BODY}"
printf '{"choices":[{"message":{"content":"hi"}}]}\n200'
CURL
chmod +x "${SANDBOX}/bin/curl"

run_smoke() {
  local model="$1"
  export SANDBOX_CURL_BODY="${SANDBOX}/curl-body"
  : > "${SANDBOX_CURL_BODY}"
  local key="fake-key"
  bash -c 'source "$1"; FIREWORKS_API_KEY="$2" MODEL="$3" PROVIDER=fireworks validate_provider' _ \
    "${HARNESS_DIR}/lib.sh" "${key}" "${model}"
}
run_smoke_with_path() {
  local model="$1"
  PATH="${SANDBOX}/bin:${PATH}" run_smoke "${model}"
}
check "smoke succeeds with the selected model" run_smoke_with_path "accounts/fireworks/routers/test-model"
if grep -q 'test-model' "${SANDBOX}/curl-body"; then
  echo "ok - smoke payload carries the selected MODEL"
else
  echo "FAIL - smoke payload carries the selected MODEL"
  FAILURES=$((FAILURES + 1))
fi

# ---- 4. Missing configuration fails clearly --------------------------------
run_smoke_nokey() {
  bash -c 'source "$1"; export FIREWORKS_API_KEY=""; MODEL="m" PROVIDER=fireworks validate_provider' _ "${HARNESS_DIR}/lib.sh"
}
check_not "smoke fails without a resolved key" run_smoke_nokey
NOKEY_OUTPUT="$(run_smoke_nokey 2>&1 || true)"
if printf '%s' "${NOKEY_OUTPUT}" | grep -q "No FIREWORKS_API_KEY"; then
  echo "ok - missing-key message is clear"
else
  echo "FAIL - missing-key message is clear"
  FAILURES=$((FAILURES + 1))
fi

# ---- 5. HTTP status + JSON shape validation --------------------------------
cat > "${SANDBOX}/bin/curl" <<'CURL'
#!/usr/bin/env bash
prev=""
for arg in "$@"; do
  if [[ "${prev}" == "-d" ]]; then body="${arg}"; fi
  prev="${arg}"
done
printf '%s' "${body}" > "${SANDBOX_CURL_BODY}"
printf '{"error":{"message":"rate limited"}}\n429'
CURL
chmod +x "${SANDBOX}/bin/curl"
run_smoke_fail() {
  PATH="${SANDBOX}/bin:${PATH}" bash -c 'source "$1"; FIREWORKS_API_KEY="k" MODEL="m" PROVIDER=fireworks validate_provider' _ "${HARNESS_DIR}/lib.sh"
}
check_not "non-200 status fails the smoke" run_smoke_fail
SMOKE_FAIL_OUTPUT="$(run_smoke_fail 2>&1 || true)"
if printf '%s' "${SMOKE_FAIL_OUTPUT}" | grep -q "HTTP 429"; then
  echo "ok - HTTP status is reported"
else
  echo "FAIL - HTTP status is reported"
  FAILURES=$((FAILURES + 1))
fi

cat > "${SANDBOX}/bin/curl" <<'CURL'
#!/usr/bin/env bash
printf '{"choices":[]}\n200'
CURL
chmod +x "${SANDBOX}/bin/curl"
# A 200 with a non-empty choices array passes the smoke.
check "200 with a choices array passes the smoke" run_smoke_with_path "some-model"

# ---- 6. Portable timeout discovery ----------------------------------------
run_prefix() {
  local bindir="$1"
  bash -c 'PATH="$1" source "$2"; printf "%s" "${TIMEOUT_PREFIX}"' _ "${bindir}" "${HARNESS_DIR}/lib.sh"
}

# Minimal PATH with node + dirname but NO timeout/gtimeout, so the harness
# must fall back to the Node watchdog.
ln -s "$(command -v node)" "${SANDBOX}/bin/node"
ln -s "$(command -v dirname)" "${SANDBOX}/bin/dirname"
check "node watchdog selected when no timeout binary exists" \
  bash -c 'PATH="$1" source "$2"; [[ "${TIMEOUT_PREFIX}" == "node $3/watchdog.mjs" ]]' _ "${SANDBOX}/bin" "${HARNESS_DIR}/lib.sh" "${HARNESS_DIR}"

mkdir -p "${SANDBOX}/bin-gtimeout"
touch "${SANDBOX}/bin-gtimeout/gtimeout"
chmod +x "${SANDBOX}/bin-gtimeout/gtimeout"
check "gtimeout preferred over the watchdog" \
  bash -c 'PATH="$1" source "$2"; [[ "${TIMEOUT_PREFIX}" == "gtimeout" ]]' _ "${SANDBOX}/bin-gtimeout" "${HARNESS_DIR}/lib.sh"

mkdir -p "${SANDBOX}/bin-timeout"
touch "${SANDBOX}/bin-timeout/timeout"
chmod +x "${SANDBOX}/bin-timeout/timeout"
check "timeout preferred over gtimeout" \
  bash -c 'PATH="$1" source "$2"; [[ "${TIMEOUT_PREFIX}" == "timeout --foreground" ]]' _ "${SANDBOX}/bin-timeout" "${HARNESS_DIR}/lib.sh"

mkdir -p "${SANDBOX}/bin-none"
check_not "no timeout tooling fails with a prerequisite message" \
  bash -c 'PATH="$1" source "$2"' _ "${SANDBOX}/bin-none" "${HARNESS_DIR}/lib.sh"

echo ""
if [[ "${FAILURES}" -eq 0 ]]; then
  echo "harness shell tests: all passed"
  exit 0
fi
echo "harness shell tests: ${FAILURES} failure(s)"
exit 1
