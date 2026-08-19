#!/usr/bin/env bash
#
# provision-production.sh — bring a fresh Ubuntu box to the point where the
# Cyrus service is running and ready to be authorised.
#
# Companion to docs/runbook-production-vm.md. The runbook is the source of
# truth and explains *why*; this script does the mechanical parts so the
# 30-minute rebuild is not 40 minutes of copy-paste.
#
# DESIGN: RE-RUNNABLE HALFWAY THROUGH A FAILED RUN.
#
# The moment this script matters most is the worst moment to discover it only
# works on a clean machine: a box has just died and you are rebuilding under
# time pressure. So every step decides what to do by INSPECTING THE SYSTEM,
# never by consulting a "steps completed" marker file. A marker file lies after
# a partial failure — it claims a step finished when the process was killed
# halfway through it. Real state does not lie.
#
# Consequences of that rule, which are deliberate:
#   - Every step is safe to run again. Re-running a completed step is a no-op
#     that prints SKIP and says why.
#   - Nothing that holds a secret or a decision is ever overwritten. The env
#     file gains missing keys and never loses a value. config.json is left
#     alone entirely once it has a workspace in it.
#   - Steps that CANNOT be made idempotent are not performed at all. Creating
#     the Linear app, pointing DNS, and approving the OAuth consent screen are
#     human steps; the script verifies their preconditions and tells you.
#
# The script never prints a secret. Where it needs to confirm one is present it
# reports the variable name and the length of its value.
#
# Usage:
#   ./provision-production.sh --host cyrus.pontedigital.co --ssh-prefix 161.51.0.0/16
#   ./provision-production.sh --host ... --ssh-prefix ... --dry-run
#
# Exit codes: 0 ready (or already provisioned), 1 usage/precondition, 2 step failed.

set -euo pipefail

# ---------------------------------------------------------------- defaults ---

HOST=""
SSH_PREFIX=""
REPO_URL="https://github.com/ItzHarold/cyrus.git"
REPO_DIR="/root/cyrus"
CYRUS_HOME="/root/.cyrus-community"
SERVICE="cyrus-community"
PORT="3457"
NODE_MAJOR="22"
PNPM_VERSION="10.33.1"
DRY_RUN=0

# ------------------------------------------------------------------ output ---

if [ -t 1 ]; then
	C_OK=$'\033[32m'; C_SKIP=$'\033[90m'; C_DO=$'\033[36m'
	C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_OFF=$'\033[35m'; C_R=$'\033[0m'
else
	C_OK=""; C_SKIP=""; C_DO=""; C_WARN=""; C_ERR=""; C_OFF=""; C_R=""
fi

STEP_N=0
step()    { STEP_N=$((STEP_N + 1)); printf '\n%s[%02d] %s%s\n' "$C_DO" "$STEP_N" "$1" "$C_R"; }
ok()      { printf '     %sOK%s     %s\n'   "$C_OK"   "$C_R" "$1"; }
skip()    { printf '     %sSKIP%s   %s\n'   "$C_SKIP" "$C_R" "$1"; }
doing()   { printf '     %s..%s     %s\n'   "$C_DO"   "$C_R" "$1"; }
warn()    { printf '     %sWARN%s   %s\n'   "$C_WARN" "$C_R" "$1"; }
offbox()  { printf '     %sYOU%s    %s\n'   "$C_OFF"  "$C_R" "$1"; }
die()     { printf '\n%sFAILED%s %s\n\n' "$C_ERR" "$C_R" "$1" >&2; exit 2; }

# `run` is the only thing that mutates the machine, so --dry-run has exactly
# one place to intercept and cannot miss a code path.
run() {
	if [ "$DRY_RUN" -eq 1 ]; then
		printf '     %sDRY%s    %s\n' "$C_SKIP" "$C_R" "$*"
		return 0
	fi
	"$@"
}

