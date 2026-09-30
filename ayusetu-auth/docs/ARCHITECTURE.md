# AYUSETU implementation architecture — authentication extension

## Actual runtime

The existing TypeScript domain model and React 16 class-component interface are preserved. A new **FastAPI / Starlette backend with persistent SQLite** now serves the application. There is no Next.js server, PostgreSQL database, hosted deployment, browser-only mock authentication, external identity provider, or JWT implementation in this delivery.

The authentication integration uses Starlette `AuthenticationMiddleware`/`AuthenticationBackend`, `argon2-cffi` `PasswordHasher` (Argon2id), and `itsdangerous` purpose-separated signed opaque credentials. Application-specific session, recovery, OTP, throttling, and authorization policy is implemented in `server/security.py`. These policies are custom application code, not a claim that a packaged identity provider has validated the complete system. There is one authoritative identity source: the server account registry.

## Components and trust boundary

| Component | Responsibility |
|---|---|
| `server/config.py` | Server-only environment settings; rejects missing secrets, ambiguous origins, insecure non-loopback HTTP and non-isolated demo flags |
| `server/database.py` | SQLite schema, WAL connections, transactions, append-only security-log triggers |
| `server/security.py` | Password verification; account/session identity; CSRF; permission/scope helpers; OTP; recovery; rotating credentials; restricted events |
| `server/clinical.py` | Allowlisted clinical operations, request validation, authoritative scope projection, report/document access, regulator redaction |
| `server/domain_worker.cjs` | Local Node subprocess bridge to the original TypeScript clinical state machine; no user-supplied JavaScript execution |
| `src/domain.ts` | Existing normalized domain entities, deterministic seed, clinical gates, derived metrics, reports and assistant logic |
| `src/auth-service.ts` | Typed safe identity/session API client, cancellation and generation guards, expiry handling, server repository adapter |
| `src/auth-ui.tsx` | Login, OTP, forgot/reset, verified profile/security, account administration and pre-render session gate |
| `src/ui.tsx` | Preserved CTMS workspace; all writes/downloads/search/assistant calls use the same-origin backend |
| `scripts/build.cjs` | Separates the server's full domain module from the browser's selector-only module |

SQLite has independent tables for accounts, sessions, spent refresh credentials, OTP challenges, recovery digests, throttle counters, security events and seed metadata. Clinical entities remain normalized inside one serialized JSON state row with a revision counter. This preserves the original transactional workflow behavior without pretending to provide a production relational clinical schema.

The server loads the clinical state, overlays account-controlled staff roles/assignments, validates a requested operation and scope, invokes the domain worker, and commits the resulting state/audit together. A failed clinical gate does not partially enroll a participant or create only part of a workflow. Serialized SQLite transactions and enrollment's existing idempotency check prevent duplicate enrollment/visits. Node is invoked with fixed executable/script arguments and JSON on stdin; no shell command or method name outside the allowlist is accepted.

The browser retains only its permitted state in memory. `build/app.js` contains no seed function, `LocalRepository`, full clinical dataset or demo password. Only explicit asset routes are public; the server does not mount the project root, runtime directory, source tree, `.env`, or database. Source in the downloadable project remains available to the project owner, but is not served by the running web application.

## Authentication and cookies

`/api/auth/bootstrap` supplies a signed CSRF token and public configuration. The CSRF token is an anti-forgery value, not an access credential. Its matching cookie is HttpOnly; the JS value is kept in memory. Writes require a matching valid token, a permitted origin, and, for an authenticated session, its bound token digest. Cross-site fetch writes are rejected.

Login normalizes email consistently with account creation/recovery. Password bytes are not trimmed, Unicode-normalized, or silently truncated. The seed hashes the public test password with distinct Argon2 salts. Unknown users take a dummy Argon2 verification path. Incorrect passwords, unknown accounts and disabled accounts share the same normal failure response; restricted security events retain the specific reason. A persistent identity throttle plus aggregate IP throttle and bounded retry delay limit attempts. The local runner disables forwarded-header trust.

Successful non-OTP login creates a server session with a stable user ID, random session ID, version, creation/absolute/inactivity timestamps and CSRF digest. The access and refresh cookies contain independently generated signed random opaque values. The SQLite session stores their digests, not their raw values. These are **not JWTs**: no JWT algorithm, issuer or audience validation is claimed or applicable. Signature purpose, account version, revocation state and all expiry limits are verified against the server registry.

Defaults: 15-minute access credential; eight-hour normal absolute session; 30-minute inactivity; seven-day optional remembered absolute session. The remembered checkbox changes cookie/session behavior, not merely UI text. Cookies are HttpOnly, SameSite=Lax, and Secure under HTTPS; remembered cookies receive a bounded Max-Age. Normal cookies remain session cookies, with the same server-enforced lifetime limits even if a browser restores session cookies after restart.

