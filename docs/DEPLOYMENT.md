# Private deployment guide and checklist

Target architecture: **one Node API process**, an **HTTPS reverse proxy** that serves the built web app and forwards `/api`, and a **managed PostgreSQL 16** database. This is a checklist for a human operator. Nothing here has been done: no host, domain, database, secret, backup or email provider exists yet. Status words used below: **verified** (exercised in this repository), **rehearsed locally** (run once on a developer machine), **not verified** (never run).

Read [RELEASE.md](RELEASE.md) for the reasoning behind these settings and [OPERATIONS.md](OPERATIONS.md) for scheduler guarantees.

## 0. Decisions you must make first

| # | Decision | Why it matters |
|---|---|---|
| 1 | **Account recovery.** Password reset by email exists but only works once an email provider is configured and verified. Until then an operator issues one-time links with `admin:reset-link` (OPERATIONS.md). There is no email change. | Fine for a handful of invited people you can help; plan an email provider before inviting strangers. |
| 2 | **Who may register.** Registration is open to anyone who can reach the site (rate-limited only). | For a private deployment, restrict access at the proxy (IP allow-list, VPN, HTTP basic auth, or an SSO gateway) until you decide otherwise. There is no invite system. |
| 3 | **Email.** Optional. Keep it off for the first deployment unless you will run the manual provider test in RELEASE.md. | Real SMTP delivery is not verified. |
| 4 | **Backup retention.** Sets how long deleted accounts persist in backups. | A user who deletes their account is told backups may keep the data until they expire. Publish the number you choose. |
| 5 | **Hosting target** (a VM you manage, or a container platform). There is no Dockerfile. | The steps below assume a Linux VM with systemd; adapt for a platform. |

## 1. Environment variables

Set these in the service manager's environment (systemd `EnvironmentFile`, platform secret store), **not** in a committed file. The API reads only the process environment in production (`dist/server.js` does not load `.env`; `npm start -w @subcycle/api` loads an optional `../../.env` and is for local use).

| Variable | Required | Purpose | Value / how to generate | Safe handling |
|---|---|---|---|---|
| `NODE_ENV` | **yes** | switches on production behaviour: `__Host-` cookie name, `Secure` cookies, strict start-up validation | literally `production` | not secret |
| `PORT` | no (3001) | port the API listens on | e.g. `3001`, bound only to localhost behind the proxy (firewall it from the internet) | not secret |
| `DATABASE_URL` | **yes** | PostgreSQL connection | `postgres://subcycle_app:<password>@<host>:5432/subcycle?sslmode=require` (use `verify-full` plus a CA if the provider supplies one). Password: `openssl rand -base64 32 \| tr '+/' '-_' \| tr -d '='` (URL-safe: avoids characters needing escaping) | **secret.** Never `subcycle:subcycle` (start-up refuses it). Never in git, shell history or CI logs |
| `APP_URL` | **yes** | public URL of the app, used in email links | `https://<your-domain>` (no trailing path; `localhost` is refused) | not secret |
| `CORS_ORIGINS` | **yes** | browser origins allowed to call the API with credentials; also the CSRF origin allow-list | the same `https://<your-domain>`; no wildcards | not secret |
| `TRUST_PROXY` | **yes** | number of reverse proxies in front of the API, so rate limits see real client IPs | `1` for one proxy | not secret. The proxy must **overwrite** `X-Forwarded-For` (see §4) or clients can dodge rate limits |
| `LOG_LEVEL` | no (`info`) | log verbosity | `info` | not secret |
| `SCHEDULER_ENABLED` | no (`true`) | run reminders / roll-forward in this process | `true` (keep it on with a single instance) | not secret |
| `SCHEDULER_INTERVAL_SECONDS` | no (300) | pause between cycles, 30–3600 | `300` | not secret |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` | no | enable email; all three or none | from the provider; leave **unset** until you run the manual provider test | not secret |
| `SMTP_SECURE` | no (`false`) | `true` = implicit TLS (port 465); `false` = STARTTLS | per provider | not secret |
| `SMTP_USER`, `SMTP_PASS` | no | SMTP credentials | from the provider | **secret** |
| `SMTP_REQUIRE_TLS` | no (`true`) | mandatory STARTTLS when `SMTP_SECURE=false` | leave default; `false` is refused in production | not secret |

There is no session-signing key, API key or other application secret: sessions are random tokens stored hashed in PostgreSQL. The **only** secrets are the database password and optional SMTP credentials.

**Safe configuration practice**
- Generate the database password on the machine that will use it or in a password manager; paste it into the secret store once; do not email or chat it.
- systemd example: `/etc/subcycle/api.env` owned by `root`, mode `0600`, referenced by `EnvironmentFile=`; the service runs as an unprivileged user that cannot read it directly (systemd reads it as root).
- Rotate the database password by `ALTER ROLE … PASSWORD …`, updating the secret store and restarting the API. No stored data depends on it.
- Start the API once and read the first log lines: any `config_warning` event must be something you have consciously accepted. Unsafe values (dev credentials, `http://` or localhost URLs, wildcard CORS, disabling SMTP TLS) make the process **refuse to start** with a message that never contains the secret (**verified**, `production-hardening.test.ts`).