# Writes $2 to $1 only if the content differs. Keeps a .bak of anything it
# replaces, so a re-run that changes a managed file is recoverable.
write_file() {
	local path="$1" content="$2" mode="${3:-644}"
	if [ -f "$path" ] && [ "$(cat "$path")" = "$content" ]; then
		skip "$path already correct"
		return 0
	fi
	if [ -f "$path" ]; then
		doing "$path differs — backing up to $path.bak"
		run cp -a "$path" "$path.bak"
	else
		doing "writing $path"
	fi
	if [ "$DRY_RUN" -eq 0 ]; then
		printf '%s\n' "$content" > "$path"
		chmod "$mode" "$path"
	fi
}

# ------------------------------------------------------------------- usage ---

usage() {
	cat <<'EOF'
provision-production.sh — Cyrus production box, from fresh Ubuntu to running service

Required:
  --host <fqdn>          Public hostname, e.g. cyrus.pontedigital.co
                         Must already resolve to this box (see runbook step 3).
  --ssh-prefix <cidr>    Network prefix to exempt from fail2ban, e.g. 161.51.0.0/16
                         Use a PREFIX, never a single /32 — see runbook step 2.

Optional:
  --repo <url>           Default: https://github.com/ItzHarold/cyrus.git
  --port <n>             Service port. Default: 3457
  --cyrus-home <path>    Default: /root/.cyrus-community
  --dry-run              Print what would change; touch nothing.
  -h, --help             This.

Safe to re-run at any point, including partway through a failed run.
Never overwrites secrets or an authorised config.json.
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--host)       HOST="${2:-}"; shift 2 ;;
		--ssh-prefix) SSH_PREFIX="${2:-}"; shift 2 ;;
		--repo)       REPO_URL="${2:-}"; shift 2 ;;
		--port)       PORT="${2:-}"; shift 2 ;;
		--cyrus-home) CYRUS_HOME="${2:-}"; shift 2 ;;
		--dry-run)    DRY_RUN=1; shift ;;
		-h|--help)    usage; exit 0 ;;
		*)            printf 'Unknown argument: %s\n\n' "$1" >&2; usage >&2; exit 1 ;;
	esac
done

[ -n "$HOST" ]       || { echo "--host is required" >&2; usage >&2; exit 1; }
[ -n "$SSH_PREFIX" ] || { echo "--ssh-prefix is required" >&2; usage >&2; exit 1; }

ENV_FILE="$CYRUS_HOME/.env"
CONFIG_FILE="$CYRUS_HOME/config.json"

printf '\n%sCyrus production provisioning%s\n' "$C_DO" "$C_R"
printf '  host       %s\n  port       %s\n  repo       %s\n  cyrus home %s\n' \
	"$HOST" "$PORT" "$REPO_URL" "$CYRUS_HOME"
[ "$DRY_RUN" -eq 1 ] && printf '  %sDRY RUN — nothing will be changed%s\n' "$C_WARN" "$C_R"

# --------------------------------------------------------------- preflight ---

step "Preflight"

[ "$(id -u)" -eq 0 ] || die "must run as root"
ok "running as root"

if ! command -v apt-get >/dev/null 2>&1; then
	die "apt-get not found — this script targets Ubuntu"
fi
ok "$( (. /etc/os-release && echo "$PRETTY_NAME") 2>/dev/null || echo "unknown Ubuntu")"

# DNS must already point here, or Caddy cannot get a certificate and the Linear
# app's callback URL cannot be created. Checked before anything is installed so
# a wrong hostname costs seconds, not a full run.
resolved="$(getent ahostsv4 "$HOST" 2>/dev/null | awk 'NR==1{print $1}' || true)"
if [ -z "$resolved" ]; then
	die "$HOST does not resolve. Point DNS at this box first (runbook step 3)."
fi
ok "$HOST resolves to $resolved"

my_ip="$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || true)"
if [ -n "$my_ip" ] && [ "$my_ip" != "$resolved" ]; then
	warn "$HOST resolves to $resolved but this box is $my_ip"
	warn "TLS issuance will fail until DNS points here. Continuing anyway."