Refresh rotates access/refresh values atomically and records the spent refresh digest. Reusing a spent refresh credential revokes that session. Refresh cannot restore revoked sessions or extend their original absolute lifetime, and it does not count as activity. The client serializes refresh and uses same-origin Web Locks where available to reduce competing-tab rotations. Without that browser capability, conservative replay rejection may require a fresh login during a concurrent refresh race.

The auth clock is `time.time()` (real server time), independent of the fixed clinical demo clock. Visible UI activity can update inactivity; session lookup, refresh and background checks do not. Client-side timers are a convenience, never authority. API operations re-read the account/session in the transaction so a role/status change between middleware and mutation cannot bypass revocation.

## OTP and delivery

`OTP_ROLES` defaults to Admin and PV. Password verification for these accounts creates a restricted challenge cookie and SQLite row, not access/refresh cookies or a clinical session. A fresh six-digit value is generated with `secrets`; its HMAC digest is bound to the challenge ID and account version. Verification is atomic, five-attempt-limited, single-use and five-minute-limited. Resend waits 30 seconds, invalidates the previous code, and does not reset attempts or extend the original deadline. Changing account access or passwords invalidates pending challenges.

With SMTP configured, delivery uses a STARTTLS SMTP connection and server-only credentials. No SMTP delivery was tested here. Without a provider, delivery is allowed only in the isolated synthetic demo. The outbox is memory-only, keyed to an HttpOnly signed browser-context ticket; OTP messages additionally require the matching live challenge. An unrelated browser cannot list those messages. The UI explicitly says **“OTP delivery simulated — not independent MFA.”** Anyone operating that isolated demo browser can view its code; this is a demonstration challenge, not independent second-factor assurance.

Outbox entries disappear on server restart. The database retains only OTP/reset digests. A resend/recovery request is needed after restart. Raw codes and reset links are excluded from security events and ordinary API results. The separately labeled demo outbox is the intentional development-only delivery exception.

## Recovery and accounts

Recovery/setup tokens use cryptographically random values and are user-bound, 15-minute, single-use records with only digests in SQLite. Neutral recovery acknowledgements do not disclose account existence. A reset link carries its token in a fragment (not an HTTP query); the UI immediately removes the fragment and keeps the token in memory only. The new password policy is 15–1,024 characters with matching fields and no composition/trim/truncation rules. Reset consumes the token, replaces the Argon2 hash, increments account version, and revokes existing sessions and outstanding recovery/OTP challenges. It never skips the next required OTP.

Account creation and role/site assignment are Administrator-only operations. New accounts have no initial password and must follow an explicit setup link. There is no public signup or client-assigned role. Access updates require a reason and valid, nonduplicated trial/site memberships; they revoke the target's sessions/challenges. The last active Administrator is protected from removal. Own-password change uses the verified actor, requires the current password, and accepts no role field. Regulator users retain access to that personal credential operation without acquiring clinical mutation privileges.

The seven demo accounts are inserted only once, under both explicit isolation flags. Seed metadata prevents later startups from overwriting changed accounts. The application rejects reusing that seeded demo database with demo mode off. The non-demo configuration is a development boundary, not a turnkey real-data deployment or automatic account provisioning mechanism.

## Access control and clinical data

`requireSession()`, `requirePermission()` and `requireTrialSiteAccess()` are server-side helpers. Browser roles/actor IDs are never authorization inputs. Strict Pydantic models reject extra request identity fields; operation-specific allowlists reject mass-assigned fields, unsupported methods, unexpected argument shapes and oversize inputs. Source IDs resolve to server records before role/scope checks and domain validation.

PI has all three demo studies; Coordinator has only AYU-001 Delhi; Monitor has AYU-001; Ethics/PV have relevant cross-study review access. Administrator does not automatically gain PI lifecycle, Ethics approval or PV review authority. Regulator clinical writes are rejected server-side. APIs, search, assistant, document download and CSV/JSON export share the same permitted projection. A denied direct participant request does not expose another site's record.

For the Regulator, the server withholds participant/visit narratives, newly entered case free text, uploaded document narratives, query correction values, deviation text, and clinical audit before/after/free-text fields. It retains synthetic codes, structured status/counts, and review metadata. This is conservative field withholding for synthetic data, **not a validated automatic de-identification pipeline**. Staff labels used for accountability are not treated as participant identifiers.

Partial scopes use permitted trial/site targets so the Delhi Coordinator sees 48/70 initially and 49/70 after enrollment, not another site's denominator. Whole-portfolio accounts reconcile 190/400 → 191/400. Reports are generated on the server from current authorized records; CSV values beginning with spreadsheet formula characters are escaped.

## Endpoint responsibilities

All writes below require CSRF. Protected endpoints additionally require a current verified session and the relevant role/scope.

