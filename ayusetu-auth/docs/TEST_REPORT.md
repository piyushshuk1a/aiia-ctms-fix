# AYUSETU authentication extension — executed verification

## Result

| Suite / activity | Executed result |
|---|---|
| TypeScript client build and server-domain transpilation | Passed; generated browser bundle excludes the seed function, local repository and public demo password |
| Existing domain suite (`node --test tests/domain.test.cjs`) | **39 passed, 0 failed, 0 skipped** |
| FastAPI / SQLite / Node API suite (`python -m pytest tests/test_auth_api.py -q`) | **104 passed** |
| Chromium UI with real HTTP backend and transport/router adapter (`python tests/browser_auth.py`) | **28 scenario checks passed; zero JavaScript page errors** |
| Clean extracted distribution / actual HTTP startup smoke | **9 checks passed**; fresh local secret/database; prebuilt artifacts |
| Native browser URL-navigation probe | **Blocked by environment policy** (`ERR_BLOCKED_BY_ADMINISTRATOR`) |

Counts describe tests actually completed, not planned coverage. An earlier combined build/API/browser command hit its execution time limit; the complete browser suite was then rerun separately and passed all 28 checks. The retained text/JSON reports are the completed runs.

## Environment and method

Executed with Python 3.13, Node.js 22.16.0, TypeScript 5.8.3, FastAPI 0.128.2, Starlette 0.50.0, Uvicorn 0.48.0, argon2-cffi 25.1.0, itsdangerous 2.2.0, Pydantic 2.13.4, pytest 9.0.2, HTTPX 0.28.1 and Playwright 1.57.0 with installed Chromium. React 16.0.0 and ReactDOM 16.0.1 are the retained original vendored runtimes.

The API tests use isolated SQLite files, actual Argon2id hashing/verification, actual authentication/permission code, and the actual Node clinical domain worker. A controlled authentication clock exercises expiry boundaries without pretending to have waited eight hours or seven days. Test retry delays are disabled to keep the suite practical; persistent throttle counts/status/Retry-After behavior are asserted. The runtime itself uses bounded delays and real server time.

The browser suite starts a real Uvicorn server with a fresh temporary SQLite database. Chromium runs the compiled UI and vendored React. Because managed browser policy blocks all native URL navigation, the default harness forwards browser `fetch` calls to that server through an HTTPX cookie jar and uses a virtual location/history adapter. It does **not** replace server password checking, OTP generation/verification, session policy, database writes, scope filtering, exports, or clinical validation with mock success results. The network-failure scenario deliberately injects a transport failure and verifies that no login success is shown.

**Important limitation:** the adapter does not validate native browser cookie enforcement, actual same-origin navigation, browser execution of CSP headers, true full-page reload behavior, cross-tab Web Locks/BroadcastChannel races, or real back/forward-cache restoration. HTTP cookie/header behavior and expiry/revocation logic are tested at the API boundary; the UI remount test restores a real server session through the test HTTP cookie jar. That is not described as a successful native-browser refresh test. A `--native` test path is supplied for an unrestricted environment, but the full native suite was not executed here. No managed policy was changed or bypassed.

## API/security coverage

All seven seeded accounts authenticate and receive the correct home/workspace and assigned scope. Wrong passwords, unknown accounts, disabled accounts and malformed input do not authenticate. Email normalization is consistent; password whitespace and long passphrases are preserved. The Argon2id seed is hashed, the demo picker does not establish a session, and non-demo configurations do not expose demo accounts/outbox. A seeded demo database cannot be reused with demo mode off, and origin/isolation misconfigurations are rejected.

Protected URLs and APIs reject unauthenticated access. Login and authenticated writes enforce CSRF. Extra actor/role fields and operation-object mass assignment are rejected. Cookie attributes, no-store headers, internal redirect allowlists, public asset allowlists, tampered signatures, normal/remembered expiry, idle timeout, background-check inactivity, rotation, replay revocation, logout and reload/session lookup are exercised. Refresh cannot extend the session's absolute deadline or restore a revoked session.

Admin and PV cannot skip OTP. Incorrect, expired, exhausted, replaced and reused codes fail; cooldown and attempt ceilings persist. OTP messages are challenge/browser scoped, and pre-authentication cookies cannot access clinical APIs. Recovery acknowledgements are neutral, raw tokens are delivered only through the explicit demo channel, reset tokens are user-bound/expiring/single-use, old credentials fail after reset, and existing sessions/challenges are invalidated. Required OTP remains required. A Regulator can change their own password without gaining clinical authority.