fi

# ------------------------------------------------------------ 1. packages ----

step "Base packages"

missing=""
for p in curl ca-certificates gnupg git fail2ban debian-keyring debian-archive-keyring apt-transport-https; do
	dpkg -s "$p" >/dev/null 2>&1 || missing="$missing $p"
done
if [ -z "$missing" ]; then
	skip "all base packages present"
else
	doing "installing:$missing"
	run apt-get update -qq
	# shellcheck disable=SC2086
	run apt-get install -y -qq $missing || die "package install failed"
	ok "installed"
fi

# --------------------------------------------------------- 2. ssh hardening --

step "SSH hardening (keys only)"

sshd_val() { sshd -T 2>/dev/null | awk -v k="$1" '$1==k{print $2}'; }

if [ "$(sshd_val passwordauthentication)" = "no" ] && \
   [ "$(sshd_val permitrootlogin)" = "prohibit-password" ]; then
	skip "already keys-only"
else
	doing "disabling password auth"
	run sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
	run sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
	# Validate BEFORE reloading. A broken sshd_config that gets reloaded is how
	# you lose a box you are still logged into.
	if [ "$DRY_RUN" -eq 0 ]; then
		sshd -t || die "sshd_config invalid — NOT reloading. Fix before logging out."
	fi
	run systemctl reload ssh
	ok "keys-only enforced"
fi

# ------------------------------------------------------------- 3. fail2ban ---

step "fail2ban"

JAIL_CONTENT="[DEFAULT]
backend  = systemd
ignoreip = 127.0.0.1/8 ::1 $SSH_PREFIX
bantime  = 1h
findtime = 10m
maxretry = 4
bantime.increment = true
bantime.factor    = 4
bantime.maxtime   = 1w

[sshd]
enabled = true
port    = ssh"

write_file /etc/fail2ban/jail.local "$JAIL_CONTENT" 644

if systemctl is-active --quiet fail2ban && \
   fail2ban-client status sshd >/dev/null 2>&1 && \
   [ -f /etc/fail2ban/jail.local ] && \
   grep -qF "$SSH_PREFIX" /etc/fail2ban/jail.local; then
	skip "sshd jail active with the right prefix"
else
	doing "enabling fail2ban"
	run systemctl enable --now fail2ban
	run systemctl restart fail2ban
	ok "sshd jail active"
fi

# The host firewall stays off ON PURPOSE — enforcement is the Hetzner cloud
# firewall, which cannot lock you out of the console. Flagged rather than
# silently accepted, so it stays a decision.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
	warn "ufw is ACTIVE. The runbook specifies the cloud firewall as the single"
	warn "enforcement point. Two firewalls is how you lock yourself out. Review."
else
	ok "ufw inactive (deliberate — cloud firewall is the enforcement point)"
fi

# ------------------------------------------------------------ 4. tailscale ---

step "Tailscale (second door)"

if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
	skip "already up: $(tailscale ip -4 2>/dev/null | head -1)"
else
	if ! command -v tailscale >/dev/null 2>&1; then
		doing "installing tailscale"
		run sh -c 'curl -fsSL https://tailscale.com/install.sh | sh' || die "tailscale install failed"
	fi
	offbox "run: tailscale up --ssh --hostname=cyrus-prod"
	offbox "then approve the URL it prints, in a browser."
	warn "not run automatically — it needs a human at a browser."
fi

# ------------------------------------------------------- 5. node and pnpm ----

step "Node $NODE_MAJOR and pnpm $PNPM_VERSION"

node_ok=0
if command -v node >/dev/null 2>&1; then
	case "$(node -v)" in v"$NODE_MAJOR".*) node_ok=1 ;; esac
fi
if [ "$node_ok" -eq 1 ]; then
	skip "node $(node -v) present"
