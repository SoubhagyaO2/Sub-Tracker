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
- Password reset is described in its own section below.

## Password reset
- **Tokens:** 256-bit random, only the SHA-256 is stored (`password_reset_tokens`, migration 0004), single use, valid for one hour, one live token per user (a newer request deletes the older), deleted with the user and tidied up opportunistically. Confirming uses a row lock, so two parallel requests cannot both succeed.
- **No account enumeration:** the request endpoint answers the same `202` for known and unknown addresses; the email is sent after the response; the only variation is the server-wide `503` when email is not configured, which is the same for every address. Limits count requests per submitted address (hashed, never logged) and per client.
- **Link hygiene:** the token is in the URL *fragment* (`/reset-password#token=...`), so it never reaches the API, a reverse-proxy access log or a `Referer`. The page reads it, removes it from the address bar and history (`replaceState`), and only then sends it, in a POST body, which the API does not log. The emails contain no other credential.
- **On success:** the password is replaced, **all sessions are deleted** (an attacker with a stolen session loses it), all reset tokens are removed, nobody is signed in automatically, and a notice without a link is mailed. A refused password (policy) does not consume the link.
- **Operators:** `admin:reset-link` needs the server's own database access and prints a link; treat it like a password and give it only to the account's owner. It is not available over the network.
- **Limits:** whoever controls the account's email inbox can take the account (as with every email-based reset); there is no second factor. Email delivery has not been exercised against a real provider (see Known gaps).

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

## User-uploaded pictures (optional)
- Only PNG, JPEG and WebP; **SVG is not accepted** (it can carry script). The server reads the file's own header to confirm the type matches the label and to read the pixel size (at most 1024 x 1024, at most 40 KB), rejecting anything else. The browser also re-encodes the picture to 128 x 128, which strips metadata and guarantees a plain raster image; the server never relies on that.
- Stored in PostgreSQL, owner-only (`404` for anyone else, same as a missing subscription), deleted with the subscription / account.
- Served from the same origin with `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, `Cache-Control: private` (so a shared cache never stores one user's picture), and a version token in the URL. The app's own CSP (`img-src 'self' data:`) is unchanged: pictures are same-origin and the in-form preview uses a `data:` URL (no `blob:`).
- Users can upload an image that is offensive or infringes someone's rights; it is visible only to that user, so there is no moderation surface. If images ever become shareable, that changes.

## Known gaps
- Rate-limit counters are per process.
- No automated browser security tests (CSP is configured on the API; Stage 9 is expected to add end-to-end coverage).
- Email change, MFA and active-session listing are not implemented. (Password reset is implemented; see above.)
- Email delivery has not been exercised against a real SMTP provider.
