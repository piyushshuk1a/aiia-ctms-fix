# AYUSETU — authenticated CTMS prototype

**One workspace for Ayush clinical research · Team Pathfindersz**

This is the server-authenticated extension of the existing AYUSETU prototype. Its navy-and-emerald UI, three fictional studies, five sites, clinical validations, and connected research workflows are retained. Identity is now verified by the backend; the unrestricted role selector is removed.

**Run this project through its Python server. The previously supplied standalone `AYUSETU.html` is the older browser-only prototype and does not gain authentication from this update. A static HTTP server is not sufficient.**

## Start the isolated synthetic demonstration

Prerequisites: Python 3.11 or later and Node.js 18 or later available on PATH. The implementation was executed with Python 3.13 and Node.js 22.16.0. The compiled client and server domain module are included; npm installation is not required to run them. Python packages must be installed once.

From the extracted `ayusetu-auth` directory, on macOS/Linux:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python scripts/init_env.py
python -m server.run
```

On Windows PowerShell:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python scripts/init_env.py
python -m server.run
```

Open **http://127.0.0.1:5173/login** in a browser. Use that exact host rather than alternating between `localhost` and `127.0.0.1`; cookies and CSRF checks are origin-specific. Stop the server with Ctrl+C. After setup, ordinary demonstration workflows require no internet connection, API key, email account, or paid service.

`init_env.py` creates a private `.env` with a fresh server-only random signing secret. It does not overwrite an existing file. **Do not publish `.env`, the runtime database, or this demo as an internet-accessible service.** `.env.example` contains no signing key or delivery secret.

The default server binds only to loopback. Demo accounts and the mock outbox are enabled only when both `DEMO_MODE=true` and `ISOLATED_SYNTHETIC=true`. Keep the instance isolated and synthetic-only. These public credentials are deliberately unsuitable for a real-data deployment.

## Seven demo accounts

All seven start with the publicly disclosed test password:

```text
AyuSetu-Demo-2026!
```

| Account | Workspace after sign-in | Assigned scope | OTP |
|---|---|---|---|
| `pi@ayusetu.test` | Overview | All three studies | No |
| `coordinator@ayusetu.test` | Participants & Visits | AYU-001, Delhi only | No |
| `monitor@ayusetu.test` | Monitoring | AYU-001 | No |
| `ethics@ayusetu.test` | Compliance tracking | Review access across all three studies | No |
| `pv@ayusetu.test` | Safety | Safety review across all three studies | Yes |
| `admin@ayusetu.test` | Administration | Portfolio/account configuration; no automatic clinical decision authority | Yes |
| `regulator@ayusetu.test` | Reports | De-identified, read-only clinical access across all three studies | No |

The demo picker on `/login` only prefills email/password. Click **Sign in** to verify them. Changing an account's password does not update the publicly documented initial password or picker: use the changed password afterward. Restarting the server does not reset passwords, activation, assignments, or trial changes.

For Administrator and PV: submit the password, open **Open isolated demo outbox**, and copy that challenge's fresh six-digit code into the OTP form. Verification is still performed on the server. The label is explicit: **“OTP delivery simulated — not independent MFA.”** No real email/SMS is sent in the default configuration. Codes expire after five minutes, allow five attempts, and have a 30-second resend cooldown. A replacement invalidates the previous code without resetting attempts or extending the original challenge deadline.

## What is backend-enforced

FastAPI serves the UI and same-origin API. Starlette's authentication middleware, `argon2-cffi` Argon2id, and `itsdangerous` signed opaque credentials support an application-specific SQLite session policy. There is no JWT and no competing browser identity authority.

Accounts, password hashes, revocable sessions, token digests, clinical records, and security history stay on the server. The browser receives only its permitted clinical projection; the client bundle contains no full seed dataset or local clinical repository. Role, actor ID, and assignments are resolved from the verified account for every protected operation. Search, assistant queries, exports, and document downloads use the same access boundary.

The Coordinator cannot retrieve another site's participant by changing an ID. Regulator clinical writes return an error even when called directly. Administrator access does not grant PI lifecycle, Ethics decision, or PV review permissions. Administrative access changes revoke existing sessions and challenges immediately; the UI checks live access on focus and periodically while visible.

### Session defaults

| Policy | Default |
|---|---:|
| Access credential | 15 minutes |
| Normal absolute session lifetime | 8 hours |
| Inactivity timeout | 30 minutes |
| Remembered absolute session lifetime | 7 days, still subject to inactivity |
| Recovery/setup link | 15 minutes; single use |

Cookies are HttpOnly and SameSite=Lax; Secure is mandatory when configured for HTTPS. Normal cookies are session cookies; remembered cookies have an explicit lifetime bounded by the absolute session deadline. CSRF tokens and same-origin checks protect cookie-authenticated writes. Refresh credentials rotate; reuse of a spent credential revokes the session. Refresh does not extend inactivity or the absolute lifetime. Real server time governs authentication; the fixed clinical clock governs reproducible clinical due dates and demo calculations.

Logout revokes the server session, clears its cookies, aborts pending client requests, and discards user-scoped records and assistant history. Shared clinical changes remain. A failed network sign-out is not reported as a success: the UI warns that server revocation is unconfirmed and offers **Retry sign out**.

## Passwords and account management

Use **Forgot password?** to request recovery. Known and unknown email addresses get the same neutral acknowledgement. In this isolated demo, open the browser-scoped outbox to follow the one-time link. Raw recovery tokens are not returned by the ordinary recovery API or stored in logs/SQLite; only their digests are stored. Links use a URL fragment, which the form consumes into memory and removes from the address bar. Reloading that reset form loses its in-memory token; reopen the original unexpired link.