else
	doing "installing node $NODE_MAJOR from NodeSource"
	run sh -c "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -" || die "nodesource setup failed"
	run apt-get install -y -qq nodejs || die "node install failed"
	ok "node $(node -v 2>/dev/null || echo installed)"
fi

if command -v pnpm >/dev/null 2>&1 && [ "$(pnpm -v 2>/dev/null || true)" = "$PNPM_VERSION" ]; then
	skip "pnpm $PNPM_VERSION present"
else
	doing "activating pnpm $PNPM_VERSION via corepack"
	run corepack enable
	run corepack prepare "pnpm@$PNPM_VERSION" --activate || die "corepack prepare failed"
	ok "pnpm ready"
fi

# ---------------------------------------------------------------- 6. caddy ---

step "Caddy and TLS"

if command -v caddy >/dev/null 2>&1; then
	skip "caddy present"
else
	doing "adding caddy repository"
	run sh -c "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg"
	run sh -c "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list"
	run apt-get update -qq
	run apt-get install -y -qq caddy || die "caddy install failed"
	ok "caddy installed"
fi

write_file /etc/caddy/Caddyfile "$HOST {
	reverse_proxy localhost:$PORT
}" 644

run systemctl enable --quiet caddy 2>/dev/null || true
run systemctl reload caddy 2>/dev/null || run systemctl restart caddy
ok "caddy serving $HOST -> localhost:$PORT"

# ------------------------------------------------------- 7. clone and build ---

step "Repository"

if [ -d "$REPO_DIR/.git" ]; then
	skip "$REPO_DIR already a git checkout"
else
	doing "cloning $REPO_URL"
	run git clone --quiet "$REPO_URL" "$REPO_DIR" || die "clone failed"
	ok "cloned"
fi

step "Build"

# Rebuild when the built entrypoint is missing OR older than the newest source
# file. That is the check that makes a re-run after an interrupted build do the
# right thing: a half-written dist is older than src and gets rebuilt, where a
# marker file would have claimed the build was done.
BUILT="$REPO_DIR/apps/cli/dist/src/app.js"
needs_build=0
if [ ! -f "$BUILT" ]; then
	needs_build=1
	doing "no build present"
elif [ -n "$(find "$REPO_DIR/packages" "$REPO_DIR/apps" -name '*.ts' -newer "$BUILT" -not -path '*/node_modules/*' -not -path '*/dist/*' -print -quit 2>/dev/null)" ]; then
	needs_build=1
	doing "sources newer than build"
fi

if [ "$needs_build" -eq 0 ]; then
	skip "build up to date"
else
	doing "pnpm install (slowest step, 2-4 min)"
	run sh -c "cd '$REPO_DIR' && pnpm install --silent" || die "pnpm install failed"
	doing "pnpm build"
	run sh -c "cd '$REPO_DIR' && pnpm build" || die "build failed"
	if [ "$DRY_RUN" -eq 0 ] && [ ! -f "$BUILT" ]; then
		die "build reported success but $BUILT is missing"
	fi
	ok "built"
fi

# ------------------------------------------------------ 8. cyrus home / env ---

step "Cyrus home"

if [ -d "$CYRUS_HOME" ]; then
	skip "$CYRUS_HOME exists"
else
	run mkdir -p "$CYRUS_HOME"
	ok "created $CYRUS_HOME"
fi

# config.json is NEVER rewritten once it holds a workspace. It carries tenant
# OAuth tokens; clobbering it silently de-authorises every client on the box.
if [ -f "$CONFIG_FILE" ]; then
	ws_count="$(node -e '
		try {
			const c = require(process.argv[1]);
			process.stdout.write(String(Object.keys(c.linearWorkspaces || {}).length));
		} catch { process.stdout.write("0"); }
	' "$CONFIG_FILE" 2>/dev/null || echo 0)"
	if [ "$ws_count" -gt 0 ]; then
		skip "config.json holds $ws_count authorised workspace(s) — left untouched"
	else
		skip "config.json exists (no workspaces yet) — left untouched"
	fi