| Method/path | Responsibility |
|---|---|
| `GET /api/auth/bootstrap` | Public CSRF/config bootstrap; no clinical data |
| `POST /api/auth/login` | Normalize identity, throttle, verify Argon2, issue session or limited OTP challenge |
| `GET /api/auth/session` | Restore safe user/session from current access cookie without extending idle |
| `POST /api/auth/activity` | Record verified user activity for inactivity policy |
| `POST /api/auth/refresh` | Rotate a live refresh credential; enforce replay/revocation/expiry |
| `POST /api/auth/logout` | Revoke current browser session and clear cookies |
| `GET /api/auth/otp` | Inspect only the current pre-authentication challenge's remaining policy |
| `POST /api/auth/otp/verify` | Attempt-limited, single-use challenge verification |
| `POST /api/auth/otp/resend` | Cooldown-enforced replacement code |
| `POST /api/auth/forgot-password` | Neutral recovery acknowledgement and configured delivery |
| `POST /api/auth/reset-password` | Consume a delivered token, set password, revoke sessions/challenges |
| `POST /api/auth/change-password` | Authenticated own-password change; no role editing |
| `GET /api/auth/security` | Own recent security events |
| `GET /api/records[/{kind}/{id}]` | Current permitted records; direct-ID access cannot enlarge scope |
| `POST /api/operations` | Allowlisted, validated clinical transactions using the server actor |
| `GET /api/search`, `POST /api/assistant` | Search/deterministic responses over authorized scope |
| `GET /api/exports`, `GET /api/documents/{id}/download` | Authorized current reports/text; no-store downloads |
| `GET/POST /api/admin/accounts`, `PATCH /api/admin/accounts/{id}` | Administrator registry creation/access management |
| `POST /api/admin/accounts/{id}/setup-link` | Explicit setup/recovery delivery for a staff account |
| `GET /api/admin/security-log` | Restricted security history |
| `GET /api/demo/accounts`, `GET /api/demo/outbox` | Public demo credentials / context-bound mock delivery only in isolated demo mode |

## Logout, cache and restoration

Protected data is not persisted in browser storage. Legacy synthetic-state keys are removed. Client generation counters and abort controllers discard obsolete account responses. Logout unmounts the old repository, clears assistant/dialog/search state and broadcasts an account change to other tabs. A request error does not display a success toast. Logout network failure clears local state but visibly reports unconfirmed server sign-out.

The server sends no-store/no-cache on HTML, API results, downloads and public assets. Frame embedding is denied; referrers, MIME sniffing, unneeded browser capabilities and script sources are restricted by headers. Client page/focus/session checks handle restoration, but **native back/forward-cache behavior and cookie/CSP execution were not verified in this sandbox**. The test report states the exact browser adapter limitation. Server-side revocation remains authoritative even when a client display has not yet received its next periodic check.

## Audit and reset

New clinical audit actors are taken from the verified server account; original clinical audit structures remain in the persistent clinical state. Restricted security events use real server timestamps and never include passwords, OTPs, raw access/refresh values or raw recovery tokens. SQLite triggers deny security-log updates/deletes through normal application connections. This does not make SQLite or a machine administrator tamper-proof.

A confirmed clinical reset restores the seed scenario but preserves accounts, changed passwords/status/assignments, existing clinical audit, and restricted security events. It appends a reset event. It does not silently recover an account or reset security history.

## Preserved domain calculations and simulations

The clinical clock remains 28 September 2026, 09:30 IST. Enrollment, overdue visits/queries, actions, recruitment charts and source-linked risk derive from records. The operational index is:

`50 × clamp(1 − actual/expected, 0, 1) + 30 × overdueVisits/max(visitsDue,1) + 20 × overdueUnresolvedQueries/max(allUnresolvedQueries,1)`

Expected enrollment is derived from the site's planned recruitment interval. The score is bounded 0–100; missing inputs are not fabricated. Rule contributions are not SHAP values or probabilities. Potential safety patterns remain descriptive and require PV review. The assistant uses deterministic query handlers over current permitted state, not an LLM. Clinical consent/ethics records, deadlines, EDC/FHIR/CDISC previews and regulatory reporting remain explicitly synthetic/unvalidated; nothing is transmitted to a regulator.

## Remaining engineering boundaries

The shipped React/ReactDOM versions are legacy and require upgrading/review. The SQLite JSON state and per-request Node subprocess are a prototype adapter, not a scalable production data layer. Mock delivery is single-process. Threat modeling, native-browser/MFA testing, TLS/proxy infrastructure, credential/key rotation, load/concurrency testing, migrations, backup/restore, retention, accessibility, independent penetration testing and clinical/regulatory governance are still required. No certification or production-security conclusion follows from the executed tests.

Primary library documentation: https://www.starlette.io/authentication/ ; https://argon2-cffi.readthedocs.io/en/stable/api.html ; https://itsdangerous.palletsprojects.com/en/stable/ . These document the components, not the correctness of this application-specific authentication policy.