Account creation produces an unset password and one-time setup link. Activation/deactivation, role changes and valid site/trial changes affect existing sessions immediately. Invalid scope updates do not partially apply, and the final active Administrator cannot be removed. Security history is restricted, free of raw credentials/OTP/reset values in tested flows, and protected against update/delete through SQLite application access. Seeding and ordinary restarts preserve account and clinical changes. Clinical reset preserves credentials, assignments and both audit histories.

Coordinator direct-ID and query-scope tampering cannot expose another site's participants. Regulator clinical writes are rejected; Administrator cannot perform PI/Ethics/PV decisions merely through their administrative role. Unstructured regulator narrative and audit values are withheld by the server. Source-linked enrollment, consent, three visits, idempotency, 190→191 totals and actor identity are tested, along with serious-event/task creation, independent PV review, query handoff, site readiness, committee decisions, document download, current scoped CSV/JSON exports and validated atomic EDC import.

## Completed browser scenarios

1. Login-first desktop renders with no protected data before verification.
2. Injected network failure is distinct from invalid credentials and never reports successful login.
3. Show-password control and generic failed login do not grant access.
4. PI login opens Overview and preserves the 190/400 baseline without a role selector.
5. Existing source-linked Varanasi operational-risk drawer remains functional.
6. Coordinator lands on Participants & Visits with AYU-001 Delhi-only records.
7. Consent gate, recorded consent, enrollment, three visits and server audit work through UI.
8. UI remount restores server identity and the persisted enrollment through the session endpoint.
9. Seriousness criterion is mandatory; UI safety capture creates the urgent PV action.
10. Monitor landing and coordinator-to-monitor query handoff preserve independent review.
11. PV password verification creates only a limited challenge; wrong OTP cannot load clinical records.
12. OTP-verified PV account completes its authorized clinical review with authenticated audit identity.
13. Ethics landing, committee decision history, and server-authorized document download work in UI.
14. Site readiness gates, evidence recording, and gated activation remain intact.
15. Server-authorized assistant reflects 191/400 and links current supporting records.
16. Regulator lands on Reports; de-identified audit and scoped CSV download work while direct writes return 403.
17. Regulator can change their own password without privilege controls; sessions revoke and new login works.
18. Overlong pasted passwords remain intact in the input and are rejected explicitly, never silently truncated.
19. Forgot/reset screens use a single-use delivered link, enforce matching passwords, and require normal login.
20. OTP-verified Admin creates scoped account; setup link sets a password without a default or public signup.
21. Administrative account status changes and restricted security history render and persist.
22. All eleven clinical and administration destinations render without desktop page overflow.
23. Admin reset requires confirmation and restores clinical baseline without erasing audit or account changes.
24. All eleven destinations fit a 390px mobile viewport with contained table scrolling.
25. Mobile assistant dialog traps keyboard focus and Escape dismisses it.
26. Logout removes prior-user UI and assistant history before another scoped account signs in on mobile.
27. Editing the browser user role does not grant backend administrative access.
28. Browser-driven journey completes without JavaScript page errors.

## Corrections made during verification

The initial scoped-export worker attempted to instantiate a full-state repository from already-permitted data; it now uses read-only domain selectors for read/export work. The password-reset UI now bootstraps a fresh CSRF value after cookie clearing. Login/password and account-role controls received explicit accessible names. The login story heading contrast and mobile synthetic-demo label were corrected. Password inputs retain overlong pasted text and reject it explicitly rather than using a truncating HTML maximum-length attribute; 1,024-character acceptance and 1,025-character rejection are also covered by the API suite. These fixes are included in the completed build and subsequent runs.

## Evidence and limits

`test-results/build.txt`, `domain-tests.txt`, `api-tests.txt`, `browser-auth-log.txt`, `browser-auth-results.json` and `native-navigation-check.json` and `clean-package-smoke.json` contain retained evidence. Actual synthetic document/CSV/JSON browser downloads and selected desktop/mobile screenshots are included. No runtime database, real signing secret, session cookie jar, live OTP screenshot or `.env` is included in the distribution.

SMTP delivery, real email/SMS, independent MFA assurance, production deployment/TLS, trusted proxy behavior, multi-worker operation, load/penetration testing, comprehensive accessibility conformance, cross-browser coverage and clinical/regulatory validation were not tested. The findings establish the exercised prototype behaviors, not production security, legal compliance, certification or complete absence of defects.