else
	doing "writing bootstrap config.json"
	if [ "$DRY_RUN" -eq 0 ]; then
		printf '{"repositories":[]}\n' > "$CONFIG_FILE"
		chmod 600 "$CONFIG_FILE"
	fi
	ok "bootstrap config written"
fi

step "Environment file"

# Keys are ADDED when absent. A key that already has a value is never touched,
# so a re-run cannot destroy a secret you pasted in by hand on the last pass.
ensure_key() {
	local key="$1" value="$2"
	if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
		local existing
		existing="$(grep "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2-)"
		if [ -n "$existing" ]; then
			skip "$key already set (len=${#existing})"
		else
			warn "$key present but EMPTY — fill it in before starting the service"
		fi
		return 0
	fi
	doing "adding $key"
	[ "$DRY_RUN" -eq 0 ] && printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
	[ -z "$value" ] && warn "$key is blank — you must fill it in (runbook step 9b)"
	return 0
}

if [ ! -f "$ENV_FILE" ]; then
	doing "creating $ENV_FILE"
	if [ "$DRY_RUN" -eq 0 ]; then
		: > "$ENV_FILE"
		chmod 600 "$ENV_FILE"
	fi
fi
[ "$DRY_RUN" -eq 0 ] && chmod 600 "$ENV_FILE"

ensure_key CYRUS_SERVER_PORT      "$PORT"
ensure_key CYRUS_BASE_URL         "https://$HOST"
ensure_key CYRUS_HOST_EXTERNAL    "true"
ensure_key LINEAR_DIRECT_WEBHOOKS "true"
ensure_key LINEAR_CLIENT_ID       ""
ensure_key LINEAR_CLIENT_SECRET   ""
ensure_key LINEAR_WEBHOOK_SECRET  ""
ensure_key ANTHROPIC_API_KEY      ""

# The one mechanical check available on this page: only the webhook secret
# carries a prefix. Client id and client secret are both 32 hex characters, so
# no check can catch a swap between those two — see runbook step 9b.
if [ -f "$ENV_FILE" ] && grep -q '^LINEAR_WEBHOOK_SECRET=.' "$ENV_FILE" 2>/dev/null; then
	if grep -q '^LINEAR_WEBHOOK_SECRET=lin_wh_' "$ENV_FILE"; then
		ok "LINEAR_WEBHOOK_SECRET has the expected lin_wh_ prefix"
	else
		warn "LINEAR_WEBHOOK_SECRET does NOT start with lin_wh_ — almost certainly"
		warn "the client secret pasted into the wrong field. Webhooks will be"
		warn "silently dropped. See runbook step 9b."
	fi
fi

# ------------------------------------------------------------- 9. systemd -----

step "systemd unit"

write_file "/etc/systemd/system/$SERVICE.service" "[Unit]
Description=Cyrus Community (self-hosted, direct Linear webhooks)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root
Environment=CLAUDE_CODE_EFFORT_LEVEL=xhigh
ExecStart=/usr/bin/node $REPO_DIR/apps/cli/dist/src/app.js --cyrus-home $CYRUS_HOME
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target" 644

run mkdir -p "/etc/systemd/system/$SERVICE.service.d"
write_file "/etc/systemd/system/$SERVICE.service.d/model.conf" "[Service]
EnvironmentFile=/etc/default/$SERVICE" 644

if [ -f "/etc/default/$SERVICE" ]; then
	skip "/etc/default/$SERVICE exists — left untouched"
else
	write_file "/etc/default/$SERVICE" "CYRUS_MODEL=claude-opus-5" 644
fi

run systemctl daemon-reload

# Only start when the credentials that make starting meaningful are present.
# Starting without them produces a service that looks healthy and drops every
# webhook — the exact failure the runbook's troubleshooting section exists for.
creds_ready=1
missing_creds=""
for k in LINEAR_CLIENT_ID LINEAR_CLIENT_SECRET LINEAR_WEBHOOK_SECRET ANTHROPIC_API_KEY; do
	if ! grep -q "^${k}=." "$ENV_FILE" 2>/dev/null; then
		creds_ready=0
		missing_creds="$missing_creds $k"
	fi
