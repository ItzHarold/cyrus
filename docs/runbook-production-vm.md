# Runbook — production VM, from zero to first webhook

This is written to be followed at 2am with the box gone and nothing memorised.
Every command is exact. Every step says what it should print. Where you have to
leave the box — Hetzner console, DNS, Linear — the step is marked **OFF-BOX** and
says exactly what to paste where.

Target: **serving a real webhook in under 30 minutes.**

Read [Before you start](#before-you-start) first. Then work top to bottom without
skipping — several steps depend on an earlier one having already propagated.

---

## Contents

| # | Step | Where | ~Time |
|---|------|-------|-------|
| 0 | [Before you start](#before-you-start) | — | 2 min |
| 1 | [Create the VM](#1-create-the-vm-off-box) | **OFF-BOX** Hetzner | 3 min |
| 2 | [Cloud firewall](#2-cloud-firewall-off-box) | **OFF-BOX** Hetzner | 3 min |
| 3 | [DNS](#3-dns-off-box) | **OFF-BOX** registrar | 2 min |
| 4 | [First login, SSH hardening, fail2ban](#4-first-login-ssh-hardening-fail2ban) | box | 4 min |
| 5 | [Tailscale — the second door](#5-tailscale--the-second-door) | box | 2 min |
| 6 | [Runtime: node, pnpm, git](#6-runtime-node-pnpm-git) | box | 3 min |
| 7 | [Caddy and TLS](#7-caddy-and-tls) | box | 2 min |
| 8 | [Clone and build](#8-clone-and-build) | box | 4 min |
| 9 | [The Linear app](#9-the-linear-app-off-box--read-this-one-slowly) | **OFF-BOX** Linear | 5 min |
| 10 | [Env file](#10-env-file) | box | 3 min |
| 11 | [systemd unit](#11-systemd-unit) | box | 2 min |
| 12 | [Authorise the first workspace](#12-authorise-the-first-workspace) | box + browser | 2 min |
| 13 | [Add a repository](#13-add-a-repository) | box | 2 min |
| 14 | [Verify a webhook end to end](#14-verify-a-webhook-end-to-end) | box + Linear | 3 min |
| 15 | [Backups and a tested restore](#15-backups-and-a-tested-restore) | **OFF-BOX** Hetzner | 10 min |
| 16 | [Health checks](#16-health-checks) | box + **OFF-BOX** | 5 min |
| 17 | [The 30-minute rebuild test](#17-the-30-minute-rebuild-test) | — | 30 min |
| 18 | [Migration and the dev-box token purge](#18-migration-and-the-dev-box-token-purge) | both boxes | 10 min |
| — | [When webhooks silently don't arrive](#when-webhooks-silently-dont-arrive) | — | — |

---

## Before you start

Have these open in browser tabs before you touch a terminal. Hunting for a
credential mid-rebuild is what turns 30 minutes into 90.

- Hetzner Cloud console
- DNS registrar for `pontedigital.co`
- Linear → Settings → API → Applications
- The password manager entry holding `ANTHROPIC_API_KEY`

Decide the hostname now and use it consistently. This runbook writes it as
`cyrus.pontedigital.co`; substitute throughout if you pick another.

Two facts worth knowing before they surprise you:

- **The service listens on port 3457, not 3456.** 3456 is the upstream default
  (`apps/cli/src/config/constants.ts:8`). This deployment overrides it. If you
  leave `CYRUS_SERVER_PORT` unset, Caddy proxies to a port with nothing on it.
- **The webhook path is `/linear-webhook`.** `/webhook` still works as a
  deprecated alias but logs a warning. Use `/linear-webhook` in Linear.

### The script, and when not to use it

`scripts/provision-production.sh` does the mechanical steps — **4, 6, 7, 8, 10, 11, 16b** — so the rebuild is not 30 minutes of copy-paste:

```bash
./scripts/provision-production.sh --host cyrus.pontedigital.co --ssh-prefix 161.51.0.0/16
```

It is safe to re-run at any point, **including partway through a run that failed**. Every step decides what to do by inspecting the system rather than by consulting a "steps completed" file, because a marker file lies after a partial failure — it claims a step finished when the process was killed halfway through. It never overwrites a secret, and it will not touch a `config.json` that already holds an authorised workspace. Add `--dry-run` to see what it would change without changing anything.

What it deliberately does **not** do: create the VM, the firewall, DNS, or the Linear app, and it does not approve anything in a browser. Those are steps 1, 2, 3, 9 and 12 — none can be made idempotent, and a script that half-creates a Linear app is worse than no script. It checks their preconditions instead and prints what is left for you.

**Read the steps anyway the first time.** The script tells you *what* it did; this document tells you *why*, and the why is what you need when something does not work at 2am. If the script and this document ever disagree, the document is right and the script is a bug.

> **Ubuntu version.** PON-126 specifies Ubuntu 24. The box this runbook was
> captured from runs **Ubuntu 26.04 LTS**, so 26.04 is the version every config
> here is known to work on. The package sources below (NodeSource, Caddy,
> Tailscale) are identical for both. Pick 24.04 to match the issue, or 26.04 to
> match a box that demonstrably works — but decide deliberately, and if you pick
> 24.04, treat step 6 as the one most likely to need a version bump.

---

## 1. Create the VM (OFF-BOX)

**OFF-BOX — Hetzner Cloud console.**

New project (or the existing one) → **Add Server**:

| Field | Value |
|---|---|
| Location | Falkenstein or Nuremberg |
| Image | Ubuntu 24.04 (or 26.04 — see note above) |
| Type | **CPX31** — 4 vCPU, 8 GB RAM, 160 GB |
| Networking | Public IPv4 **on**, IPv6 on |
| SSH key | Select your existing key. **Do not** choose password auth |
| Backups | **Enable now** — ticking it here is cheaper than step 15 |
| Name | `cyrus-prod` |

The workload is network-bound — Claude sessions, git worktrees, a webhook
server. Builds and previews run on client Vercel. CPX31 is sized for
cleanliness, not compute; do not upsize reflexively.

Write down the public IPv4. You need it in steps 2, 3 and 4.

```
IPv4: ____________________
```

---

## 2. Cloud firewall (OFF-BOX)

**OFF-BOX — Hetzner Cloud console → Firewalls → Create Firewall.**

This is the enforcement point, deliberately *outside* the VM. A host firewall
that goes wrong locks you out of your own box; a cloud rule can always be edited
from the console. `ufw` stays **inactive** on the host — that is a decision, not
an oversight. Step 4 verifies it.

Inbound rules:

| Port | Protocol | Source | Why |
|---|---|---|---|
| 22 | TCP | Your ISP's **prefix**, e.g. `161.51.0.0/16` — not a single `/32` | SSH |
| 80 | TCP | `0.0.0.0/0`, `::/0` | ACME HTTP-01 challenge |
| 443 | TCP | `0.0.0.0/0`, `::/0` | Linear webhooks, OAuth callback |

> **The single-source-IP lockout, and how not to repeat it.** A `/32` of your
> current address is one DHCP lease renewal away from locking you out. Use the
> enclosing prefix. Tailscale (step 5) is the second door and does not need an
> inbound rule at all — it dials out. If you are ever locked out anyway, Hetzner
> Console → the web console is a third door that no firewall rule can close.

Apply the firewall to `cyrus-prod`. Leave outbound unrestricted.

---

## 3. DNS (OFF-BOX)

**OFF-BOX — your registrar.**

Add an `A` record:

```
cyrus.pontedigital.co.    A    <the IPv4 from step 1>    TTL 300
```

**Do this before step 7 and before step 9.** Caddy cannot get a certificate for
a name that does not resolve, and Linear will not accept a callback URL on a
host that does not exist.

Verify from your laptop, not the box:

```bash
dig +short cyrus.pontedigital.co
```

Expect: the IPv4 from step 1, and nothing else. If it is empty, wait — do not
proceed to step 7 until this answers.

---

## 4. First login, SSH hardening, fail2ban

```bash
ssh root@cyrus.pontedigital.co
```

Expect a root prompt. Everything below runs on the box.

```bash
apt-get update && apt-get -y upgrade
apt-get -y install fail2ban curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https
```

Expect: a wall of apt output ending without `E:` lines.

Keys-only SSH:

```bash
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sshd -t && systemctl reload ssh
```

Expect: **no output at all.** `sshd -t` printing anything means the config is
broken — fix it before you close this session, or you lose the box.

Confirm it took:

```bash
sshd -T | grep -E '^(passwordauthentication|permitrootlogin)'
```

Expect exactly:

```
permitrootlogin prohibit-password
passwordauthentication no
```

fail2ban. Substitute your own prefix in `ignoreip` — the same one from step 2:

```bash
cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
backend  = systemd
ignoreip = 127.0.0.1/8 ::1 YOUR.PREFIX.HERE/16
bantime  = 1h
findtime = 10m
maxretry = 4
bantime.increment = true
bantime.factor    = 4
bantime.maxtime   = 1w

[sshd]
enabled = true
port    = ssh
EOF
systemctl enable --now fail2ban
fail2ban-client status
```

Expect:

```
Status
|- Number of jail:	1
`- Jail list:	sshd
```

Confirm the host firewall is off *on purpose*:

```bash
ufw status
```

Expect: `Status: inactive`. Leave it that way. Step 2 is the enforcement point.

---

## 5. Tailscale — the second door

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --ssh --hostname=cyrus-prod
```

The command prints a URL. **Open it in a browser and approve** — this is a
browser step in the middle of a terminal step.

```bash
tailscale status
```

Expect a line for `cyrus-prod` with a `100.x.y.z` address. That address reaches
the box even if the cloud firewall's port 22 rule is wrong, which is the entire
point of doing this before anything can go wrong.

---

## 6. Runtime: node, pnpm, git

Node 22 from NodeSource — the distro package is too old:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git
node -v && npm -v
```

Expect `v22.x.x` (reference box: `v22.23.2`) and `10.x.x`.

pnpm via corepack, which pins the version the repo asks for:

```bash
corepack enable
corepack prepare pnpm@10.33.1 --activate
pnpm -v
```

Expect `10.33.1`. This must match `packageManager` in the repo's `package.json`;
if the repo has moved on, use whatever that field says instead.

---

## 7. Caddy and TLS

**DNS from step 3 must already resolve.** If `dig` was empty, go back.

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
```

```bash
cat > /etc/caddy/Caddyfile <<'EOF'
cyrus.pontedigital.co {
	reverse_proxy localhost:3457
}
EOF
systemctl reload caddy
```

Expect: no output.

```bash
curl -sI https://cyrus.pontedigital.co/status | head -1
```

Expect `HTTP/2 502` **at this point** — 502 is correct and good. Caddy has a
valid certificate (or the TLS handshake would have failed) and is proxying to
3457, where nothing is listening yet. Step 11 turns this into 200.

If instead you get a TLS error, certificate issuance failed. Check
`journalctl -u caddy -n 50` — nearly always DNS not yet propagated, or port 80
blocked in step 2.

---

## 8. Clone and build

```bash
cd /root
git clone https://github.com/ItzHarold/cyrus.git
cd /root/cyrus
pnpm install
pnpm build
```

Expect `pnpm build` to end with a run of `... build: Done` lines and no
`ELIFECYCLE`. This is the slowest step — 2 to 4 minutes.

```bash
ls /root/cyrus/apps/cli/dist/src/app.js
```

Expect the path echoed back. If it is missing, the build did not finish, whatever
it printed.

Create the config directory and a bootstrap config. `self-auth-linear` in step 12
refuses to run without one:

```bash
mkdir -p /root/.cyrus-community
echo '{"repositories":[]}' > /root/.cyrus-community/config.json
chmod 600 /root/.cyrus-community/config.json
```

---

## 9. The Linear app (OFF-BOX) — read this one slowly

**OFF-BOX — Linear → Settings → API → Applications → Create new application.**

This section is where a rebuild silently fails. The app hands you **three
different secrets**, and two of them look interchangeable and are not. Putting
the client secret where the webhook secret belongs produces a service that
starts cleanly, serves `/status` happily, and drops every webhook on the floor.

> The production app is **born here, on this box**. Never copy `LINEAR_CLIENT_ID`,
> `LINEAR_CLIENT_SECRET` or `LINEAR_WEBHOOK_SECRET` from the dev box. That
> separation is what leaves the dev box holding no tenant tokens — the third
> acceptance criterion of PON-126.

### 9a. Create the application

| Field | Value — paste exactly |
|---|---|
| Name | `Ponte Digital` |
| Developer name | `Ponte Digital` |
| Callback URL | `https://cyrus.pontedigital.co/callback` |
| Public | **Yes** |
| Webhooks | **Enabled** |
| Webhook URL | `https://cyrus.pontedigital.co/linear-webhook` |

Webhook event types to tick:

- **Agent session events** — required; this is how issues reach the agent
- **Inbox notifications** — required for assignment and mention handling
- **Issues** — required to react to title/description changes
- **Comments** — required for mid-session prompting

### 9b. Copy the three values into the table below

Fill this in before you leave the Linear tab. All three are shown **once**.

| Linear calls it | Looks like | Goes in env var |
|---|---|---|
| Client ID | 32 hex chars, no prefix | `LINEAR_CLIENT_ID` |
| Client secret | 32 hex chars, no prefix | `LINEAR_CLIENT_SECRET` |
| Webhook signing secret | `lin_wh_…`, ~51 chars | `LINEAR_WEBHOOK_SECRET` |

```
Client ID       ______________________________________
Client secret   ______________________________________
Webhook secret  ______________________________________
```

**The two that bite, and they bite differently:**

- **Client ID and client secret are both 32 hex characters.** Nothing about
  either one tells you which is which once they are out of the browser — not
  length, not shape. Label them the moment you copy them. Swapping the two
  produces a working service that fails only at step 12, with an opaque OAuth
  error and no hint about which field is wrong.
- **Only the webhook secret starts with `lin_wh_`.** That prefix is the one
  reliable discriminator on this page. If a value you are about to paste into
  `LINEAR_WEBHOOK_SECRET` does not start with `lin_wh_`, you have the wrong one,
  and the failure will look like "webhooks silently don't arrive."

### 9c. The two URLs must agree with the env file

Two independent places have to name the same host, and nothing checks that they
match:

- Linear's **Callback URL** must equal `CYRUS_BASE_URL` + `/callback`.
- Linear's **Webhook URL** must equal `CYRUS_BASE_URL` + `/linear-webhook`.

`CYRUS_BASE_URL` is set in step 10. If you change the hostname later you must
change it in **both** places or OAuth breaks, webhooks stop, or both.

---

## 10. Env file

```bash
cat > /root/.cyrus-community/.env <<'EOF'
CYRUS_SERVER_PORT=3457
CYRUS_BASE_URL=https://cyrus.pontedigital.co
CYRUS_HOST_EXTERNAL=true
LINEAR_DIRECT_WEBHOOKS=true
LINEAR_CLIENT_ID=
LINEAR_CLIENT_SECRET=
LINEAR_WEBHOOK_SECRET=
ANTHROPIC_API_KEY=
EOF
chmod 600 /root/.cyrus-community/.env
```

Now fill in the four blanks — the three from step 9b, plus the API key:

```bash
nano /root/.cyrus-community/.env
```

What each line does, so you can tell when one is wrong:

| Variable | Effect if wrong or missing |
|---|---|
| `CYRUS_SERVER_PORT=3457` | Caddy proxies to an empty port; every request 502s |
| `CYRUS_BASE_URL` | OAuth redirect goes to the wrong host; consent completes but the CLI never gets a code |
| `CYRUS_HOST_EXTERNAL=true` | Binds loopback only, and webhook IP validation stays off |
| `LINEAR_DIRECT_WEBHOOKS=true` | Webhooks verified against the proxy secret instead of Linear's — **all rejected, silently** |
| `LINEAR_WEBHOOK_SECRET` | Signature check fails on every delivery — **silent drops** |
| `ANTHROPIC_API_KEY` | Sessions start and immediately fail on the first API call |

> **Production uses `ANTHROPIC_API_KEY`, never `CLAUDE_CODE_OAUTH_TOKEN`.** A Max
> subscription token is tied to a personal account and a personal rate limit. A
> client session dying because someone's subscription hit a cap is a refund
> conversation, not an incident. The dev box may use an OAuth token; production
> does not.

Check for the mistakes that do not announce themselves — this prints only
variable names and value *lengths*, never values:

```bash
awk -F= '/^[A-Z]/ {printf "%-24s len=%s\n", $1, length($2)}' /root/.cyrus-community/.env
```

Expect roughly:

```
CYRUS_SERVER_PORT        len=4
CYRUS_BASE_URL           len=29
CYRUS_HOST_EXTERNAL      len=4
LINEAR_DIRECT_WEBHOOKS   len=4
LINEAR_CLIENT_ID         len=32
LINEAR_CLIENT_SECRET     len=32
LINEAR_WEBHOOK_SECRET    len=51
ANTHROPIC_API_KEY        len=..
```

`len=0` anywhere means an unfilled blank.

This check catches empty and truncated values. It **cannot** catch a swapped
client id and client secret — both are 32 characters, so the output looks
identical either way. That one is caught at step 12 or not at all, which is why
step 9b asks you to label them as you copy.

And confirm the webhook secret is the one with the prefix:

```bash
grep -q '^LINEAR_WEBHOOK_SECRET=lin_wh_' /root/.cyrus-community/.env \
  && echo "webhook secret OK" || echo "WRONG VALUE — see step 9b"
```

Expect `webhook secret OK`.

---

## 11. systemd unit

```bash
cat > /etc/systemd/system/cyrus-community.service <<'EOF'
[Unit]
Description=Cyrus Community (self-hosted, direct Linear webhooks)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root
Environment=CLAUDE_CODE_EFFORT_LEVEL=xhigh
ExecStart=/usr/bin/node /root/cyrus/apps/cli/dist/src/app.js --cyrus-home /root/.cyrus-community
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

mkdir -p /etc/systemd/system/cyrus-community.service.d
cat > /etc/systemd/system/cyrus-community.service.d/model.conf <<'EOF'
[Service]
EnvironmentFile=/etc/default/cyrus-community
EOF

cat > /etc/default/cyrus-community <<'EOF'
CYRUS_MODEL=claude-opus-5
EOF

systemctl daemon-reload
systemctl enable --now cyrus-community
```

```bash
systemctl is-active cyrus-community
```

Expect `active`.

```bash
journalctl -u cyrus-community --no-pager \
  | grep -iE "listening|registered post|relay registered|edge worker started" | tail -8
```

Expect, among others:

```
[LinearEventTransport] Registered POST /linear-webhook endpoint (direct mode); POST /webhook retained as deprecated alias
[EdgeWorker] ✅ Lanes endpoint registered (localhost only)
[EdgeWorker] ✅ OAuth relay registered (service stays up)
[SharedApplicationServer] Shared application server listening on http://0.0.0.0:3457
[CLI] Edge worker started successfully
```

The GitHub, GitLab and Slack transports log their own `Registered POST` lines
saying `(proxy mode)`. That is correct and not a problem — only the
`LinearEventTransport` line needs to say `(direct mode)`.

`(direct mode)` is the one to actually read. If it says `(proxy mode)`,
`LINEAR_DIRECT_WEBHOOKS` did not take and **every webhook will be rejected**. Go
back to step 10.

Now the 502 from step 7 should be gone:

```bash
curl -s https://cyrus.pontedigital.co/status
```

Expect `{"status":"idle"}`.

---

## 12. Authorise the first workspace

The service stays **up** for this. It catches the OAuth redirect itself and holds
the code for the CLI to collect, so onboarding a client never costs an outage —
which matters once several clients share the box.

```bash
cd /root
node /root/cyrus/apps/cli/dist/src/app.js self-auth-linear \
  --cyrus-home /root/.cyrus-community \
  --env-file /root/.cyrus-community/.env
```

Expect:

```
Service is running — authorising without stopping it.

Visit:
https://linear.app/oauth/authorize?client_id=...&state=...
```

**Browser step.** Open that URL. Pick the workspace deliberately — on a box
serving several clients the selector is the only thing standing between you and
authorising the wrong tenant. Approve.

You have **15 minutes**. The terminal prints `Still waiting for approval...`
each minute so you can see it is alive. Take the time you need; rushing a consent
screen is how you approve the wrong workspace.

Back in the terminal, expect:

```
Exchanging code for tokens...
Got access token: lin_oauth_...
Fetching workspace info...
Workspace: <name> (<uuid>)
Saving tokens to config.json...
Saved credentials for workspace: <name>
Authentication complete! Restart cyrus to use the new tokens.
```

```bash
systemctl restart cyrus-community && systemctl is-active cyrus-community
```

Expect `active`.

> **If it times out.** The service may still be holding your code — the error
> message prints the exact `curl` to collect it, including the `flowId`. Run
> that rather than starting over; re-running `self-auth-linear` mints a fresh
> state and the held code becomes unclaimable.

---

## 13. Add a repository

```bash
cd /root
node /root/cyrus/apps/cli/dist/src/app.js self-add-repo \
  https://github.com/<org>/<repo>.git "<Workspace Name>" \
  --cyrus-home /root/.cyrus-community \
  --env-file /root/.cyrus-community/.env
```

`<Workspace Name>` is the display name printed in step 12, exactly as shown.

Expect a clone, then a confirmation that the repo was added. Verify without
printing tokens:

```bash
node -e 'const c=require("/root/.cyrus-community/config.json");
console.log("workspaces:", Object.values(c.linearWorkspaces||{}).map(w=>w.linearWorkspaceName).join(", "));
console.log("repos:", (c.repositories||[]).map(r=>r.name).join(", "));'
```

Expect your workspace name and your repo name.

```bash
systemctl restart cyrus-community
```

---

## 14. Verify a webhook end to end

This is the acceptance step. Everything before it is setup.

Watch the log in one SSH session:

```bash
journalctl -u cyrus-community -f
```

**OFF-BOX — in Linear:** create a throwaway issue in the connected team and
delegate it to the `Ponte Digital` agent.

Expect within a few seconds:

```
[EdgeWorker] Received Linear webhook: AgentSessionEvent (created)
[GitService] Creating git worktree at .../worktrees/<ISSUE-ID>
[ClaudeRunner] Session ID assigned by Claude: ...
[AgentSessionManager] Created thought activity ...
```

And in Linear, the agent session shows an acknowledgement within ~10 seconds.

**If nothing appears at all**, go to
[When webhooks silently don't arrive](#when-webhooks-silently-dont-arrive).

Cancel the throwaway issue when you are done.

---

## 15. Backups and a tested restore

**OFF-BOX — Hetzner Cloud console → your server → Backups.**

Enable backups if you did not tick it in step 1. Then take one manual snapshot
now, named `cyrus-prod-postprovision`.

**A backup you have not restored is not a backup.** Test it once, now, while
nothing depends on it:

1. **OFF-BOX** — Snapshots → `cyrus-prod-postprovision` → **Create Server from
   snapshot**. Name it `cyrus-restore-test`. Do **not** attach the production
   firewall; give it no inbound rules beyond SSH from your prefix.
2. SSH to the restored server's IP.
3. ```bash
   systemctl is-active cyrus-community
   curl -s localhost:3457/status
   ```
   Expect `active` and `{"status":"idle"}`.

   It has the same env, so it is a second live agent. Stop it immediately so it
   cannot answer anything:
   ```bash
   systemctl stop cyrus-community && systemctl disable cyrus-community
   ```
   > Do not point DNS at it and do not let it run. Two boxes holding the same
   > Linear credentials will both try to serve the same sessions.
4. **OFF-BOX** — delete `cyrus-restore-test`.

Record the date you did this. Re-test after any change to the provisioning steps.

```
Restore tested on: ____________
```

---

## 16. Health checks

The failure mode to catch is **silent webhook drops** — the service is up,
`/status` is green, and nothing is arriving. Uptime alone will not catch that,
which is why there are two checks and not one.

### 16a. Uptime probe (OFF-BOX)

Any external uptime service. Configure:

| Field | Value |
|---|---|
| URL | `https://cyrus.pontedigital.co/status` |
| Method | GET |
| Expect | HTTP 200 containing `"status"` |
| Interval | 60s |
| Alert after | 2 consecutive failures |

This catches: box down, Caddy down, service crashed, certificate expired.
It does **not** catch silent webhook drops.

### 16b. Heartbeat (box + OFF-BOX)

**OFF-BOX** — create a check at healthchecks.io: period 5 minutes, grace 5
minutes. Copy its ping URL.

On the box:

```bash
cat > /usr/local/bin/cyrus-heartbeat.sh <<'EOF'
#!/usr/bin/env bash
# Pings only when the service is genuinely serving. Silence is the alert.
set -u
PING_URL="${CYRUS_HEARTBEAT_URL:-}"
[ -z "$PING_URL" ] && exit 0
systemctl is-active --quiet cyrus-community || exit 0
curl -sf --max-time 10 http://127.0.0.1:3457/status | grep -q '"status"' || exit 0
curl -sf --max-time 10 "$PING_URL" > /dev/null
EOF
chmod +x /usr/local/bin/cyrus-heartbeat.sh

cat > /etc/default/cyrus-heartbeat <<'EOF'
CYRUS_HEARTBEAT_URL=https://hc-ping.com/YOUR-UUID-HERE
EOF
chmod 600 /etc/default/cyrus-heartbeat
```

Paste your real ping URL into that file, then schedule it:

```bash
cat > /etc/cron.d/cyrus-heartbeat <<'EOF'
*/5 * * * * root . /etc/default/cyrus-heartbeat && /usr/local/bin/cyrus-heartbeat.sh
EOF
systemctl restart cron
```

Test the alert path — simulate an outage rather than trusting the config:

```bash
systemctl stop cyrus-community
```

Wait out the period plus grace (10 minutes). Expect an alert from
healthchecks.io. Then:

```bash
systemctl start cyrus-community
```

Expect the check to go green on the next tick. **If no alert arrived, the
monitoring is not working** — and the fact that it looked configured is exactly
how silent drops go unnoticed for a week.

```
Alert verified on: ____________
```

---

## 17. The 30-minute rebuild test

The acceptance criterion is that a throwaway VM, rebuilt **purely from this
document**, serves a test webhook in under 30 minutes.

Rules that make the test mean something:

- Use a **different hostname** — `cyrus-rebuild.pontedigital.co` — and a separate
  Linear app. Do not point production DNS at a test box.
- Follow only what is written here. If you find yourself remembering something
  that is not in the document, **that is a defect in the document** — write it
  down and fix the runbook. That is the actual output of this test.
- Start the clock at step 1 and stop it when step 14 shows the session
  acknowledged in Linear.
- Delete the VM and the test Linear app afterwards.

```
Rebuild tested on: ____________   Elapsed: ______
```

---

## 18. Migration and the dev-box token purge

Once production is serving, the old box becomes dev/staging and must stop
holding anything that belongs to a client.

On the **old** box:

```bash
systemctl stop cyrus-community && systemctl disable cyrus-community
```

Confirm no session is mid-flight before you do — `curl -s localhost:3457/status`
should read `idle`, and `curl -s localhost:3457/admin/lanes` should read
`{"lanes":{}}`.

**OFF-BOX — in Linear**, for each client workspace, revoke the old app's
authorisation. This is the step that actually removes access; deleting local
files does not.

Then remove the local credentials:

```bash
shred -u /root/.cyrus-community/config.json /root/.cyrus-community/.env
```

Verify nothing is left:

```bash
grep -rl "lin_oauth_" /root/.cyrus-community/ 2>/dev/null | head
```

Expect **no output**. Any file listed still holds a tenant token.

The dev box keeps its own separate Linear app for fork-on-fork work. It never
shares credentials with production.

---

## When webhooks silently don't arrive

The service is up, `/status` is 200, and Linear shows nothing happening. Work
down this list — it is ordered by how often each one is the answer.

**1. Wrong verification mode.**

```bash
journalctl -u cyrus-community | grep "LinearEventTransport.*Registered POST"
```

Must say `(direct mode)`. `(proxy mode)` means `LINEAR_DIRECT_WEBHOOKS` is not
`true` — every delivery is rejected. Step 10.

> Grep for `LinearEventTransport` specifically, not just `Registered POST`. The
> GitHub, GitLab and Slack transports each log the same sentence and legitimately
> say `(proxy mode)`; only the Linear line matters here, and reading the wrong
> one sends you chasing a setting that is already correct.

**2. Wrong webhook secret.**

```bash
grep -q '^LINEAR_WEBHOOK_SECRET=lin_wh_' /root/.cyrus-community/.env \
  && echo OK || echo "WRONG VALUE"
```

If this prints `WRONG VALUE`, you almost certainly pasted the client secret.
Step 9b.

**3. Wrong webhook URL in Linear.** **OFF-BOX** — the app's Webhook URL must be
`https://cyrus.pontedigital.co/linear-webhook`. A trailing slash, a bare `/`, or
the old `/webhook` path all behave differently, and only one of them is right.
Linear's application page shows recent delivery attempts and their response
codes — read them; they tell you whether Linear is even reaching you.

**4. Reaching Caddy but not the service.**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://cyrus.pontedigital.co/linear-webhook
```

- `403` — correct. The route exists and rejected an unsigned request from a
  non-Linear IP.
- `404` — the route is not registered. The service is running an old build, or
  started before the env file existed. Rebuild (step 8), restart.
- `502` — Caddy cannot reach 3457. `CYRUS_SERVER_PORT` is wrong or the service
  is down.

**5. IP validation rejecting real deliveries.** With `CYRUS_HOST_EXTERNAL=true`,
deliveries are checked against Linear's published webhook IPs
(`LINEAR_WEBHOOK_IPS` in `packages/core/src/security/WebhookIpValidator.ts`). If
Linear has changed its ranges and the allowlist is stale, everything is refused
at the door.

```bash
journalctl -u cyrus-community | grep -i "ip valid\|rejected"
```

To confirm the diagnosis, restart once with `WEBHOOK_IP_VALIDATION=false`. If
webhooks start flowing, the allowlist is the problem — **update the constant, do
not leave validation off.**

**6. The app is not installed in the workspace.** Authorising the app (step 12)
and the workspace having it enabled are two different things. **OFF-BOX** —
Linear → Settings → Applications; confirm `Ponte Digital` is listed and the agent
is assignable.

---

## Quick reference

| Thing | Value |
|---|---|
| Hostname | `cyrus.pontedigital.co` |
| Service port | `3457` |
| Webhook path | `/linear-webhook` (alias `/webhook`, deprecated) |
| OAuth callback | `/callback` |
| Health endpoint | `/status` → `{"status":"idle"\|"busy"}` |
| Lane state | `/admin/lanes` — loopback only |
| Unit | `cyrus-community` |
| Config dir | `/root/.cyrus-community` |
| Env file | `/root/.cyrus-community/.env` (0600) |
| Model override | `/etc/default/cyrus-community` |
| Caddyfile | `/etc/caddy/Caddyfile` |
| Repo | `/root/cyrus` |

```bash
systemctl status cyrus-community
journalctl -u cyrus-community -f
curl -s localhost:3457/status
curl -s localhost:3457/admin/lanes
cd /root/cyrus && git pull && pnpm install && pnpm build && systemctl restart cyrus-community
```

Before any restart, check nothing is mid-flight: `/status` should read `idle` and
`/admin/lanes` should read `{"lanes":{}}`.
