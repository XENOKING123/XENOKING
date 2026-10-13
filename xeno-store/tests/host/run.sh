#!/usr/bin/env bash
# run.sh — builds the host binary and runs the host test suites in isolated
# temp directories (each module spawns its own xeno-store instances on random
# ports with a temp data dir and temp roots):
#   test_api.py            endpoints, settings, storage, library, security
#   test_downloads.py      the download engine (segments, resume, failover …)
#   test_ext_downloads.py  Phase 2 engine: turbo, best version, stats, schedule,
#                          install sets, debrid, rest mode, copy/move, zip extraction
#   test_ext_console.py    Phase 2 console features (skipped with a message when absent)
# Prints a summary and exits non-zero when anything failed.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(cd "$HERE/../.." && pwd)"
cd "$PROJECT"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  make host >/dev/null || { echo "run.sh: host build failed"; exit 1; }
fi
export XENO_BIN="${XENO_BIN:-$PROJECT/build/host/xeno-store}"
[ -x "$XENO_BIN" ] || { echo "run.sh: $XENO_BIN missing"; exit 1; }

TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/xeno-tests.XXXXXX")"
export TMPDIR="$TMPBASE"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy

# XENO_TESTS="test_api.py test_downloads.py" narrows the run.
SUITES="${XENO_TESTS:-test_api.py test_downloads.py test_ext_downloads.py test_ext_console.py}"

status=0
summary=()
for t in $SUITES; do
  if [ ! -f "$HERE/$t" ]; then
    echo "=================== $t ==================="
    echo "skipped: $HERE/$t is not present"
    summary+=("SKIP  $t  (file not present)")
    continue
  fi
  echo "=================== $t ==================="
  start=$(date +%s)
  python3 -I "$HERE/$t" -v > "$TMPBASE/$t.log" 2>&1
  rc=$?
  grep -E "^(test_|Ran |OK|FAILED|ERROR|FAIL:|ERROR:)" "$TMPBASE/$t.log"
  secs=$(( $(date +%s) - start ))
  ran=$(grep -E "^Ran [0-9]+ tests?" "$TMPBASE/$t.log" | tail -1)
  if [ "$rc" -eq 0 ]; then
    summary+=("PASS  $t  ($ran, ${secs}s)")
  else
    status=1
    summary+=("FAIL  $t  ($ran, ${secs}s) — see $TMPBASE/$t.log")
    grep -E "^(FAIL|ERROR):|AssertionError|Error" "$TMPBASE/$t.log" | head -20
  fi
done

echo
echo "=================== summary ==================="
for line in "${summary[@]}"; do echo "$line"; done
if [ "$status" -eq 0 ]; then
  echo "ALL GREEN"
  rm -rf "$TMPBASE"
else
  echo "FAILURES — logs kept in $TMPBASE"
fi
exit $status