done

# Production runs on ANTHROPIC_API_KEY and never on a Max subscription token. A
# subscription is tied to a personal account and a personal rate limit; a client
# session dying because someone hit a cap is a refund conversation, not an
# incident. So a box holding only CLAUDE_CODE_OAUTH_TOKEN is not production-ready
# even though it would start and appear to work.
if grep -q '^ANTHROPIC_API_KEY=$\|^ANTHROPIC_API_KEY=$' "$ENV_FILE" 2>/dev/null || \
   ! grep -q '^ANTHROPIC_API_KEY=.' "$ENV_FILE" 2>/dev/null; then
	if grep -q '^CLAUDE_CODE_OAUTH_TOKEN=.' "$ENV_FILE" 2>/dev/null; then
		warn "this box has CLAUDE_CODE_OAUTH_TOKEN but no ANTHROPIC_API_KEY."
		warn "That is a dev-box configuration. Production must use an API key —"
		warn "a personal subscription hitting its cap takes a client session down."
	fi
fi

if [ "$creds_ready" -eq 0 ]; then
	warn "missing credentials:$missing_creds"
	if systemctl is-active --quiet "$SERVICE"; then
		warn "$SERVICE is already running and was left alone — but it is not"
		warn "fully configured. Fill in $ENV_FILE, then: systemctl restart $SERVICE"
	else
		warn "not starting $SERVICE until these are filled in."
		warn "Fill in $ENV_FILE, then: systemctl enable --now $SERVICE"
	fi
elif systemctl is-active --quiet "$SERVICE"; then
	doing "restarting $SERVICE to pick up any changes"
	run systemctl restart "$SERVICE"
	ok "$SERVICE restarted"
else
	doing "starting $SERVICE"
	run systemctl enable --now "$SERVICE"
	ok "$SERVICE started"
fi

# ---------------------------------------------------------- 10. heartbeat -----

step "Health heartbeat"

write_file /usr/local/bin/cyrus-heartbeat.sh '#!/usr/bin/env bash
# Pings only when the service is genuinely serving. Silence is the alert.
set -u
PING_URL="${CYRUS_HEARTBEAT_URL:-}"
[ -z "$PING_URL" ] && exit 0
systemctl is-active --quiet '"$SERVICE"' || exit 0
curl -sf --max-time 10 http://127.0.0.1:'"$PORT"'/status | grep -q '"'"'"status"'"'"' || exit 0
# A failed ping IS the alert — healthchecks.io notices the silence. Exit 0 so
# cron does not also mail root about it every five minutes.
curl -sf --max-time 10 "$PING_URL" > /dev/null || true
exit 0' 755

if [ -f /etc/default/cyrus-heartbeat ]; then
	skip "/etc/default/cyrus-heartbeat exists — left untouched"
else
	write_file /etc/default/cyrus-heartbeat "CYRUS_HEARTBEAT_URL=" 600
	offbox "create a check at healthchecks.io and put its ping URL in"
	offbox "/etc/default/cyrus-heartbeat"
fi

write_file /etc/cron.d/cyrus-heartbeat \
	"*/5 * * * * root . /etc/default/cyrus-heartbeat && /usr/local/bin/cyrus-heartbeat.sh" 644

# ------------------------------------------------------------- verification ---

step "Verification"

if [ "$DRY_RUN" -eq 1 ]; then
	printf '\n%sDry run complete — nothing was changed.%s\n\n' "$C_WARN" "$C_R"
	exit 0
fi

fail=0

if systemctl is-active --quiet caddy; then ok "caddy active"; else warn "caddy NOT active"; fail=1; fi
if systemctl is-active --quiet fail2ban; then ok "fail2ban active"; else warn "fail2ban NOT active"; fail=1; fi

