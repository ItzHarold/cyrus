# Runbook — production VM, from zero to first webhook

Written to be followed at 2am with the box gone and nothing memorised. Every
command is exact. Every step says what it should print. Where the work leaves
the terminal — Hetzner console, DNS, Linear, GitHub — the step is marked
**OFF-BOX** and says exactly what to paste where.

Target: **serving a real webhook in under 30 minutes.**

> **Provenance.** Every step below was executed on a fresh Hetzner box on
> 2026-08-19 and corrected against what actually happened. Nineteen defects were
> found that way. Where a step says "expect", that is observed output, not
> expected output — except where explicitly marked unverified. See
> [What is proven, and what is not](#what-is-proven-and-what-is-not).

---

## Contents

| # | Step | Where | ~Time |
|---|------|-------|-------|
| 0 | [Before you start](#before-you-start) | — | 2 min |
| 1 | [Create the VM](#1-create-the-vm-off-box) | **OFF-BOX** Hetzner | 3 min |
| 2 | [Tailscale — the second door](#2-tailscale--the-second-door) | box + browser | 3 min |
| 3 | [Cloud firewall](#3-cloud-firewall-off-box) | **OFF-BOX** Hetzner | 3 min |
| 4 | [DNS](#4-dns-off-box) | **OFF-BOX** registrar | 2 min |
| 5 | [Base packages](#5-base-packages) | box | 4 min |
| 6 | [SSH hardening](#6-ssh-hardening-keys-only) | box | 2 min |
| 7 | [fail2ban](#7-fail2ban) | box | 2 min |
| 8 | [Node and pnpm](#8-node-and-pnpm) | box | 3 min |
| 9 | [Caddy and TLS](#9-caddy-and-tls) | box | 2 min |
| 10 | [Clone and build](#10-clone-and-build) | box | 4 min |
| 11 | [GitHub App credentials](#11-github-app-credentials) | box + **OFF-BOX** | 5 min |
| 12 | [The Linear app](#12-the-linear-app-off-box--read-this-one-slowly) | **OFF-BOX** Linear | 5 min |
| 13 | [Env file, and the key check that matters](#13-env-file-and-the-key-check-that-matters) | box | 4 min |
| 14 | [systemd unit](#14-systemd-unit) | box | 2 min |
| 15 | [Authorise the first workspace](#15-authorise-the-first-workspace) | box + browser | 3 min |
| 16 | [Add a repository](#16-add-a-repository) | box | 2 min |
| 17 | [Verify a webhook end to end](#17-verify-a-webhook-end-to-end) | box + Linear | 3 min |
| 18 | [Backups and a tested restore](#18-backups-and-a-tested-restore) | **OFF-BOX** Hetzner | 10 min |
| 19 | [Health checks](#19-health-checks) | box + **OFF-BOX** | 15 min |
| 20 | [The timed rebuild test](#20-the-timed-rebuild-test) | — | 30 min |
| 21 | [Migration and the dev-box token purge](#21-migration-and-the-dev-box-token-purge) | both boxes | 10 min |
| — | [When webhooks silently don't arrive](#when-webhooks-silently-dont-arrive) | — | — |
| — | [What is proven, and what is not](#what-is-proven-and-what-is-not) | — | — |

---

## Before you start

Have these open in browser tabs before you touch a terminal. Hunting for a
credential mid-rebuild is what turns 30 minutes into 90.

- Hetzner Cloud console
- DNS registrar for `pontedigital.co`
- Linear → Settings → API → **OAuth applications**
- GitHub → your org → Settings → Developer settings → GitHub Apps
- The password manager entry holding the production `ANTHROPIC_API_KEY`

Decide the hostname now and use it consistently. This runbook writes it as
`agent.pontedigital.co`.

> **Naming rule.** "Cyrus" appears nowhere client-visible — not in hostnames,
> not in the Linear app name, not in a URL on a consent screen. Internal names
> stay as they are: the systemd unit `cyrus-community`, the repo at
> `/root/cyrus`, the config dir `~/.cyrus-community`, every `CYRUS_*` variable.
> No client sees those and renaming them is churn with real breakage risk.

Four facts worth knowing before they surprise you:

- **The service listens on port 3457, not 3456.** 3456 is the upstream default
  (`apps/cli/src/config/constants.ts:8`); this deployment overrides it. Leave
  `CYRUS_SERVER_PORT` unset and Caddy proxies to a port with nothing on it.
- **The webhook path is `/linear-webhook`.** `/webhook` still works as a
  deprecated alias but logs a warning.
- **The OAuth callback path is `/callback`.** Different path, same host.
- **Ubuntu 26.04 LTS** is what every config here is verified on. PON-126 says
  Ubuntu 24; 26.04 is what the reference box and the rebuild box both run. Pick
  24.04 only deliberately, and expect step 8 to need a version check.

### The script, and when not to use it

`scripts/provision-production.sh` does the mechanical steps — **5, 6, 7, 8, 9,
10, 13, 14, 19b** — so a rebuild is not 30 minutes of copy-paste:

```bash
./scripts/provision-production.sh --host agent.pontedigital.co --ssh-prefix 161.51.0.0/16
```

Safe to re-run at any point, **including partway through a run that failed**.
Every step decides what to do by inspecting the system rather than consulting a
"steps completed" file — a marker file lies after a partial failure, claiming a
step finished when the process was killed halfway through it. It never
overwrites a secret and will not touch a `config.json` that already holds an
authorised workspace. `--dry-run` shows what it would change.

It deliberately does **not** create the VM, the firewall, DNS, the GitHub App or
the Linear app, and approves nothing in a browser. Those are steps 1, 3, 4, 11,
12 and 15 — none can be made idempotent, and a script that half-creates a Linear
app is worse than no script.

**Read the steps anyway the first time.** The script tells you *what* it did;
this document tells you *why*, and the why is what you need at 2am. If the two
ever disagree, the document is right and the script is a bug.

---

## 1. Create the VM (OFF-BOX)

**OFF-BOX — Hetzner Cloud console → Add Server.**

| Field | Value |
|---|---|
| Location | Falkenstein or Nuremberg |
| Image | Ubuntu 26.04 |
| Type | **CPX31 or CX33** — 4 vCPU, 8 GB RAM |
| Networking | Public IPv4 **on**, IPv6 on |
| SSH key | Your existing key. **Not** password auth |
| Backups | **Enable now** — cheaper than retrofitting at step 18 |
| Name | `pontedigital-prod` |

The workload is network-bound — Claude sessions, git worktrees, a webhook
server. Builds and previews run on client Vercel. Sized for cleanliness, not
compute; do not upsize reflexively.

```
IPv4: ____________________
```

---

## 2. Tailscale — the second door

**Before the firewall, deliberately.** Tailscale dials out and needs no inbound
rule, so nothing stops it being installed first — and installing it first means
you never have a moment where exactly one door exists. Step 3 narrows SSH to a
network prefix, which is a guess about your ISP's allocation; on a home
connection that guess can expire with a router reboot.

```bash
ssh root@<IPv4 from step 1>
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --ssh --hostname=pontedigital-prod
```

It prints a URL. **Open it in a browser and approve** — a browser step in the
middle of a terminal step.

```bash
tailscale status
```

Expect a `100.x.y.z` address for `pontedigital-prod`.

**Then actually use it**, from your laptop:

```bash
ssh root@100.x.y.z 'echo tailscale-ok'
```

`tailscale status` reporting an address proves the daemon is up. It does not
prove you can get in. **The second door counts when you have opened it**, and
that distinction is the whole reason this step precedes the firewall.

`curl` is present on Ubuntu cloud images, so this works before step 5.

While you are here, open the Hetzner web console (the `>_` button) once and
confirm it gives a login prompt. It is the third door, survives both a wrong
prefix and a broken Tailscale, and 2am is not when you want to discover it needs
a password you never set.

---

## 3. Cloud firewall (OFF-BOX)

**OFF-BOX — Hetzner console → Firewalls → Create Firewall**, named
`pontedigital-prod`.

The enforcement point is deliberately *outside* the VM. A host firewall that
goes wrong locks you out of your own box; a cloud rule can always be edited from
the console. `ufw` stays **inactive** on the host — a decision, not an oversight,
verified at step 7.

First, from your **laptop**, get the address to derive the prefix from:

```bash
curl -s https://api.ipify.org; echo
```

Inbound rules — three, exactly:

| Port | Protocol | Source | Why |
|---|---|---|---|
| 22 | TCP | your ISP's **prefix**, e.g. `161.51.0.0/16` — never a `/32` | SSH |
| 80 | TCP | `0.0.0.0/0` and `::/0` | ACME HTTP-01 challenge |
| 443 | TCP | `0.0.0.0/0` and `::/0` | Linear webhooks, OAuth callback |

Leave **outbound unrestricted** — Tailscale, apt, the Linear API and the
Anthropic API all dial out.

Port 80 is not optional even though nothing serves plain HTTP: Caddy needs it
for the ACME challenge at step 9, and a missing rule surfaces two steps later as
a TLS failure, which is a miserable thing to debug.

Apply to `pontedigital-prod`.

**Verify from your laptop, on your ISP connection:**

```powershell
Test-NetConnection <IPv4> -Port 22
```

```bash
nc -vz -w 5 <IPv4> 22
```

Expect **port 22 to succeed**. That is the whole check at this stage.

> **Do not test port 80 here.** Nothing listens on it until step 9, so a correct
> setup looks broken. Worse, `Test-NetConnection` reports `False` for both a
> refused connection and a dropped packet — so the refused-vs-timeout signal
> that would distinguish "rule missing" from "nothing listening" is invisible on
> Windows. Port 80 gets checked at step 9, where it is a diagnostic for a real
> failure rather than a verification guaranteed to fail.

Then confirm the other door still works:

```bash
ssh root@100.x.y.z 'echo tailscale-ok'
```

---

## 4. DNS (OFF-BOX)

**OFF-BOX — your registrar.**

```
agent.pontedigital.co.    A    <IPv4 from step 1>    TTL 300
```

Do this now, before step 9 needs it — DNS propagation is the one thing here you
cannot hurry.

> **If this is a rebuild test, use a different hostname** —
> `agent-rebuild.pontedigital.co` — and a separate Linear app and GitHub App.
> **Do not repoint the production hostname at a test box.** It carries live
> client work, and moving it onto a half-built machine with no credentials and
> no service is an outage for every client at once. Everything downstream
> inherits the choice: `CYRUS_BASE_URL`, the Caddyfile, and both Linear URLs.

Verify from your **laptop**, not the box:

```bash
dig +short agent.pontedigital.co
```

Expect the IPv4 and nothing else. Empty means it has not propagated — wait. Do
not proceed to step 9 until this answers, or you will be debugging Caddy when
the problem is DNS.

---

## 5. Base packages

```bash
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
apt-get update && apt-get -y upgrade
apt-get -y install fail2ban curl ca-certificates gnupg git socat bubblewrap
```

Expect a wall of apt output ending with no `E:` lines. Two to four minutes.

> **Both environment variables are load-bearing.** Without
> `DEBIAN_FRONTEND=noninteractive`, apt can open a full-screen configuration
> dialog mid-upgrade. Without `NEEDRESTART_MODE`, Ubuntu's `needrestart` opens
> its own dialog asking which services to restart.
>
> **Use `l`, not `a`.** `NEEDRESTART_MODE=a` restarts every service with stale
> binaries — including `ssh.service` and `tailscaled` — which drops your session
> mid-step and leaves you unable to tell whether the upgrade finished. `l` lists
> what needs restarting and restarts nothing. Then you reboot deliberately, at a
> moment you chose.
>
> **Both variables are lost on reconnect.** Any new shell needs the `export`
> line again before continuing.

If the upgrade pulled a new kernel or deferred restarts:

```bash
reboot
```

Wait ~30s, reconnect, and re-export before continuing. Better now than halfway
through the build.

> **Why `socat` and `bubblewrap`, and what they do *not* do.** Without them the
> service logs a startup warning that Linux sandbox requirements are unmet and
> `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is being skipped. Installing them silences
> that warning and readies the box if the flag is ever switched on.
>
> **They do not enable env scrubbing.** The code never sets that flag —
> `ClaudeRunner.ts`, `session-env.ts` and `EdgeWorker.ts` each say "intentionally
> not set" pending an investigation into bubblewrap side effects (CYPACK-1108).
> Session subprocesses see the process environment, client tokens included, on
> every box regardless of these packages. Install them for a clean startup; do
> not read their presence as a security control.
>
> `debian-keyring`, `debian-archive-keyring` and `apt-transport-https` are not
> installed — they existed only for a third-party Caddy repository that step 9
> no longer uses.

---

## 6. SSH hardening (keys only)

**Keep this session open** until you have verified from a second terminal.

```bash
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sshd -t && echo "CONFIG VALID"
```

**Stop here.** Expect exactly `CONFIG VALID`. Any other output means the config
is broken — do not reload. Reloading a broken `sshd_config` while logged in is
how you lose a box.

Then:

```bash
systemctl reload ssh
sshd -T | grep -E '^(passwordauthentication|permitrootlogin)'
systemctl is-active ssh ssh.socket 2>/dev/null
```

Expect:

```
permitrootlogin prohibit-password
passwordauthentication no
```

On 26.04, **both `ssh` and `ssh.socket` reporting `active` is normal** — SSH is
socket-activated. Not an anomaly.

**Now the check that actually proves it**, from a **second terminal**:

```bash
ssh root@<IPv4> 'echo public-ok'
ssh root@100.x.y.z 'echo tailscale-ok'
ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no root@<IPv4>
```

The third **must fail** with `Permission denied (publickey)`. That failure is
the pass.

> **`sshd -T` is not sufficient on its own.** It parses `/etc/ssh/sshd_config`
> and prints what the file *would* produce — it does not report what the running
> daemon is enforcing. It would print the reassuring two lines above even if the
> reload silently failed and the old daemon were still accepting passwords. On a
> box that will hold client credentials, "keys-only" should be backed by a
> refusal, not by a config parse.

---

## 7. fail2ban

Substitute your own prefix — the same one from step 3.

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
```

**Wait for it to be ready before querying it:**

```bash
for i in $(seq 10); do fail2ban-client ping >/dev/null 2>&1 && break; sleep 1; done
fail2ban-client status
ufw status
```

Expect:

```
Status
|- Number of jail:	1
`- Jail list:	sshd
```

and `Status: inactive` for ufw (or `ufw: command not found` — both pass; the
cloud firewall is the enforcement point either way).

> **Do not chain `enable --now`, `restart` and `status` together.** `enable
> --now` already starts the service; a restart straight after races the socket,
> and a status query in the same breath returns `Failed to access socket path:
> /var/run/fail2ban/fail2ban.sock. Is fail2ban running?` on a **perfectly
> healthy system**. That error sends you diagnosing a service that is fine.

### Prove the filter is not blind

A jail can be active and see nothing. From your **laptop**, three times:

```bash
ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no -o StrictHostKeyChecking=no nosuchuser@<IPv4>
```

Then on the box:

```bash
grep -iE "ignore|found|ban" /var/log/fail2ban.log | tail -20
fail2ban-client status sshd
```

**The pass is a line naming your IP** — `[sshd] Ignore <your-ip> by ip` or
`[sshd] Found <ip>`. Either proves the filter parsed a real sshd auth failure
out of the journal on a socket-activated box.

**The fail is silence** — no mention of your address anywhere. That means the
filter is not seeing sshd's journal entries, and the `journalmatch` needs
attention.

> **Do not use `Total failed` as the check.** Your prefix is in `ignoreip`, and
> fail2ban applies that list *inside the filter, before recording the failure* —
> an ignored address is logged and dropped, never counted. `Total failed` will
> read 0 no matter how well it is working. Only the log lines prove liveness.

---

## 8. Node and pnpm

```bash
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node -v && npm -v
corepack enable
corepack prepare pnpm@10.33.1 --activate
pnpm -v
```

Expect `v22.23.2` (or later 22.x), npm `10.x`, and pnpm exactly `10.33.1`.

`pnpm -v` must match `packageManager` in the repo's `package.json`. A mismatch
surfaces much later as a confusing install failure — check it here.

---

## 9. Caddy and TLS

**DNS from step 4 must already resolve.**

```bash
apt-get install -y caddy
caddy version
```

Expect `v2.6.2` or similar — the Ubuntu archive package, which is what the
production box runs (`caddy 2.6.2-14` from `resolute/universe`, no
`sources.list.d` entry, no third-party keyring).

> **Do not add Caddy's Cloudsmith repository.** Earlier versions of this runbook
> did, which was wrong: no box of ours has ever used it, the archive package
> serves production today, and on 26.04 the third-party list may have no
> matching build — turning a two-second install into a repo failure at 2am. One
> fewer third-party repo on a box holding client credentials is also the better
> default.

```bash
cat > /etc/caddy/Caddyfile <<'EOF'
agent.pontedigital.co {
	reverse_proxy localhost:3457
}
EOF
systemctl reload caddy || systemctl restart caddy
systemctl is-active caddy
curl -sI https://agent.pontedigital.co/status | head -1
```

Expect `active`, then **`HTTP/2 502` — and 502 is the pass.** Caddy holds a
valid certificate (a bad one fails the handshake rather than returning a status)
and is proxying to 3457 where nothing listens yet. Step 14 turns this into 200.

**If you get a TLS error instead**, issuance failed:

```bash
journalctl -u caddy -n 30 --no-pager
```

Almost always DNS not yet propagated, or **port 80 blocked** so the ACME
challenge cannot complete. This is where the port-80 check belongs:

```bash
nc -vz -w 5 <IPv4> 80
```

A refused connection means the rule is open and nothing is listening — fine. A
timeout means the firewall dropped it; revisit step 3.

---

## 10. Clone and build

```bash
cd /root
git clone https://github.com/ItzHarold/cyrus.git
cd /root/cyrus
git log --oneline -1
pnpm install
pnpm build
ls -l /root/cyrus/apps/cli/dist/src/app.js
```

Expect `pnpm build` ending in `... build: Done` lines with no `ELIFECYCLE`, then
the path echoed back. Slowest step — 2 to 4 minutes.

If `ls` does not find that file, the build did not finish regardless of what it
printed. Do not continue.

> **A plain clone of `main` is correct.** Step 15 authorises a workspace
> *without stopping the service*, which needs the OAuth relay introduced in
> `a08dbea4` and merged to `main` in `885bb8ae` on 2026-08-20. No branch
> checkout, no version pin. If you are ever building from a checkout that
> predates that merge, `self-auth-linear` falls back to binding the port itself
> and step 15 behaves nothing like this document says — step 14 tells you which
> you have, from the `OAuth relay registered` line.

> **The ignored-build-scripts warning is expected.** `pnpm install` prints:
>
> ```
> Ignored build scripts: @github/keytar, cloudflared, esbuild, node-pty,
> protobufjs, tree-sitter-bash
> ```
>
> This is deliberate: `package.json` sets `pnpm.onlyBuiltDependencies:
> ["sqlite3"]`, so pnpm 10 blocks every other postinstall. The production box
> shows the identical six and works — esbuild ships platform binaries as
> optional dependencies rather than via postinstall, `node-pty` has never needed
> a compiled `.node` on our code path, and `cloudflared` is irrelevant because
> Caddy terminates TLS. **Nothing to do.**

Then the config directory:

```bash
mkdir -p /root/.cyrus-community
[ -f /root/.cyrus-community/config.json ] || echo '{"repositories":[]}' > /root/.cyrus-community/config.json
chmod 600 /root/.cyrus-community/config.json
```

---

## 11. GitHub App credentials

Without this, the agent can clone public repositories and **nothing else** — no
private client repo, no branch push, no pull request. It will start, look
healthy, and be unable to do the job.

### Use a GitHub App. Not `gh auth login`, not a PAT.

All three work mechanically. Only one survives contact with a second client:

| | What it ties the box to | Per-client scope | Who can revoke | Appears as |
|---|---|---|---|---|
| `gh auth login` | Harold's personal account | none — every repo he can reach | Harold, all-or-nothing | Harold |
| PAT | a user account | fine-grained PATs can scope, but manually | Harold | Harold |
| **GitHub App** | **an installation the client controls** | **per org/repo, granted by the client** | **the client, by uninstalling** | **the app** |

The App is the only option where a client can grant access to exactly one
repository and withdraw it themselves, and the only one where a PR is not
authored by a person who did not write it. A PAT on this box is a single
long-lived credential reaching every client at once — the blast radius is every
repo Harold can see, and rotating it interrupts all clients simultaneously.

It is also what the code already expects. `EdgeWorker.resolveGitHubToken()`
resolves in three tiers — proxy-forwarded installation token, then a
self-minted App token, then `GITHUB_TOKEN` as a legacy fallback — and
`GitHubAppTokenProvider` mints short-lived installation tokens and refreshes
them five minutes before expiry. Choosing a PAT means deliberately landing on
the fallback tier.

### 11a. Create the app (OFF-BOX)

**OFF-BOX — GitHub → your org → Settings → Developer settings → GitHub Apps →
New GitHub App.**

| Field | Value |
|---|---|
| Name | `Ponte Digital Agent` |
| Homepage URL | `https://pontedigital.co` |
| Webhook | **Active off** for now — Linear drives the agent; GitHub webhooks are a later feature |
| Repository permissions | **Contents: Read & write**, **Pull requests: Read & write**, **Metadata: Read-only** |
| Where can this app be installed | **Any account** — clients install it into their own orgs |

Create it, then **Generate a private key** and download the `.pem`.

Note the **App ID** from the app's settings page.

### 11b. Install it and get the installation ID (OFF-BOX)

Install the app into the org holding the repositories this box will serve,
**selecting only the specific repositories** rather than all.

After installing, the browser URL ends in the installation id:

```
https://github.com/organizations/<org>/settings/installations/<INSTALLATION_ID>
```

### 11c. Place the key on the box

The private key must be at exactly this path — the code derives it from
`cyrusHome` and does not read a configurable location:

```bash
# paste the .pem contents; end with Ctrl-D
cat > /root/.cyrus-community/github-app.pem
chmod 600 /root/.cyrus-community/github-app.pem
head -1 /root/.cyrus-community/github-app.pem
```

Expect `-----BEGIN RSA PRIVATE KEY-----`. If it says anything else the paste
mangled it — a wrapped or truncated PEM fails at JWT signing, not at startup.

The App ID and installation ID go into the env file at step 13.

> **Known limitation, worth knowing before you scale.** The provider reads a
> **single** `GITHUB_APP_INSTALLATION_ID` from the environment. One installation
> per box. A second client in a different org is a second installation with a
> different id, and there is nowhere to put it. Serving multiple client orgs
> from one box needs per-repository installation ids — a code change, not a
> configuration one. Fine for the first client; plan for it before the second.

---

## 12. The Linear app (OFF-BOX) — read this one slowly

**OFF-BOX — Linear → Settings → API → "OAuth applications" → Create new
application.**

> **Get the section right.** That page has three sections. You want **OAuth
> applications**. The **Webhooks** section on the same page opens a Create
> webhook form that looks correct and is not — it yields a signing secret and no
> client id, and you will not discover the mistake until step 15 fails.

This is where a rebuild fails silently: the app hands you **three secrets**, and
two are indistinguishable once they leave the browser.

| Field | Value — paste exactly |
|---|---|
| Name | `Ponte Digital` |
| Developer name | `Ponte Digital` |
| Callback URL | `https://agent.pontedigital.co/callback` |
| Public | **Yes** — clients install it into their own workspaces |
| Webhooks | **Enable the toggle first** |
| Webhook URL | `https://agent.pontedigital.co/linear-webhook` |

> **Enable the Webhooks toggle before looking for the URL field.** The webhook
> URL and the event checkboxes stay hidden until you do — the fields in this
> table do not all exist on a freshly opened form.

Webhook event types to tick:

- **Agent session events** — required; this is how issues reach the agent
- **Inbox notifications** — assignment and mention handling
- **Issues** — title and description changes
- **Comments** — mid-session prompting

Note the two different paths: callback is `/callback`, webhook is
`/linear-webhook`. Both on the same host. Getting the webhook path wrong is the
most common cause of "webhooks silently don't arrive".

### Record all three before leaving the tab

Linear shows each exactly once.

```
App ID          ______________________________  (32 hex)
Client secret   ______________________________  (32 hex)
Webhook secret  lin_wh_______________________   (~51 chars)
```

**Label them as you copy.** Client ID and client secret are **both 32 hex
characters**. Nothing distinguishes them once they are out of the browser — not
length, not shape, and no check in this runbook can catch a swap. A swap
surfaces at step 15 as an opaque OAuth error naming neither field. Only the
webhook secret carries the `lin_wh_` prefix.

Both URLs must agree with `CYRUS_BASE_URL` from step 13, and nothing validates
that they do. Change the hostname later and you must change it in both places.

---

## 13. Env file, and the key check that matters

```bash
cat > /root/.cyrus-community/.env <<'EOF'
CYRUS_SERVER_PORT=3457
CYRUS_BASE_URL=https://agent.pontedigital.co
CYRUS_HOST_EXTERNAL=true
LINEAR_DIRECT_WEBHOOKS=true
LINEAR_CLIENT_ID=
LINEAR_CLIENT_SECRET=
LINEAR_WEBHOOK_SECRET=
ANTHROPIC_API_KEY=
GITHUB_APP_ID=
GITHUB_APP_INSTALLATION_ID=
EOF
chmod 600 /root/.cyrus-community/.env
nano /root/.cyrus-community/.env
```

What each line does, so you can tell when one is wrong:

| Variable | Effect if wrong or missing |
|---|---|
| `CYRUS_SERVER_PORT=3457` | Caddy proxies to an empty port; everything 502s |
| `CYRUS_BASE_URL` | OAuth redirect goes to the wrong host; consent completes but the CLI never gets a code |
| `CYRUS_HOST_EXTERNAL=true` | Binds loopback only; webhook IP validation stays off |
| `LINEAR_DIRECT_WEBHOOKS=true` | Webhooks verified against the proxy secret instead of Linear's — **all rejected, silently** |
| `LINEAR_WEBHOOK_SECRET` | Signature check fails on every delivery — **silent drops** |
| `ANTHROPIC_API_KEY` | Sessions start and die at the first API call |
| `GITHUB_APP_ID` / `..._INSTALLATION_ID` | No token minted; private clones and all pushes fail |

> **Production uses `ANTHROPIC_API_KEY`, never `CLAUDE_CODE_OAUTH_TOKEN`.** A Max
> subscription token is tied to a personal account and a personal rate limit. A
> client session dying because someone hit a cap is a refund conversation, not an
> incident.

### Structural check

```bash
awk -F= '/^[A-Z]/ {printf "%-28s len=%s\n", $1, length($2)}' /root/.cyrus-community/.env
grep -q '^LINEAR_WEBHOOK_SECRET=lin_wh_' /root/.cyrus-community/.env \
  && echo "webhook secret OK" || echo "WRONG VALUE — see step 12"
```

| Variable | Expected length |
|---|---|
| `CYRUS_SERVER_PORT` | 4 |
| `CYRUS_BASE_URL` | *varies with hostname* |
| `CYRUS_HOST_EXTERNAL` | 4 |
| `LINEAR_DIRECT_WEBHOOKS` | 4 |
| `LINEAR_CLIENT_ID` | 32 |
| `LINEAR_CLIENT_SECRET` | 32 |
| `LINEAR_WEBHOOK_SECRET` | 51 |
| `ANTHROPIC_API_KEY` | ~108 |
| `GITHUB_APP_ID` | ~6–8 |
| `GITHUB_APP_INSTALLATION_ID` | ~8–9 |

Any `len=0` is an unfilled blank. **Lengths that vary with the hostname are
marked as such deliberately** — a hard-coded expected number that is wrong sends
you hunting for a stray character that is not there.

This check **cannot** catch swapped Linear client id and secret. Both are 32.
That one is caught at step 15 or not at all.

### The API key check that actually matters

A key can be valid and still fail every session, because **API billing is
separate from a Max subscription**. A key on an account with no credit balance
authenticates fine and fails at the first completion — the box provisions
cleanly, webhooks arrive, the session starts, and it dies. On a client's first
delegation that is a day-one outage.

`len=108` only proves a key is present. Spend a token:

```bash
set -a; . /root/.cyrus-community/.env; set +a
curl -s https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' \
  | head -c 300; echo
```

**Pass:** JSON containing `"content"` and `"usage"`.

| Response contains | Meaning |
|---|---|
| `credit_balance_too_low` | Key valid, **account has no credits — add them before calling this box ready** |
| `authentication_error` | Key wrong or revoked |
| `not_found_error` on the model | Key works; that model id is unavailable to this account |

**Hard prerequisite.** Do not proceed to step 15 with anything but a completion.

---

## 14. systemd unit

```bash
cat > /etc/systemd/system/cyrus-community.service <<'EOF'
[Unit]
Description=Ponte Digital agent (self-hosted, direct Linear webhooks)
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
sleep 5
systemctl is-active cyrus-community
```

Expect `active`. **Let it settle before querying** — the same race that bites
fail2ban at step 7 applies to anything started and immediately inspected.

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

Two lines to read carefully:

- **`(direct mode)` on the `LinearEventTransport` line.** If it says `(proxy
  mode)`, `LINEAR_DIRECT_WEBHOOKS` did not take and every webhook will be
  rejected. The GitHub, GitLab and Slack transports each log their own
  `(proxy mode)` line — those are correct, and reading the wrong one sends you
  chasing a setting that is already right.
- **`OAuth relay registered`.** Its absence means this build predates `a08dbea4`
  and step 15 will use the standalone flow instead.

Then:

```bash
curl -s https://agent.pontedigital.co/status
```

Expect `{"status":"idle"}` — the 502 from step 9 becoming 200 is the whole stack
coming together.

---

## 15. Authorise the first workspace

The service stays **up** throughout. It catches the OAuth redirect itself and
holds the code for the CLI to collect, so onboarding a client never costs an
outage — which matters once several clients share the box.

```bash
cd /root
node /root/cyrus/apps/cli/dist/src/app.js self-auth-linear \
  --cyrus-home /root/.cyrus-community \
  --env-file /root/.cyrus-community/.env
```

Expect first:

```
Service is running — authorising without stopping it.

Visit:
https://linear.app/oauth/authorize?client_id=...&state=...
```

**That first line is the proof.** If it instead says `Waiting for authorization
on port 3457...`, the relay was not reached and it fell back to the standalone
flow — see the version note at step 10.

**Open the URL and approve.** You have **15 minutes**, with a `Still waiting for
approval...` line each minute. Take the time you need: on a box serving several
tenants, the workspace selector is the only thing between you and authorising
the wrong one.

Expect on success:

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
systemctl restart cyrus-community
sleep 5
systemctl is-active cyrus-community
curl -s https://agent.pontedigital.co/status
```

Expect `active` and `{"status":"idle"}`.

> **If it times out**, the service may still hold your code — the error prints
> the exact `curl` including the `flowId` to collect it. Run that rather than
> starting over: re-running mints a fresh state and the held code becomes
> unclaimable.

---

## 16. Add a repository

```bash
cd /root
node /root/cyrus/apps/cli/dist/src/app.js self-add-repo \
  https://github.com/<org>/<repo>.git "<Workspace Name>" \
  --cyrus-home /root/.cyrus-community \
  --env-file /root/.cyrus-community/.env
```

`<Workspace Name>` is the display name printed at step 15, exactly as shown.

A private repository needs step 11 completed — without App credentials the clone
fails outright.

```bash
node -e 'const c=require("/root/.cyrus-community/config.json");
console.log("workspaces:", Object.values(c.linearWorkspaces||{}).map(w=>w.linearWorkspaceName).join(", "));
console.log("repos:", (c.repositories||[]).map(r=>r.name).join(", "));'
systemctl restart cyrus-community
```

---

## 17. Verify a webhook end to end

The acceptance step. Everything before it was setup.

On the box:

```bash
journalctl -u cyrus-community -f
```

**OFF-BOX — in Linear**, create a throwaway issue and keep it deliberately
trivial so the agent does something cheap:

> **Title:** Provisioning check — confirm session starts
> **Description:** Reply with the current git branch and the output of `node -v`.
> Make no code changes, no commits, no PR.

Delegate it to the agent. **On a box that serves more than one agent identity,
check you picked the right one** — they are different users and the wrong choice
proves nothing about this box.

Expect within a few seconds:

```
[EdgeWorker] Received Linear webhook: AgentSessionEvent (created)
[GitService] Creating git worktree at .../worktrees/<ISSUE-ID>
[ClaudeRunner] Session ID assigned by Claude: ...
[AgentSessionManager] Created thought activity ...
```

and an acknowledgement in Linear within about 10 seconds.

Two things that are informative rather than alarming:

- **It may ask which repository**, even with one configured, when no routing
  label matches. Pick the repo. Note that the answer is currently resolved by
  fallback rather than by your selection (PON-142) — correct with one repo,
  wrong with two.
- **`cyrus-setup.sh` may fail** with `cp: cannot stat
  '/Users/cyrusops/code/cyrus/CLAUDE.local.md'`. That is a hardcoded upstream
  developer path; the session continues (PON-141).

Cancel the throwaway issue when done.

**If nothing appears at all**, go to
[When webhooks silently don't arrive](#when-webhooks-silently-dont-arrive).

---

## 18. Backups and a tested restore

**OFF-BOX — Hetzner console → your server → Backups.** Enable if not already,
then take a manual snapshot named `prod-postprovision`.

**A backup you have not restored is not a backup.** Test it once, now, while
nothing depends on it.

1. **OFF-BOX** — Snapshots → **Create Server from snapshot**, named
   `restore-test`. Do **not** attach the production firewall.
2. SSH to the restored server.
3. **Stop it before verifying anything.** This is the first thing you type:
   ```bash
   systemctl stop cyrus-community && systemctl disable cyrus-community
   ```
   > **The restored box boots as a fully live second agent.** Same env file, same
   > Linear token, and `Restart=always` means it is serving before you finish
   > logging in. Every second between boot and this command, two boxes are
   > answering the same workspace — racing for the same webhooks and posting into
   > the same sessions. Verification that runs first is verification performed
   > while the damage is happening.
   >
   > A snapshot of a box holding client credentials **is** a live credential.
   > Treat restoring one as handling that credential.
4. Now verify — the journal kept the proof:
   ```bash
   journalctl -u cyrus-community --no-pager | grep -E "Edge worker started successfully|listening on" | tail -3
   ```
   Expect the startup lines from this boot. That it came up unattended on a
   restored image is exactly what the test asks, and the log records it whether
   or not the service is still running.
5. **OFF-BOX** — delete `restore-test`.

```
Restore tested on: ____________
```

---

## 19. Health checks

The failure mode to catch is **silent webhook drops** — service up, `/status`
green, nothing arriving. Uptime alone will not catch that, which is why there
are two checks.

### 19a. Uptime probe (OFF-BOX)

| Field | Value |
|---|---|
| URL | `https://agent.pontedigital.co/status` |
| Method | GET |
| Expect | HTTP 200 containing `"status"` |
| Interval | 60s |
| Alert after | 2 consecutive failures |

Catches: box down, Caddy down, service crashed, certificate expired.

### 19b. Heartbeat

**OFF-BOX** — create a check at healthchecks.io: period 5 minutes, grace 5
minutes. Copy its ping URL.

```bash
cat > /usr/local/bin/cyrus-heartbeat.sh <<'EOF'
#!/usr/bin/env bash
# Pings only when the service is genuinely serving. Silence is the alert.
set -u
PING_URL="${CYRUS_HEARTBEAT_URL:-}"
[ -z "$PING_URL" ] && exit 0
systemctl is-active --quiet cyrus-community || exit 0
curl -sf --max-time 10 http://127.0.0.1:3457/status | grep -q '"status"' || exit 0
# A failed ping IS the alert — healthchecks.io notices the silence. Exit 0 so
# cron does not also mail root about it every five minutes.
curl -sf --max-time 10 "$PING_URL" > /dev/null || true
exit 0
EOF
chmod +x /usr/local/bin/cyrus-heartbeat.sh

cat > /etc/default/cyrus-heartbeat <<'EOF'
CYRUS_HEARTBEAT_URL=
EOF
chmod 600 /etc/default/cyrus-heartbeat
nano /etc/default/cyrus-heartbeat   # paste the ping URL

cat > /etc/cron.d/cyrus-heartbeat <<'EOF'
*/5 * * * * root . /etc/default/cyrus-heartbeat && /usr/local/bin/cyrus-heartbeat.sh
EOF
systemctl restart cron

. /etc/default/cyrus-heartbeat && /usr/local/bin/cyrus-heartbeat.sh; echo "exit=$?"
```

Expect `exit=0` **and the check turning green**. Note the design: this exits 0
whether or not it pinged, so the exit code proves nothing — the green check is
the evidence.

### 19c. Prove the alert fires

The only part that matters. A monitoring setup that *looks* configured is how
silent drops go unnoticed for a week.

```bash
systemctl stop cyrus-community
```

Wait period + grace — **10 minutes**. Expect alerts.

```bash
systemctl start cyrus-community
```

Expect green again on the next tick.

**If no alert arrives, the monitoring is not working**, however correct the
config looks.

```
Alert verified on: ____________
```

---

## 20. The timed rebuild test

The acceptance criterion: a throwaway VM, rebuilt **purely from this document**,
serving a test webhook in under 30 minutes.

Rules that make the test mean something:

- Use a **different hostname** (`agent-rebuild.pontedigital.co`), a **separate
  Linear app**, and a **separate GitHub App**. Never repoint production DNS at a
  test box.
- Follow only what is written here. If you find yourself remembering something
  not in the document, **that is a defect in the document** — write it down and
  fix it. That is the actual output of this test.
- Start the clock at step 1, stop it when step 17 shows the session acknowledged
  in Linear.
- A run spent *debugging* the document does not count. The timed run is a clean
  pass over a corrected document.
- Delete the VM, the test Linear app, the test GitHub App and the DNS record
  afterwards, and **revoke the API key** that lived on the test box rather than
  merely deleting the file.

```
Rebuild tested on: ____________   Elapsed: ______
```

---

## 21. Migration and the dev-box token purge

Once production is serving, the old box becomes dev/staging and must stop
holding anything belonging to a client.

On the **old** box, confirm nothing is mid-flight first:

```bash
curl -s localhost:3457/status      # expect {"status":"idle"}
curl -s localhost:3457/admin/lanes # expect {"lanes":{}}
systemctl stop cyrus-community && systemctl disable cyrus-community
```

**OFF-BOX — in Linear**, for each client workspace, revoke the old app's
authorisation. This is the step that actually removes access; deleting local
files does not.

Then remove the local credentials:

```bash
shred -u /root/.cyrus-community/config.json /root/.cyrus-community/.env
shred -u /root/.cyrus-community/github-app.pem 2>/dev/null
grep -rl "lin_oauth_" /root/.cyrus-community/ 2>/dev/null | head
```

Expect **no output** from the last command. Anything listed still holds a tenant
token.

The dev box keeps its own separate Linear app for fork-on-fork work and never
shares credentials with production.

---

## When webhooks silently don't arrive

Service up, `/status` 200, Linear shows nothing. Ordered by how often each is
the answer.

**1. Wrong verification mode.**

```bash
journalctl -u cyrus-community | grep "LinearEventTransport.*Registered POST"
```

Must say `(direct mode)`. `(proxy mode)` means `LINEAR_DIRECT_WEBHOOKS` is not
`true` — every delivery rejected. Grep for `LinearEventTransport` specifically:
GitHub, GitLab and Slack log the same sentence and legitimately say
`(proxy mode)`.

**2. Wrong webhook secret.**

```bash
grep -q '^LINEAR_WEBHOOK_SECRET=lin_wh_' /root/.cyrus-community/.env && echo OK || echo "WRONG VALUE"
```

`WRONG VALUE` almost always means the client secret was pasted here.

**3. Wrong webhook URL in Linear.** **OFF-BOX** — must be
`https://agent.pontedigital.co/linear-webhook`. A trailing slash, a bare `/`, or
the old `/webhook` all behave differently and only one is right. Linear's app
page shows recent delivery attempts and their response codes — read them; they
tell you whether Linear is reaching you at all.

**4. Reaching Caddy but not the service.**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://agent.pontedigital.co/linear-webhook
```

- `403` — correct. The route exists and rejected an unsigned request.
- `404` — route not registered. Old build, or the service started before the env
  file existed. Rebuild, restart.
- `502` — Caddy cannot reach 3457. Wrong `CYRUS_SERVER_PORT`, or service down.

**5. IP validation rejecting real deliveries.** With `CYRUS_HOST_EXTERNAL=true`,
deliveries are checked against `LINEAR_WEBHOOK_IPS` in
`packages/core/src/security/WebhookIpValidator.ts`. A stale allowlist refuses
everything at the door.

```bash
journalctl -u cyrus-community | grep -i "ip valid\|rejected"
```

To confirm, restart once with `WEBHOOK_IP_VALIDATION=false`. If webhooks flow,
**update the constant — do not leave validation off.**

**6. App not installed in the workspace.** Authorising (step 15) and the
workspace having it enabled are different things. **OFF-BOX** — Linear →
Settings → Applications.

---

## What is proven, and what is not

Status as of **2026-08-19**, from a full walkthrough on a fresh Hetzner box
(`agent-rebuild.pontedigital.co`, CX33, Ubuntu 26.04).

| PON-126 acceptance criterion | Status | Evidence |
|---|---|---|
| Onboarding without an outage | **PASS** | `self-auth-linear` reported "Service is running — authorising without stopping it"; approved in 36s; `NRestarts=0` across the flow |
| Webhook served end to end | **PASS** | Delegated issue → `AgentSessionEvent (created)` → worktree → `session_started` → `session_completed`, messageCount 10 |
| Snapshot restore tested | **PASS** | Snapshot restored to a new server; service came up unattended, `{"status":"idle"}`; stopped and deleted |
| Health check alerts fire on simulated outage | **PASS** | Service stopped; alerts received from **both** healthchecks.io and UptimeRobot; recovered on restart |
| **Throwaway VM rebuilt from the runbook in under 30 min** | **NOT VERIFIED** | The 2026-08-19 run *found and fixed* 19 defects in this document. It measured debugging, not following. **A clean timed run against this corrected version has not happened.** |
| Production sessions run from the new box | **NOT DONE** | The box built on 2026-08-19 was `agent-rebuild`, a throwaway. `agent.pontedigital.co` does not exist yet |
| Dev box holds no tenant tokens | **NOT DONE** | Step 21 has not been run |

**Do not read the four passes as a passing rebuild.** They were obtained while
correcting the document, on a box built with help. The criterion that matters —
that this document alone, followed by someone with no memory of writing it, gets
to a served webhook in 30 minutes — is untested.

### Defects this document has already absorbed

Nineteen, found by executing it rather than reading it. The pattern worth
knowing, because six of them were the same mistake: **a verification written to
assume a finished system, then placed where the system is not finished yet.**
Port 80 checked before anything listens. A fail2ban counter that `ignoreip`
guarantees will not move. `sshd -T` parsing a file rather than interrogating a
daemon. When adding a step, ask what state it actually runs in.
