# SubCycle security notes (implemented through Stage 8)

What is enforced today and where. Stage references are to the build stages; see `docs/SPEC.md` §7 for the full design and `docs/OPERATIONS.md` for runtime behaviour.

## Authentication and sessions
- Passwords: Argon2id (19 MiB, t=2, p=1), length 10-128, common-password and own-email checks; unknown emails are verified against a dummy hash to blunt timing differences. Existing hashes are upgraded on login when parameters change.
- Sessions: server-side rows; only the SHA-256 of a 32-byte random token is stored. httpOnly, SameSite=Lax cookie (`__Host-` prefix and Secure in production). Sliding 14-day idle and absolute 30-day expiry. The token is never readable by page script and never stored by the web app.
- **Session fixation:** a new token is minted on register, login **and password change**; the previous cookie is invalidated each time.
- **Session invalidation (Stage 8):**
  - logout: the current session only;
  - password change: **all** sessions are deleted and one fresh session is issued, atomically;
  - account deletion: all sessions are deleted with the account;
  - expiry: purged by the scheduler; an expired session already fails authentication.
- CSRF: every state-changing request needs `X-SubCycle-Client: web` and an allowed `Origin`.

## Sensitive actions (Stage 8)
- Password change and account deletion re-authenticate with the password. Deletion additionally needs the account's email typed.
- A wrong current password on these routes returns **422 with a field error, never 401**: the caller is already authenticated, the answer says nothing about any other account, and the web client does not mistake it for an ended session.
- Failed confirmations are limited per user (successes are not counted), so a stolen session cannot be used to guess the password. The counter is in memory (per instance).
- Concurrent password changes: optimistic check on the stored hash; one wins, the other gets `409`.
- No password reset by email in v1 (agreed scope).

## Data and logging
- Every query is parameterised; ownership is part of every `WHERE`. A test pins the only places SQL text is composed.
- Logs carry ids, counts and error classes. Passwords, hashes, session tokens, verification tokens, email addresses, notes and message bodies are redacted or never passed (tests capture logs while exercising failures).
- Deletion is a real `DELETE` with cascades; backups are outside application control (see OPERATIONS.md).

## Errors and logging (Stage 10)
- 5xx responses are generic and carry a `requestId`; the cause is never returned. Logs record only error class, machine code, schema identifier names and stack frames, never messages or data (`apps/api/src/errorLog.ts`, enforced in the logger and the HTTP logger; regression tests in `error-handling.test.ts`).
- SMTP uses mandatory STARTTLS (or implicit TLS); production refuses to disable it.
- The unauthenticated readiness route has its own rate limit.

## Outbound requests: the pasted-link lookup (`POST /api/link-preview`)
This is the only place the server contacts an address a user typed, so it is built against server-side request forgery (`apps/api/src/services/linkPreview.ts`, tested in `link-preview.test.ts`):
- https and port 443 only; no credentials in the URL; IP-address hosts and internal-looking names refused before any DNS lookup.
- **Every** address a name resolves to must be globally routable (loopback, RFC 1918, link-local including the cloud metadata address, CGNAT, multicast, reserved, IPv4-mapped / NAT64 / 6to4 / Teredo IPv6 and unique-local ranges are refused). The check runs inside the socket's own DNS lookup, so the connection can only go to an address that passed it: a name cannot change its answer between check and connect.
- Redirects are followed by hand (at most 3) and each hop is validated again; a redirect to a private or non-https target is a refusal, not a fetch.
- 4 s timeout, 256 KB cap (reading stops at `</head>`), HTML only, no cookies / authorization / referrer sent, no connection reuse.
- Needs a session; 20 lookups per user per minute; the address is neither logged nor stored; refusals use one fixed message so the endpoint cannot be used to map the internal network.
- Verified live once against real sites: `example.com`, `wikipedia.org` and `github.com` return their site names; `localtest.me` (a public name that resolves to 127.0.0.1) is refused; a name that does not exist and a site with an invalid certificate fall back to a host-derived name.
- **Operational note:** the API host needs outbound HTTPS (port 443) for this feature. If egress is blocked the feature degrades to host-derived names; it never fails the form. A deployment that wants zero outbound requests can block egress; known services are still recognised locally.
- **Limits:** this is a name lookup, not a security scanner. A malicious public site can return any title it likes; the UI shows it as a suggestion to check, and React renders it as plain text.

## Known gaps
- Rate-limit counters are per process.
- No automated browser security tests (CSP is configured on the API; Stage 9 is expected to add end-to-end coverage).
- Email change, MFA and active-session listing are not implemented.
- Email delivery has not been exercised against a real SMTP provider.
