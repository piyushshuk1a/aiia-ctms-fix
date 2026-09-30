# AYUSETU — six-to-seven-minute authenticated walkthrough

Start the backend and open `http://127.0.0.1:5173/login`. Use only synthetic records. For a repeatable starting point, sign in as Administrator, complete its fresh OTP, and use **Administration → Workspace settings → Reset demo → RESET**. Reset preserves credentials, assignments and security history; it does not restore a password you previously changed.

All seven original accounts start with `AyuSetu-Demo-2026!`. The demo picker prefills the form only. **Change personas by Profile menu → Sign out → Sign in**, never by selecting arbitrary privileges.

| Time | Demonstration | Evidence |
|---|---|---|
| 0:00–1:00 | Sign in as `pi@ayusetu.test`. Confirm Overview, 190/400, and open Varanasi through search/site records. | Existing 60.3 rule-based index with actual recruitment, overdue-visit and query contributions. The client did not load clinical records before session verification. |
| 1:00–2:20 | Sign out; sign in as `coordinator@ayusetu.test`. Open `SCR-001`, attempt enrollment before consent, then record consent v2.0 and enroll. | The first action is blocked. The authorized action creates three visits and an audit event. The Coordinator sees Delhi only: 48/70 → 49/70. AYU-001 becomes 97 and the portfolio 191 for broader-scope accounts. Repeating enrollment does not duplicate it. |
| 2:20–3:20 | Open existing participant `AYU-001-S1-001` and report a serious event. Use a fictional description, independent severity, and a recorded seriousness criterion. | Missing criterion is blocked. Successful submission creates `AE-011`, an urgent PV task and notification. Coordinator cannot perform the PV review. |
| 3:20–4:30 | Sign out; sign in as `pv@ayusetu.test`. Open the isolated demo outbox, copy this challenge's code, and verify. Open `AE-011`; request Follow-up Required with rationale. | Password verification alone never opens the workspace. The OTP delivery label says it is simulated, not independent MFA. The completed PV action records the verified actor and retains follow-up work. |
| 4:30–5:30 | Sign out; return as PI. Ask the demo assistant “Prepare a recruitment summary.” Then ask which sites need attention and open a supporting record. | The server-derived answer uses 191/400 and current permitted records. No static answer, LLM integration or clinical recommendation is implied. |
| 5:30–6:30 | Sign out; sign in as `regulator@ayusetu.test`. Reports opens automatically. Inspect Audit, then select AYU-001 / Varanasi and export Recruitment CSV. | Audit is read-only and sensitive narrative fields are withheld. The scoped CSV contains 18 Varanasi participant rows. Regulator has no clinical-write privilege, including through direct API calls. |

## Optional authentication checks

On `/login`, demonstrate password visibility, keyboard submission and a generic failed login. Selecting a demo account does not bypass verification. An Administrator/PV account must complete a fresh challenge; wrong codes fail, resend waits 30 seconds and invalidates the previous code. The outbox is intentionally visible only in this isolated demo and is not a second independent factor.

For recovery, sign out, choose **Forgot password?**, enter an account email and open the labeled outbox. Follow the one-time link, enter matching new passphrases, then sign in normally. Reset links are removed from the URL into form memory; reloading the form requires reopening the original link. The previous password and reused token fail. Admin/PV still require OTP after reset.

Sign in as Administrator and open **Accounts & access**. Create a fictional staff account with AYU-001 / Delhi scope. Follow its one-time setup link to choose a password. Return as Administrator to deactivate it or change assignments with a reason. A disabled account cannot authenticate, and access changes revoke existing sessions. Administrator's existing role does not authorize PI, Ethics or PV clinical decisions.

For personal security, any account—including Regulator—can open **Profile / Security** and change its own password using the current password. Saving signs the account out and revokes its other sessions. There is no editable personal role field.

## Close the demonstration

Sign out. Shared trial changes remain in SQLite for the next account. Closing/restarting the server preserves clinical and account changes; the isolated in-memory outbox does not survive restart. Use the confirmed clinical reset for a new clinical demonstration, not deletion of the database or regeneration of `.env`.

This demonstration shows backend-enforced prototype behavior. It does not establish production security, clinical validation, delivery-provider operation, legal compliance or certification.
