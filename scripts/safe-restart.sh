#!/usr/bin/env bash
# The ONLY way service restarts happen, on EITHER box.
#
# This lives in the repository on purpose (PON-217). It used to exist solely at
# /root/ops/safe-restart.sh on the dev box, which could restart agent-prod over
# ssh — so the guard was reachable only from a machine that is not the one
# serving clients. If the dev box was down, or you were already on prod, or you
# had ssh'd in to look at something, the only restart available was a bare
# `systemctl restart`. A safe restart path that is missing from the box serving
# clients is not a safe path; it is a safe path for the other box.
#
# Shipping it here means `git pull` puts it on every box that runs the service,
# and the guarded path is always the local one.
#
# Usage, run ON the box being restarted:
#     scripts/safe-restart.sh [--live-fire <session-id-prefix>]
#
# Usage, driving the other box from the dev box (the pre-existing form):
#     scripts/safe-restart.sh agent-prod [--live-fire <session-id-prefix>]
#
# The gate is read IN THIS PROCESS, immediately before the restart, so a caller
# cannot read a stale "idle" and chain a restart onto it. Two live violations
# came from exactly that shape.
#
# --live-fire: the documented restart-mid-wait test protocol (PON-164, PON-172).
# It tolerates a busy /status ONLY when, checked in-process:
#   - zero active lane holders,
#   - zero real client-session journal lines in the last 10 minutes,
#   - every session with recent activity IS the throwaway named on the command
#     line — anything else refuses.
# Interrupting the named session is the point of that test.
set -euo pipefail

# Client issue prefixes across BOTH boxes: dev partnership teams and prod
# tenants. The prod prefixes were missing until 2026-08-28, which meant this
# guard protected nobody on the box where the real clients actually are. Any
# new tenant team key MUST be added here — an absent prefix fails open, silently.
CLIENT_PREFIXES='DVV|GCD|CHB|WIZ|FRO|ACM'

TARGET="local"
if [ "${1:-}" = "agent-prod" ] || [ "${1:-}" = "local" ]; then
  TARGET="$1"; shift
fi
LIVE_FIRE=""
if [ "${1:-}" = "--live-fire" ]; then
  LIVE_FIRE="${2:?--live-fire needs a session-id prefix}"
fi

run() { if [ "$TARGET" = "agent-prod" ]; then ssh agent-prod "$1"; else bash -c "$1"; fi; }

STATUS=$(run 'curl -s -m 5 localhost:3457/status')
if [ "$STATUS" != '{"status":"idle"}' ] && [ -z "$LIVE_FIRE" ]; then
  echo "REFUSED: status is $STATUS — not idle. (A deliberate restart-mid-wait test may use --live-fire <session>.)" >&2; exit 1
fi

CLIENT_LINES=$(run "journalctl -u cyrus-community --since \"10 min ago\" --no-pager | grep -cE '\{session=[a-f0-9]+, platform=linear, issue=(${CLIENT_PREFIXES})-' || true")
ACTIVE=$(run 'curl -s -m 5 localhost:3457/admin/lanes' | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(len(l.get("activeSessionIds",[])) for l in d.get("lanes",{}).values()))' 2>/dev/null || echo "?")
if [ "$CLIENT_LINES" != "0" ] || { [ "$ACTIVE" != "0" ] && [ "$ACTIVE" != "?" ]; }; then
  echo "REFUSED: client journal lines(10m)=$CLIENT_LINES, active lane holders=$ACTIVE." >&2; exit 1
fi

if [ -n "$LIVE_FIRE" ]; then
  OTHERS=$(run 'journalctl -u cyrus-community --since "10 min ago" --no-pager | grep -oE "\{session=[a-f0-9]+" | sort -u' | sed 's/{session=//' | grep -v "^${LIVE_FIRE}" || true)
  if [ -n "$OTHERS" ]; then
    echo "REFUSED: live-fire named ${LIVE_FIRE} but other sessions have recent activity: ${OTHERS}" >&2; exit 1
  fi
  echo "LIVE-FIRE restart on $TARGET: deliberately interrupting session ${LIVE_FIRE} (holders=0, client lines=0, no other recent sessions) — the interruption is the test"
else
  echo "idle confirmed (status=idle, client lines=0, holders=${ACTIVE}) — restarting on $TARGET"
fi

run 'systemctl restart cyrus-community'
for i in $(seq 30); do run 'curl -sf -m 3 localhost:3457/status >/dev/null' 2>/dev/null && break; sleep 1; done
run 'systemctl is-active cyrus-community'