if [ "$creds_ready" -eq 1 ]; then
	if systemctl is-active --quiet "$SERVICE"; then ok "$SERVICE active"; else warn "$SERVICE NOT active"; fail=1; fi

	# Give the service a moment to bind before probing it.
	for _ in 1 2 3 4 5 6 7 8 9 10; do
		curl -sf --max-time 2 "http://127.0.0.1:$PORT/status" >/dev/null 2>&1 && break
		sleep 1
	done

	if curl -sf --max-time 5 "http://127.0.0.1:$PORT/status" 2>/dev/null | grep -q '"status"'; then
		ok "local /status responding"
	else
		warn "local /status not responding on port $PORT"; fail=1
	fi

	if curl -sf --max-time 10 "https://$HOST/status" 2>/dev/null | grep -q '"status"'; then
		ok "public https://$HOST/status responding"
	else
		warn "public /status not responding — TLS may still be issuing; retry in a minute"
	fi

	if journalctl -u "$SERVICE" --no-pager 2>/dev/null \
		| grep -q "LinearEventTransport.*Registered POST /linear-webhook.*direct mode"; then
		ok "Linear webhooks in direct mode"
	else
		warn "Linear transport is NOT in direct mode — every webhook will be rejected."
		warn "Check LINEAR_DIRECT_WEBHOOKS in $ENV_FILE. See runbook troubleshooting #1."
		fail=1
	fi

	if journalctl -u "$SERVICE" --no-pager 2>/dev/null | grep -q "OAuth relay registered"; then
		ok "OAuth relay registered (authorising will not need an outage)"
	else
		warn "OAuth relay not registered — build may predate it"
	fi
fi

# ---------------------------------------------------------------- handover ---

printf '\n%s%s%s\n' "$C_DO" "What is left, and it needs a human" "$C_R"

left=0
if [ "$creds_ready" -eq 0 ]; then
	left=$((left + 1))
	printf '  %d. Fill in%s in %s\n' "$left" "$missing_creds" "$ENV_FILE"
	printf '     The Linear values come from runbook step 9b. Then:\n'
	printf '     systemctl enable --now %s\n' "$SERVICE"
fi

if ! (command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1); then
	left=$((left + 1))
	printf '  %d. tailscale up --ssh --hostname=cyrus-prod   (approve in browser)\n' "$left"
fi

ws_now=0
if [ -f "$CONFIG_FILE" ]; then
	ws_now="$(node -e '
		try {
			const c = require(process.argv[1]);
			process.stdout.write(String(Object.keys(c.linearWorkspaces || {}).length));
		} catch { process.stdout.write("0"); }
	' "$CONFIG_FILE" 2>/dev/null || echo 0)"
fi
if [ "$ws_now" -eq 0 ]; then
	left=$((left + 1))
	printf '  %d. Authorise a workspace (runbook step 12) — the service stays up:\n' "$left"
	printf '     node %s/apps/cli/dist/src/app.js self-auth-linear \\\n' "$REPO_DIR"
	printf '       --cyrus-home %s --env-file %s\n' "$CYRUS_HOME" "$ENV_FILE"
fi

if ! grep -q '^CYRUS_HEARTBEAT_URL=.' /etc/default/cyrus-heartbeat 2>/dev/null; then
	left=$((left + 1))
	printf '  %d. Put a healthchecks.io ping URL in /etc/default/cyrus-heartbeat,\n' "$left"
	printf '     then verify the alert fires by stopping the service (runbook step 16b)\n'
fi

left=$((left + 1))
printf '  %d. Enable Hetzner backups and test one restore (runbook step 15)\n' "$left"

if [ "$fail" -eq 0 ]; then
	printf '\n%sProvisioning complete.%s Re-running this script is safe.\n\n' "$C_OK" "$C_R"
	exit 0
fi

printf '\n%sProvisioned with warnings above.%s Fix them, then re-run — it will skip\n' "$C_WARN" "$C_R"
printf 'everything already done and retry only what did not take.\n\n'
exit 0