## 2. Provisioning order

Do these in order; do not skip a verification.

1. **Domain and TLS.** DNS `A/AAAA` record for the chosen host name; the reverse proxy obtains a certificate (Caddy does this automatically; otherwise use your platform's). Browse to the placeholder page over `https://` and confirm no certificate warning.
2. **Managed PostgreSQL 16.** Create a database `subcycle` and a **dedicated login role** that **owns** it (on PostgreSQL 15+ only the database owner may create tables in `public`; the migrations need `CREATE` for tables, a trigger function and triggers, and no extensions). Require TLS in the provider settings. Restrict network access to the API host's address (or a private network). Note the provider's `max_connections`: the API uses up to 10. *Rehearsed locally* with a dedicated owner role on PostgreSQL 16; **not verified** against any managed provider or with TLS enforced.
3. **Backups first** (see §5): enable the provider's automated backups and point-in-time recovery **before** loading real data, and take one manual snapshot. Do not tell anyone the data is backed up until a restore drill has passed.
4. **Build.** On the API host (or in CI, then copy the tree) with Node `24.15.0` or newer in the 24 line (`.nvmrc`; the supported range is `^22.22.2 || ^24.15.0 || >=26`):
   ```bash
   git clone <repo> /srv/subcycle && cd /srv/subcycle && git checkout <release commit or tag>
   npm ci
   npm run build                 # builds shared, api, and web (apps/web/dist)
   npm prune --omit=dev          # optional: drops dev tooling from the running tree
   ```
   **Rehearsed locally:** `npm ci` → `npm run build` → `npm prune --omit=dev` → migrate and start from `dist` against a scratch PostgreSQL in production mode worked. After pruning, `npm run migrate` is **not available** (it uses `tsx`, a dev dependency): use the compiled command in step 6.
5. **Publish the web app.** Copy (or point the proxy at) `apps/web/dist` (e.g. `/srv/subcycle/apps/web/dist`). It is static; no build-time secrets or variables exist.
6. **Migrate** (with the production `DATABASE_URL` in the environment):
   ```bash
   node apps/api/dist/db/migrate-cli.js      # prints "Applied: 0001_init.sql, 0002_reminder_skip_reasons.sql"
   node apps/api/dist/db/migrate-cli.js      # second run must print "Database is up to date."
   ```
   This command does not read a `.env` file: export the variables or run it under the same `EnvironmentFile` as the service (`systemd-run --property=EnvironmentFile=/etc/subcycle/api.env --wait node …`). Take a backup before any later migration; there are no down-migrations (RELEASE.md).
7. **Start the API** under a supervisor that restarts it on exit (it exits 1 on a fatal error by design). Example unit:
   ```ini
   [Unit]
   Description=SubCycle API
   After=network-online.target
   [Service]
   User=subcycle
   WorkingDirectory=/srv/subcycle
   EnvironmentFile=/etc/subcycle/api.env
   ExecStart=/usr/bin/node apps/api/dist/server.js
   Restart=always
   RestartSec=3
   TimeoutStopSec=20
   NoNewPrivileges=true
   ProtectSystem=strict
   PrivateTmp=true
   [Install]
   WantedBy=multi-user.target
   ```
   Run **exactly one** instance (do not enable it on two hosts, do not run a second copy to "deploy without downtime"). *Verified in a Linux container (Node 24.15.0, pruned production tree, real PostgreSQL):* the API logs `shutting_down` and `scheduler_stopped` and exits with code **0** on both `SIGTERM` and `SIGINT`. *Verified:* the unit file passes `systemd-analyze verify` (syntax and paths only). *Not verified:* running under a real systemd (restart policy, `ProtectSystem=strict` sandboxing with your directory layout, `TimeoutStopSec`), and shutdown with a slow in-flight request.
8. **Verify readiness locally on the host**, before the proxy forwards anything:
   ```bash
   curl -fsS http://127.0.0.1:3001/api/health        # {"data":{"status":"ok"}}
   curl -fsS http://127.0.0.1:3001/api/health/ready   # {"data":{"status":"ok","database":"ok"}}
   journalctl -u subcycle -n 30 --no-pager             # expect "listening", "scheduler_started"; review any config_warning
   ```
9. **Configure the reverse proxy** (§4) and reload it. Then from **outside** the host: `curl -fsS https://<domain>/api/health/ready`.
10. **Validate the deployed application** (§3).

## 3. Post-deployment validation

Use a throwaway account and delete it at the end.

1. `curl -sI https://<domain>/` → `200`, with `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; `curl -sI https://<domain>/some/deep/link` → `200` (SPA fallback); `curl -sI https://<domain>/assets/<hashed file>.js` → `Cache-Control` long-lived.
2. `curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/api/subscriptions` → `401`. `curl -sI http://<domain>/` → redirects to `https://`.
3. In a browser: register. In the developer tools, the cookie `__Host-sc_sid` must be `Secure`, `HttpOnly`, `SameSite=Lax`, path `/`, no Domain. No CSP violations in the console.
4. Settings → Account says "Not verified. Verification is unavailable because this server has no email provider" (if SMTP is off). Reminders page says email is unavailable. These are the honest states.
5. Add a subscription, record a payment, open Calendar and Analytics; each loads.
6. Rate-limit sanity (TRUST_PROXY check): from a *second network* or device, sign in successfully, then fail a login 10 times for a made-up email on the first device and confirm the second device is **not** blocked. If both are blocked, `TRUST_PROXY` or the proxy's `X-Forwarded-For` handling is wrong.
7. Wait one scheduler interval; the API log shows `scheduler_cycle` with counts and no `scheduler_task_failed`.
8. Settings → Delete account (password + typed email). Confirm you land on sign-in with the "permanently deleted" notice.
9. Stop the database briefly (or block the port): `/api/health/ready` returns `503` and `/api/health` stays `200`; restore it and readiness recovers without restarting the API. *Not verified* on a managed provider.
10. Record the date, commit and results of this checklist.

## 4. Reverse proxy

Requirements, whatever software you use:
- Terminate TLS; redirect `http` → `https`.
- Serve `apps/web/dist`; unknown non-`/api` paths fall back to `index.html`; hashed `/assets/*` cacheable for a year; `index.html` not cached.
- Forward `/api/*` (and only that) to `127.0.0.1:3001`.
- Set the security headers from RELEASE.md ("Web hosting headers").
- **Overwrite, never append, `X-Forwarded-For`** with the real client address. With `TRUST_PROXY=1` the API trusts the last hop, and a proxy that appends a client-supplied header lets anyone pick their own rate-limit identity.
- Do not log query strings or request/response headers containing cookies (§6).
- Optionally restrict access (decision 2).

**Caddy** (tested with Caddy 2.11.7 in a Linux container, using `localhost` and its internal CA instead of the public host name: the config validates; security headers, SPA fallback, the asset cache header, `X-Forwarded-For` overwritten with the connection address, and the access log shows `/verify-email?token=REDACTED`; not tested with a public certificate or in production. Caddy does not log credentials unless you enable `log_credentials`):
```
app.example.com {
  encode zstd gzip
  header {
    Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    X-Content-Type-Options nosniff
    Referrer-Policy no-referrer
    X-Frame-Options DENY
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
  }
  handle /api/* {
    reverse_proxy 127.0.0.1:3001
  }
  handle {
    root * /srv/subcycle/apps/web/dist
    @assets path /assets/*
    header @assets Cache-Control "public, max-age=31536000, immutable"
    header /index.html Cache-Control "no-cache"
    try_files {path} /index.html
    file_server
  }
  log {
    output file /var/log/caddy/subcycle.access.log
    format filter {
      wrap json
      request>uri query {
        replace token REDACTED
      }
    }
  }
}
```

**nginx** (config tested with nginx 1.22 in a Linux container: syntax, headers on every response type, SPA fallback, asset caching, `X-Forwarded-For` overwrite, and a token-free access log; not tested with a public certificate or in production). Put the headers in a snippet and include it in the server **and in every `location` that sets its own `add_header`**, because nginx drops inherited `add_header` lines as soon as a `location` defines one:
```
# /etc/nginx/snippets/subcycle-headers.conf
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy no-referrer always;
add_header X-Frame-Options DENY always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```
```
log_format subcycle '$remote_addr [$time_local] "$request_method $uri $server_protocol" $status $body_bytes_sent';  # $uri has no query string
server {
  listen 443 ssl;  server_name app.example.com;      # add "http2 on;" on nginx >= 1.25.1
  # ssl_certificate / ssl_certificate_key ...
  access_log /var/log/nginx/subcycle.access.log subcycle;
  root /srv/subcycle/apps/web/dist;
  include snippets/subcycle-headers.conf;
  location /api/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;      # overwrite; NOT $proxy_add_x_forwarded_for
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  location /assets/ { include snippets/subcycle-headers.conf; add_header Cache-Control "public, max-age=31536000, immutable"; try_files $uri =404; }
  location / { include snippets/subcycle-headers.conf; add_header Cache-Control "no-cache"; try_files $uri /index.html; }
}
server { listen 80; server_name app.example.com; return 301 https://$host$request_uri; }
```
The API adds its own security headers to `/api/*` responses, so those responses carry two sets (the stricter combination applies); harmless. In nginx's log a SPA deep link is recorded as `/index.html` (internal redirect), so its path is not logged at all; the token cannot be either way.

## 5. Backups and restoration (NOT configured: this is the specification to implement)

**Status: no backup system exists.** `scripts/verify-backup-restore.mjs` is only a rehearsal on throwaway databases (RELEASE.md). Do not state that data is backed up until every item below is in place **and** a restore drill has passed.

| Aspect | Recommendation | Notes |
|---|---|---|
| Frequency | provider automated snapshot **daily** + continuous WAL / point-in-time recovery; plus a **logical dump nightly** (`pg_dump -Fc`) to storage under a different account/region | PITR gives minutes of data loss at worst; the dump protects against provider-level failure and lets you restore into any PostgreSQL 16 |
| Retention | PITR window 7–14 days; dumps: 14 daily, 8 weekly, 6 monthly | **Your retention bounds how long a deleted account persists.** The delete dialog already says backups can retain data; publish the longest retention |
| Encryption | provider encryption at rest for snapshots; dumps encrypted **before** leaving the host (e.g. `age` or `gpg`, key kept separately from the backups) | dumps contain password hashes, email addresses and financial notes |
| Access | backup storage write-only from the DB host where possible; restore keys held by a different person/account | |
| Alerting | a dead-man's-switch check (e.g. a healthcheck URL pinged after each successful dump + upload) that alerts if no success within 26 h; alert on provider backup failures; alert on `/api/health/ready` failing for 2 minutes | an unmonitored backup job fails silently |
| Restore drill | quarterly, and after every change to the backup process, into a scratch database, with the checks below | a backup that has never been restored is not a backup |

**Restoration steps (into a NEW database; never over the live one)**
1. Provision a scratch database and role (as §2 step 2). Fetch the chosen backup and decrypt it.
2. `pg_restore --no-owner --exit-on-error -d <scratch url> subcycle.dump` (for PITR, use the provider's restore-to-new-instance feature).
3. Check row counts and a few known records; run `node apps/api/dist/db/migrate-cli.js` against it (must say up to date or apply pending migrations).
4. Start an API instance against it **on a different port, with the scheduler disabled** (`SCHEDULER_ENABLED=false`) so it cannot send reminders, and run the §3 checks.
5. **Re-apply account deletions** made since the backup (restoring revives deleted accounts). Decide how you will know which: SubCycle keeps no record of deleted accounts. Options: a private log of deletion requests (date + a salted hash of the email, not the email itself) kept by the operator.
6. Only then cut over (point `DATABASE_URL` at the restored database, or restore into the live instance during a maintenance window) and note the data-loss window.

## 6. Keeping verification tokens out of logs

- **Application logs:** the API logs only the request *path* (query string dropped), never bodies, cookies or headers; the confirmation request carries the token in a POST body, not in a URL. **Verified** (`log-hygiene.test.ts`, `error-handling.test.ts`).
- **Proxy logs:** the emailed link is `https://<domain>/verify-email?token=…`, which the **proxy** serves. Use the configurations in §4 (nginx logs `$uri`, not `$request_uri`; Caddy's `query … replace token`). Check the first access log lines after deployment: no `token=` must appear. Also check any CDN, WAF, load balancer or analytics layer in front of the proxy, which may log full URLs on its own.
- **Browser and referrers:** the page sets `Referrer-Policy: no-referrer` (meta tag and header), so the token is not sent to other sites. The token remains in the browser history of whoever clicked; it is single-use and expires after 24 hours.
- Email stays disabled until the manual provider test passes, so no tokens exist in a first deployment.

## 7. Current limitations (state these to anyone you invite)

- **Password reset needs email.** Without a provider, a lost password with no session = the operator runs `admin:reset-link` (OPERATIONS.md). There is no email change.
- **Rate limits are per process** (in memory): they reset on restart and would multiply across instances. **Run one API instance only.**
- **Single-instance topology.** The scheduler lock prevents overlapping cycles if a second process ever starts, but that was verified only within one process; rate limits and everything else assume one instance.
- **Real SMTP is not verified.** Email stays off until the manual test in RELEASE.md passes.
- **Registration is open** unless you restrict access at the proxy.
- **Reminders only run while the API runs;** after downtime, missed ones are recorded as missed, not sent late, and never treated as payments.
- SubCycle tracks only what users type. It does not connect to banks or providers, cannot see real charges and cannot cancel anything.
- No Firefox/WebKit testing, no manual screen-reader pass, no TLS-enforced database test, no managed-provider test, no test under a real systemd or with in-flight requests during shutdown.

## 7a. Outbound network access

The link lookup on the add form makes HTTPS requests (port 443) from the API host to the sites users paste. Allow that egress if you want it. If your host blocks outbound traffic, the feature degrades gracefully (names derived from the address; known services still recognised locally) and nothing else is affected. It cannot reach private addresses even if the host can (see SECURITY.md). It is rate limited to 20 lookups per user per minute.

## 8. Deployment checklist (print this)

- [ ] Decisions 0.1–0.5 made and written down
- [ ] Domain + TLS working
- [ ] PostgreSQL 16 created, role owns DB, TLS required, network restricted
- [ ] Automated backups + PITR on; manual snapshot taken; alerting set up
- [ ] `DATABASE_URL` password generated and stored in the secret store only
- [ ] Release commit checked out; `npm ci`, `npm run build`, (`npm prune --omit=dev`)
- [ ] `apps/web/dist` published; proxy config applied with overwrite-XFF and query-free logs
- [ ] Migrations run twice (applied, then "up to date")
- [ ] API running under a restarting supervisor, **one instance**; no unexplained `config_warning`
- [ ] `/api/health` and `/api/health/ready` OK locally and through the proxy
- [ ] §3 validation passed and recorded; throwaway account deleted
- [ ] External uptime check on `/api/health/ready`
- [ ] First restore drill into a scratch database passed
- [ ] Access restriction decided and applied (or open registration consciously accepted)
- [ ] Email still disabled (or manual provider test passed and recorded)
- [ ] Egress policy for the pasted-link lookup decided (allow 443 outbound, or block and accept host-derived names)