New passwords must match and contain 15–1,024 characters. Spaces and passphrases are supported; passwords are not trimmed, normalized, or silently truncated. Reset and own-password change revoke sessions and outstanding recovery/OTP challenges. A new login, including any required OTP, is mandatory.

The signed-in profile menu contains **Profile / Security** and **Sign out**, not a privilege selector. Regulator users can manage their own password while remaining clinically read-only.

Administrator → **Accounts & access** supports creating staff accounts, sending one-time setup links, editing roles/scopes, activating/deactivating accounts, and inspecting restricted security history. New accounts have no default password. There is no public signup. The final active Administrator cannot disable or demote themselves. Scope changes require valid trial/site associations and an audit reason.

## Preserved clinical demonstration

The initial shared scenario contains **190/400 enrolled**, 208 total participant records, five unique sites, seven active trial-site associations, and one pending AYU-002 Jaipur association. Enrollment of eligible **SCR-001** at AYU-001 Delhi requires consent v2.0; it increases AYU-001 **96 → 97**, portfolio **190 → 191**, and the Coordinator's permitted Delhi total **48 → 49**. The three generated protocol visits, related action, and authenticated audit event are committed together. Repeat enrollment is idempotent.

The existing safety, independent PV review, monitoring/query handoff, readiness/activation, document decisions, action queue, reports, deterministic assistant, and validated sample EDC import remain available. The assistant and risk model remain deterministic demonstrations, not an LLM or validated predictive model.

**Clinical reset:** sign in as Administrator, complete OTP, open **Administration → Workspace settings → Reset demo**, then type `RESET`. This restores clinical seed records and removes uploaded clinical document content. It preserves account passwords/status/assignments, clinical audit history, and restricted security history. It is not a password-reset shortcut.

See [the six-minute walkthrough](docs/DEMO_WALKTHROUGH.md).

## Persistence, configuration, and troubleshooting

`runtime/ayusetu.sqlite3` is created on first start, using SQLite WAL mode. Keep `.env` and the database together across restarts. Do not regenerate the signing key each time. The isolated mock delivery outbox is intentionally process-memory-only; after a restart request a new OTP/recovery link. SQLite preserves changed accounts and clinical records; seeding is one-time and non-destructive.

A database containing seeded demo accounts is rejected when demo mode is disabled. Use a separate empty database for non-demo engineering; that configuration does not provision a login automatically and is not a ready-made real-data deployment. Never enable demo credentials or the mock outbox alongside real records.

Changing ports requires updating `APP_ORIGIN` in `.env`; the runner uses that port. Non-loopback origins require HTTPS and secure cookies, with TLS provided by a separately configured trusted reverse proxy. This package does not configure that proxy. The local runner does not trust forwarded-IP headers.

A 429 response means a persistent server throttle is active; obey `Retry-After` rather than repeatedly submitting. Five attempts per identity and a separate aggregate IP limit bound the login route. Wrong, unknown, or disabled accounts share a generic error. Specific reasons appear only in restricted security history.

All deployment parameters are listed in `.env.example`; further constants are in `server/config.py`. Optional SMTP delivery uses STARTTLS and server-only credentials. **SMTP delivery was not exercised in this environment.** With a configured provider, the development outbox is unavailable.

## Build and tests

To edit/rebuild the UI, install the development compiler once:

```bash
npm install
npm run build
```

The build creates a full server-only `build/domain.cjs` and a separate `build/app.js` without seed data or `LocalRepository`. The server explicitly allowlists public assets; it does not expose the project directory, source files, database, or `.env`.

Executed verification: **39 domain tests, 104 API tests, and 28 browser-driven scenario checks passed.** See [the detailed test report](docs/TEST_REPORT.md) and the retained `test-results` evidence.

```bash
python -m pip install -r requirements-test.txt
node --test tests/domain.test.cjs
python -m pytest tests/test_auth_api.py -q
python tests/browser_auth.py
```

Browser tests require Chromium. Install Playwright's browser with `python -m playwright install chromium`, or set `CHROMIUM_PATH` to an installed Chromium executable. The default test mode uses a real HTTP backend with a browser transport/router adapter because this sandbox blocks native browser URL navigation. The server, password verification, OTP, permissions, SQLite writes, and downloads are real; the cookie jar is held by the test HTTP client. **Native browser cookie policy, origin navigation, CSP execution, and real back/forward-cache restoration were not verified here.** An optional `python tests/browser_auth.py --native` path is supplied for an unrestricted browser environment; it was not executed successfully in this sandbox.

## Boundaries

This is a local synthetic-data prototype, not a hosted deployment, a validated clinical system, or a security/compliance certification. SQLite contains a serialized normalized clinical state, not a full PostgreSQL clinical schema. A single-process Node bridge reuses existing domain validations. The legacy bundled React 16.0.0 / ReactDOM 16.0.1 runtime is retained from the original app and needs replacement and review before product deployment.

Production work includes supported dependency upgrades, authentication and threat-model review, verified MFA/delivery, proper secret/key rotation, infrastructure/TLS/proxy design, migration/backup/retention controls, independent access-control and penetration testing, native-browser and accessibility validation, audit governance, and clinical/regulatory validation. Data integration and regulatory submission remain simulated; no therapeutic, legal-compliance, or model-accuracy claims are made.

Implementation details: [architecture](docs/ARCHITECTURE.md), [test report](docs/TEST_REPORT.md), [third-party notices](THIRD_PARTY_NOTICES.md).
