"use strict";
/** AYUSETU: synthetic-only, deterministic local repository.
 * All writes pass through one transactional service; scoped reads never return raw store records.
 * Browser persistence and role switching are NOT production security controls.
 */
var Ayu;
(function (Ayu) {
    Ayu.VERSION = 1;
    Ayu.STORAGE_KEY = 'ayusetu.synthetic.v1';
    Ayu.CLOCK = '2026-09-28T04:00:00.000Z';
    Ayu.ROLE_NAMES = { PI: 'Principal Investigator', Coordinator: 'Study Coordinator', Monitor: 'Clinical Trial Monitor', Ethics: 'Ethics Committee', PV: 'Pharmacovigilance Officer', Admin: 'Administrator', Regulator: 'Regulator' };
    const PERMISSIONS = {
        screen: ['Coordinator'], eligibility: ['PI', 'Coordinator'], consent: ['Coordinator'], enroll: ['Coordinator'], visit: ['Coordinator'], safetyCreate: ['Coordinator', 'PI', 'PV'], pvReview: ['PV'], reportPrepare: ['PV'], queryAnswer: ['Coordinator'], queryVerify: ['Monitor'], deviation: ['Monitor'], document: ['PI', 'Coordinator', 'Admin'], ethicsDecision: ['Ethics'], compliance: ['PI', 'Coordinator', 'Admin'], readiness: ['PI', 'Admin'], activateSite: ['PI', 'Admin'], createTrial: ['PI', 'Admin'], lifecycle: ['PI'], assign: ['PI', 'Admin'], import: ['Admin'], settings: ['Admin'], reset: ['Admin'], patternReview: ['PV']
    };
    class DomainError extends Error {
        constructor(message, fields = {}) { super(message); this.name = 'DomainError'; this.fields = fields; }
    }
    Ayu.DomainError = DomainError;
    Ayu.vals = (m) => Object.values(m);
    Ayu.clone = (x) => JSON.parse(JSON.stringify(x));
    function day(offset = 0) { return new Date(Date.parse(Ayu.CLOCK) + offset * 86400000).toISOString().slice(0, 10); }
    Ayu.day = day;
    function addDays(date, n) { return new Date(Date.parse(date) + n * 86400000).toISOString().slice(0, 10); }
    Ayu.addDays = addDays;
    function formatDate(date) {
        if (!date)
            return 'Not recorded';
        return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(date.length === 10 ? date + 'T04:00:00Z' : date));
    }
    Ayu.formatDate = formatDate;
    function dateValid(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d; }
    Ayu.dateValid = dateValid;
    function overdue(r, clock = Ayu.CLOCK) { return ['Scheduled', 'Open', 'Answered', 'Submitted', 'Pending', 'Under Review', 'Follow-up Required'].includes(r.status) && r.due < clock.slice(0, 10); }
    Ayu.overdue = overdue;
    Ayu.can = (user, op) => !!user && PERMISSIONS[op].includes(user.role);
    function inScope(s, u, r, scope = {}) {
        if (scope.trialId && r.trialId && scope.trialId !== r.trialId)
            return false;
        if (scope.siteId && r.siteId && scope.siteId !== r.siteId)
            return false;
        if (!r.trialId)
            return u.role === 'Admin';
        const as = Ayu.vals(s.assignments).filter(a => a.userId === u.id && a.trialId === r.trialId);
        return as.some(a => !r.siteId || a.siteIds.includes(r.siteId));
    }
    Ayu.inScope = inScope;
    function scoped(s, userId, scope = {}) {
        const u = s.users[userId];
        if (!u)
            throw new DomainError('Unknown demo identity.');
        const o = Ayu.clone(s);
        const scopedMaps = ['participants', 'consents', 'visits', 'safety', 'compliance', 'documents', 'queries', 'deviations', 'actions', 'audit', 'interventions', 'trialSites'];
        for (const map of scopedMaps)
            o[map] = Object.fromEntries(Ayu.vals(s[map]).filter(r => inScope(s, u, r, scope)).map(r => [r.id, Ayu.clone(r)]));
        o.trials = Object.fromEntries(Ayu.vals(s.trials).filter(t => inScope(s, u, { trialId: t.id }, scope) && (!scope.siteId || Ayu.vals(o.trialSites).some(ts => ts.trialId === t.id && ts.siteId === scope.siteId))).map(t => [t.id, Ayu.clone(t)]));
        const siteIds = new Set(Ayu.vals(o.trialSites).map(ts => ts.siteId));
        o.sites = Object.fromEntries(Ayu.vals(s.sites).filter(r => siteIds.has(r.id)).map(r => [r.id, Ayu.clone(r)]));
        o.assignments = Object.fromEntries(Ayu.vals(s.assignments).filter(a => u.role === 'Admin' || a.userId === u.id).map(a => [a.id, Ayu.clone(a)]));
        o.integrations = u.role === 'Admin' ? Ayu.clone(s.integrations) : {};
        o.viewScope = scope;
        o.viewTarget = Ayu.vals(o.trials).reduce((n, t) => { const visible = Ayu.vals(o.trialSites).filter(ts => ts.trialId === t.id); const all = Ayu.vals(s.trialSites).filter(ts => ts.trialId === t.id); return n + (!scope.siteId && (s.permittedTrialTargets || visible.length === all.length) ? (s.permittedTrialTargets?.[t.id] ?? t.target) : visible.reduce((v, ts) => v + (ts.target || 0), 0)); }, 0);
        // Identity directory contains only synthetic staff labels, never participant identity fields.
        return o;
    }
    Ayu.scoped = scoped;
    function base(id, status, owner = 'u-pi', trialId, siteId) { return { id, status, owner, trialId, siteId, createdAt: Ayu.CLOCK, updatedAt: Ayu.CLOCK }; }
    Ayu.base = base;
    function metrics(s, scope = s.viewScope || {}) {
        const match = (r) => (!scope.trialId || r.trialId === scope.trialId) && (!scope.siteId || r.siteId === scope.siteId);
        const ts = Ayu.vals(s.trialSites).filter(match);
        const trialIds = new Set(ts.map(t => t.trialId));
        return { enrolled: Ayu.vals(s.participants).filter(p => match(p) && !!p.enrolledAt).length, target: scope.siteId ? ts.reduce((n, t) => n + (t.target || 0), 0) : (s.viewTarget ?? Ayu.vals(s.trials).filter(t => (!scope.trialId || t.id === scope.trialId) && (!scope.siteId || trialIds.has(t.id))).reduce((n, t) => n + t.target, 0)), trials: Ayu.vals(s.trials).filter(t => (!scope.trialId || t.id === scope.trialId) && t.status !== 'Closed').length, uniqueSites: new Set(ts.filter(t => t.status === 'Active').map(t => t.siteId)).size, activeAssociations: ts.filter(t => t.status === 'Active').length, overdueVisits: Ayu.vals(s.visits).filter(v => match(v) && overdue(v, s.clock)).length, safetyReviews: Ayu.vals(s.safety).filter(c => match(c) && !['Reviewed', 'Closed'].includes(c.status)).length, serious: Ayu.vals(s.safety).filter(c => match(c) && c.serious).length, ae: Ayu.vals(s.safety).filter(match).length, complianceOverdue: Ayu.vals(s.compliance).filter(c => match(c) && overdue(c, s.clock)).length, queries: Ayu.vals(s.queries).filter(q => match(q) && q.status !== 'Closed').length };
    }
    Ayu.metrics = metrics;
    function risk(s, ts) {
        const match = (r) => r.trialId === ts.trialId && r.siteId === ts.siteId;
        const enrollment = Ayu.vals(s.participants).filter(p => match(p) && !!p.enrolledAt).length;
        const due = Ayu.vals(s.visits).filter(v => match(v) && v.status !== 'Cancelled' && v.due <= s.clock.slice(0, 10));
        const late = due.filter(v => overdue(v, s.clock));
        const open = Ayu.vals(s.queries).filter(q => match(q) && q.status !== 'Closed');
        const lateQ = open.filter(q => overdue(q, s.clock));
        const expected = ts.expectedToDate;
        const rc = expected === null ? 0 : expected === 0 ? 0 : 50 * Math.max(0, Math.min(1, 1 - enrollment / expected));
        const vc = 30 * late.length / Math.max(due.length, 1);
        const qc = 20 * lateQ.length / Math.max(open.length, 1);
        const score = expected === null ? null : Math.min(100, Math.max(0, rc + vc + qc));
        return { score, band: score === null ? 'Insufficient data' : score >= 60 ? 'High' : score >= 30 ? 'Watch' : 'Low', enrollment, expected, visitsDue: due.length, lateVisits: late.length, openQueries: open.length, lateQueries: lateQ.length, contributions: [{ label: 'Recruitment shortfall', points: rc, max: 50, formula: `50 × clamp(1 − ${enrollment} / ${expected ?? 'unknown'}, 0, 1)` }, { label: 'Overdue visits', points: vc, max: 30, formula: `30 × ${late.length} / max(${due.length}, 1)` }, { label: 'Overdue unresolved queries', points: qc, max: 20, formula: `20 × ${lateQ.length} / max(${open.length}, 1)` }] };
    }
    Ayu.risk = risk;
    function trialBlockers(s, t) {
        const b = [];
        if (!t.protocol || !t.protocolVersion)
            b.push('Protocol identifier and version');
        if (t.iecStatus !== 'Approved' || t.iecExpiry < s.clock.slice(0, 10))
            b.push('Valid recorded ethics approval');
        if (!t.registration || t.registration === 'Not recorded')
            b.push('Configured registration status');
        if (!t.staffTrained)
            b.push('Trained / assigned staff');
        if (!Ayu.vals(s.trialSites).some(ts => ts.trialId === t.id && ts.status === 'Active'))
            b.push('At least one active, ready trial-site');
        return b;
    }
    Ayu.trialBlockers = trialBlockers;
    function closeoutBlockers(s, trialId) {
        const m = (r) => r.trialId === trialId;
        const b = [];
        const v = Ayu.vals(s.visits).filter(r => m(r) && ['Scheduled', 'Missed'].includes(r.status)).length;
        const q = Ayu.vals(s.queries).filter(r => m(r) && r.status !== 'Closed').length;
        const c = Ayu.vals(s.safety).filter(r => m(r) && r.status !== 'Closed').length;
        const d = Ayu.vals(s.documents).filter(r => m(r) && ['Draft', 'Submitted', 'Changes requested'].includes(r.status)).length;
        const cp = Ayu.vals(s.compliance).filter(r => m(r) && r.status !== 'Complete').length;
        if (v)
            b.push(v + ' outstanding visits');
        if (q)
            b.push(q + ' unresolved queries');
        if (c)
            b.push(c + ' safety cases not closed');
        if (d)
            b.push(d + ' documents awaiting review');
        if (cp)
            b.push(cp + ' open compliance items');
        return b;
    }
    Ayu.closeoutBlockers = closeoutBlockers;
    function assistant(s, question, scopeLabel) {
        const q = question.toLowerCase();
        const m = metrics(s);
        const items = [];
        let summary = '';
        let supported = true;
        if (/attention|sites|risk|why/.test(q)) {
            const sites = Ayu.vals(s.trialSites).filter(ts => ts.status === 'Active').map(ts => ({ ts, r: risk(s, ts) })).sort((a, b) => (b.r.score ?? -1) - (a.r.score ?? -1));
            for (const { ts, r } of sites.slice(0, 4))
                items.push({ text: `${s.sites[ts.siteId].city} · ${ts.trialId}: ${r.score === null ? 'insufficient data' : r.score.toFixed(1) + '/100'}; ${r.enrollment}/${r.expected ?? 'unknown'} expected-to-date, ${r.lateVisits} overdue visits, ${r.lateQueries} overdue queries.`, type: 'trialSite', id: ts.id });
            summary = 'Prioritized by the rule-based demo operational index, not probability or clinical prediction.';
        }
        else if (/serious|safety|sae/.test(q)) {
            const cases = Ayu.vals(s.safety).filter(c => c.serious && !['Reviewed', 'Closed'].includes(c.status));
            summary = `${cases.length} open serious-event review(s). Serious events are a subset of ${m.ae} adverse-event episodes in this scope.`;
            cases.forEach(c => items.push({ text: `${c.id}: ${c.term} · ${c.status}. Criterion: ${c.criterion}.`, type: 'safety', id: c.id }));
        }
        else if (/activation|blocking|readiness/.test(q)) {
            const ts = Ayu.vals(s.trialSites).filter(ts => ts.status !== 'Active');
            summary = `${ts.length} trial-site association(s) pending activation.`;
            ts.forEach(t => items.push({ text: `${t.id}: missing ${Object.entries(t.readiness).filter(([, v]) => !v).map(([k]) => k).join(', ') || 'no checklist evidence; activation decision pending'}. Target ${t.target ?? 'not assigned'}.`, type: 'trialSite', id: t.id }));
        }
        else if (/overdue|needs attention|deadline/.test(q)) {
            const tasks = Ayu.vals(s.actions).filter(a => a.status === 'Open' && a.due < s.clock.slice(0, 10));
            summary = `${tasks.length} overdue action(s); ${m.overdueVisits} overdue visits and ${m.complianceOverdue} overdue compliance item(s).`;
            tasks.slice(0, 8).forEach(a => items.push({ text: `${a.title} · due ${formatDate(a.due)}`, type: a.sourceType, id: a.sourceId }));
        }
        else if (/recruit|enroll|summary/.test(q)) {
            summary = `${m.enrolled}/${m.target} enrolled (${m.target ? (100 * m.enrolled / m.target).toFixed(1) : '0.0'}%) across ${m.trials} permitted trial(s).`;
            Ayu.vals(s.trials).forEach(t => { const n = Ayu.vals(s.participants).filter(p => p.trialId === t.id && p.enrolledAt).length; items.push({ text: `${t.id}: ${n} enrolled in permitted scope; trial target ${t.target}.`, type: 'trial', id: t.id }); });
        }
        else {
            supported = false;
            summary = 'This demo assistant supports operational attention, overdue work, serious-event reviews, site activation, and recruitment summaries. It cannot diagnose, prescribe, infer causality, or approve records.';
        }
        return { scope: scopeLabel, summary, items, supported };
    }
    Ayu.assistant = assistant;
    function report(s, kind) {
        switch (kind) {
            case 'Recruitment': return Ayu.vals(s.participants).map(p => ({ participant_id: p.id, study_code: p.code, trial_id: p.trialId, site_id: p.siteId, status: p.status, enrolled_at: p.enrolledAt || '' }));
            case 'Site performance': return Ayu.vals(s.trialSites).map(t => { const r = risk(s, t); return { association_id: t.id, trial_id: t.trialId, site_id: t.siteId, site: s.sites[t.siteId].city, status: t.status, enrolled: r.enrollment, target: t.target, rule_index: r.score?.toFixed(2) ?? 'Insufficient data', overdue_visits: r.lateVisits, overdue_queries: r.lateQueries }; });
            case 'Safety': return Ayu.vals(s.safety).map(c => ({ case_id: c.id, participant_id: c.participantId, trial_id: c.trialId, site_id: c.siteId, term: c.term, severity: c.severity, serious: c.serious, criterion: c.criterion, status: c.status, report_status: c.reportStatus }));
            case 'Compliance': return Ayu.vals(s.compliance).map(c => ({ id: c.id, trial_id: c.trialId, site_id: c.siteId || '', title: c.title, status: c.status, due: c.due, document_id: c.documentId }));
            case 'Audit': return Ayu.vals(s.audit).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(a => ({ id: a.id, timestamp: a.createdAt, actor: a.actor, role: a.role, entity_id: a.entityId, operation: a.operation, reason: a.reason, before: JSON.stringify(a.before), after: JSON.stringify(a.after) }));
            default: return [];
        }
    }
    Ayu.report = report;
    function csv(rows) {
        if (!rows.length)
            return '';
        const keys = Object.keys(rows[0]);
        const cell = (v) => {
            let t = v == null ? '' : String(v);
            if (/^[=+@\-\t\r]/.test(t))
                t = "'" + t;
            return '"' + t.replace(/"/g, '""') + '"';
        };
        return [keys.map(cell).join(','), ...rows.map(r => keys.map(k => cell(r[k])).join(','))].join('\r\n');
    }
    Ayu.csv = csv;
})(Ayu || (Ayu = {}));
/** Same-origin authentication client. Credentials/cookies are never copied to browser storage.
 * UI checks are only presentation. The FastAPI session and permission boundary is authoritative.
 */
var AyuAuth;
(function (AyuAuth) {
    class APIError extends Error {
        constructor(status, data, retryAfter = 0) { super(data.message || 'The request failed.'); this.name = 'APIError'; this.status = status; this.code = data.code || 'request_failed'; this.fields = data.fields || {}; this.retryAfter = retryAfter; }
    }
    AyuAuth.APIError = APIError;
    class AuthService {
        constructor() {
            this.current = null;
            this.csrf = '';
            this.config = null;
            this.generation = 0;
            this.listeners = [];
            this.controllers = new Set();
            this.refreshing = null;
            this.logoutUnconfirmed = false;
            this.channel = null;
            this.lastActivity = 0;
            this.activity = () => {
                if (!this.current || Date.now() - this.lastActivity < 60000)
                    return;
                this.lastActivity = Date.now();
                this.request('/api/auth/activity', { method: 'POST', body: '{}' }).then(r => { if (this.current)
                    this.current.session.idleExpiresAt = r.idleExpiresAt; }).catch(() => { });
            };
            this.checkLive = async () => {
                if (!this.current || document.visibilityState === 'hidden')
                    return;
                if (Date.now() / 1000 >= Math.min(this.current.session.absoluteExpiresAt, this.current.session.idleExpiresAt)) {
                    this.invalidate('Your session reached its inactivity or absolute time limit. Please sign in again.');
                    return;
                }
                try {
                    const result = await this.request('/api/auth/session', {}, false);
                    if (this.current && result.session.id !== this.current.session.id)
                        this.invalidate('The signed-in account changed. Checking session…');
                    else
                        this.apply(result);
                }
                catch (e) {
                    if (e.status === 401) {
                        try {
                            await this.refresh();
                        }
                        catch (err) {
                            if (err.status !== 0)
                                this.invalidate('Your session expired or access changed. Please sign in again.');
                        }
                    }
                }
            };
            try {
                this.channel = new BroadcastChannel('ayusetu-session-v2');
                this.channel.onmessage = () => this.invalidate('Session changed in another tab. Checking account…');
            }
            catch { }
            try {
                localStorage.removeItem('ayusetu.synthetic.v1');
                localStorage.removeItem('ayusetu.ui.v1');
            }
            catch { }
            document.addEventListener('pointerdown', this.activity, true);
            document.addEventListener('keydown', this.activity, true);
            window.addEventListener('pagehide', () => { if (this.current)
                this.invalidate('Checking session…'); });
            window.addEventListener('pageshow', (e) => { if (e.persisted)
                this.invalidate('Checking session…'); });
            window.addEventListener('focus', () => { if (this.current)
                this.checkLive(); });
            this.timer = setInterval(() => this.checkLive(), 15000);
        }
        subscribe(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(f => f !== fn); }; }
        abort() { this.generation++; for (const c of this.controllers)
            c.abort(); this.controllers.clear(); }
        invalidate(reason = 'Please sign in again.') { this.abort(); this.current = null; this.csrf = ''; this.listeners.forEach(fn => fn(reason)); }
        apply(result) { this.current = result; this.csrf = result.csrfToken; return result; }
        broadcast() { this.channel?.postMessage({ event: 'session_changed' }); }
        async request(path, init = {}, protectedCall = true, retry = true, raw = false) {
            const controller = new AbortController();
            this.controllers.add(controller);
            const epoch = this.generation;
            const headers = { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) };
            if (init.method && !['GET', 'HEAD'].includes(init.method))
                headers['X-CSRF-Token'] = this.csrf;
            let response;
            try {
                response = await fetch(path, { ...init, headers, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
            }
            catch (e) {
                if (e.name === 'AbortError')
                    throw new APIError(0, { message: 'Request cancelled.', code: 'cancelled' });
                throw new APIError(0, { message: 'Connection unavailable. No success has been confirmed. Check the connection and retry.', code: 'network_error' });
            }
            finally {
                this.controllers.delete(controller);
            }
            if (epoch !== this.generation)
                throw new APIError(0, { message: 'The account changed. This response was discarded.', code: 'cancelled' });
            if (response.status === 401 && protectedCall && retry) {
                try {
                    await this.refresh();
                    return await this.request(path, init, protectedCall, false, raw);
                }
                catch (e) {
                    if (e.status !== 0)
                        this.invalidate('Your session expired or access changed. Please sign in again.');
                    throw e;
                }
            }
            if (!response.ok) {
                let data;
                try {
                    data = await response.json();
                }
                catch {
                    data = { message: 'The server could not complete this request.' };
                }
                if (protectedCall && (response.status === 401 || data.code === 'csrf_failed'))
                    this.invalidate('Your session expired or access changed. Please sign in again.');
                throw new APIError(response.status, data, Number(response.headers.get('Retry-After') || 0));
            }
            const idle = Number(response.headers.get('X-Ayu-Idle-Expires') || 0);
            if (idle && this.current)
                this.current.session.idleExpiresAt = idle;
            return raw ? response : response.json();
        }
        async bootstrap() { this.config = await this.request('/api/auth/bootstrap', {}, false); this.csrf = this.config.csrfToken; return this.config; }
        async restore() {
            await this.bootstrap();
            try {
                return this.apply(await this.request('/api/auth/session', {}, false));
            }
            catch (e) {
                if (e.status !== 401)
                    throw e;
            }
            try {
                return await this.refresh();
            }
            catch (e) {
                if (e.status === 401 || e.status === 403)
                    return null;
                throw e;
            }
        }
        async refresh() {
            if (this.refreshing)
                return this.refreshing;
            const work = async () => {
                // Recheck under a same-origin cross-tab lock before rotating: another tab may have refreshed already.
                try {
                    return this.apply(await this.request('/api/auth/session', {}, false));
                }
                catch (e) {
                    if (e.status !== 401)
                        throw e;
                }
                return this.apply(await this.request('/api/auth/refresh', { method: 'POST', body: '{}' }, false));
            };
            const locks = navigator.locks;
            this.refreshing = (locks ? locks.request('ayusetu-refresh', work) : work()).finally(() => { this.refreshing = null; });
            return this.refreshing;
        }
        async login(email, password, remember, next) {
            const result = await this.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password, remember, next }) }, false);
            if (!result.otpRequired) {
                this.apply(result);
                this.broadcast();
            }
            return result;
        }
        async verify(code) { const result = await this.request('/api/auth/otp/verify', { method: 'POST', body: JSON.stringify({ code }) }, false); this.apply(result); this.broadcast(); return result; }
        async logout() {
            this.abort();
            try {
                await this.request('/api/auth/logout', { method: 'POST', body: '{}' }, false);
                this.logoutUnconfirmed = false;
                this.broadcast();
                this.invalidate('Signed out. Shared trial changes have been preserved.');
            }
            catch (e) {
                this.logoutUnconfirmed = true;
                this.invalidate('Server sign-out could not be confirmed. Reconnect and retry sign out before sharing this browser.');
                throw e;
            }
        }
        async changePassword(body) { const result = await this.request('/api/auth/change-password', { method: 'POST', body: JSON.stringify(body) }); this.broadcast(); this.invalidate(result.message); return result; }
        async file(path) { const response = await this.request(path, {}, true, true, true); const blob = await response.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = (response.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'AYUSETU-export.txt'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
    AyuAuth.AuthService = AuthService;
    AyuAuth.authService = new AuthService();
    class ServerRepository {
        constructor(data, actor, revision) {
            this.listeners = [];
            this.warning = '';
            this.data = data;
            this.actor = actor;
            this.revision = revision;
            const methods = ['screen', 'eligibility', 'consent', 'enroll', 'visit', 'safetyCreate', 'pvReview', 'prepareReport', 'answerQuery', 'verifyQuery', 'deviation', 'document', 'ethicsDecision', 'completeCompliance', 'readiness', 'activateSite', 'createTrial', 'configureTrial', 'lifecycle', 'assign', 'settings', 'patternReview', 'reset', 'validateImport', 'commitImport'];
            for (const op of methods)
                this[op] = async (_ignoredBrowserActor, ...args) => {
                    // Deliberately discard any caller-supplied identity. Only the session resolves the actor on the server.
                    if (op === 'reset')
                        args = ['RESET'];
                    const value = await AyuAuth.authService.request('/api/operations', { method: 'POST', body: JSON.stringify({ op, args }) });
                    this.data = value.state;
                    this.revision = value.revision;
                    this.listeners.forEach(fn => fn());
                    return value.result;
                };
        }
        subscribe(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(f => f !== fn); }; }
        view(_ignored, scope = {}) { return Ayu.scoped(this.data, this.actor.id, scope); }
        identities() { return Ayu.vals(this.data.users); }
        async reload() { const value = await AyuAuth.authService.request('/api/records'); this.data = value.state; this.revision = value.revision; this.listeners.forEach(fn => fn()); }
        dispose() { this.data = null; this.listeners = []; }
    }
    AyuAuth.ServerRepository = ServerRepository;
})(AyuAuth || (AyuAuth = {}));
var AyuAuthUI;
(function (AyuAuthUI) {
    const service = AyuAuth.authService;
    const roleNames = Ayu.ROLE_NAMES;
    function duration(seconds) { return seconds % 86400 === 0 ? (seconds / 86400) + ' days' : seconds % 3600 === 0 ? (seconds / 3600) + ' hours' : seconds % 60 === 0 ? (seconds / 60) + ' minutes' : seconds + ' seconds'; }
    const Logo = () => React.createElement("div", { className: "auth-brand" },
        React.createElement("span", { className: "auth-mark", "aria-hidden": "true" }, "\u2727"),
        React.createElement("div", null,
            React.createElement("strong", null,
                "AYU",
                React.createElement("span", null, "SETU")),
            React.createElement("small", null, "CLINICAL RESEARCH")));
    function Message({ text, error = false }) { return text ? React.createElement("div", { className: 'auth-message ' + (error ? 'error' : ''), role: error ? 'alert' : 'status' }, text) : null; }
    function navigate(path) { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }
    class Gate extends React.Component {
        constructor() {
            super(...arguments);
            this.state = { loading: true, error: '', notice: '', path: location.pathname, ready: null, config: null };
            this.attempt = 0;
            this.route = () => { const path = location.pathname; if (['/login', 'verify-otp', '/verify-otp', '/forgot-password', '/reset-password'].includes(path)) {
                service.abort();
                service.current = null;
                this.setState({ path, error: '', ready: null, loading: false });
                return;
            } this.setState({ path, error: '' }); if (service.current && !this.state.ready)
                this.loadWorkspace(service.current); };
            this.loadWorkspace = async (result) => {
                this.setState({ loading: true, ready: null, error: '' });
                try {
                    const records = await service.request('/api/records');
                    let path = result.destination || (location.pathname === '/login' ? new URLSearchParams(location.search).get('next') : null) || location.pathname;
                    if (!result.user.allowedPages.includes(path.slice(1)))
                        path = '/' + result.user.home;
                    history.replaceState({}, '', path);
                    this.setState({ loading: false, path, ready: { records, result }, notice: '' });
                }
                catch (e) {
                    this.setState({ loading: false, error: e.message, ready: null });
                }
            };
        }
        componentDidMount() { this.unsubscribe = service.subscribe(reason => { this.attempt++; this.setState({ ready: null, loading: false, notice: reason, error: '' }); if (reason.includes('Checking') || reason.includes('Checking'.toLowerCase())) {
            this.check();
        }
        else {
            history.replaceState({}, '', '/login');
            this.setState({ path: '/login' });
            service.bootstrap().then(config => this.setState({ config })).catch(e => this.setState({ error: e.message }));
        } }); window.addEventListener('popstate', this.route); this.check(); }
        componentWillUnmount() { this.unsubscribe?.(); window.removeEventListener('popstate', this.route); }
        async check() { const epoch = ++this.attempt; this.setState({ loading: true, ready: null, error: '' }); try {
            if (['/forgot-password', '/reset-password'].includes(location.pathname)) {
                const config = await service.bootstrap();
                service.current = null;
                this.setState({ loading: false, path: location.pathname, ready: null, config });
                return;
            }
            const session = await service.restore();
            if (epoch !== this.attempt)
                return;
            this.setState({ config: service.config });
            if (session)
                await this.loadWorkspace(session);
            else {
                const allowed = ['/login', '/verify-otp', '/forgot-password', '/reset-password'];
                const path = allowed.includes(location.pathname) ? location.pathname : '/login';
                history.replaceState({}, '', path + location.search + location.hash);
                this.setState({ loading: false, path, ready: null });
            }
        }
        catch (e) {
            if (epoch === this.attempt)
                this.setState({ loading: false, error: e.message, ready: null });
        } }
        render() {
            if (this.state.loading)
                return React.createElement("div", { className: "auth-loading" },
                    React.createElement(Logo, null),
                    React.createElement("span", { className: "auth-spinner" }),
                    React.createElement("h1", null, "Checking your workspace access"),
                    React.createElement("p", null, "No trial records are displayed until your session is verified."));
            const ready = this.state.ready;
            if (ready && service.current)
                return React.createElement(AyuUI.App, { key: ready.result.session.id, user: ready.result.user, records: ready.records.state, revision: ready.records.revision, initialPage: this.state.path.slice(1) });
            return React.createElement(AuthScreen, { key: this.state.path, path: this.state.path, config: this.state.config, error: this.state.error, notice: this.state.notice, onAuthenticated: this.loadWorkspace, onRetry: () => this.check() });
        }
    }
    AyuAuthUI.Gate = Gate;
    class AuthScreen extends React.Component {
        constructor(p) {
            super(p);
            this.state = { email: '', password: '', show: false, busy: false, error: '', message: '', code: '', remember: false, demo: null, outbox: null, otp: null, now: Date.now(), newPassword: '', confirmPassword: '', showNew: false };
            this.pending = false;
            this.token = '';
            this.mounted = true;
            this.run = async (fn) => { if (this.pending)
                return; this.pending = true; this.setState({ busy: true, error: '', message: '' }); try {
                await fn();
            }
            catch (e) {
                if (this.mounted && e.code !== 'cancelled')
                    this.setState({ error: e.message + (e.retryAfter ? ' Retry in ' + e.retryAfter + ' seconds.' : '') });
            }
            finally {
                this.pending = false;
                if (this.mounted)
                    this.setState({ busy: false });
            } };
            this.submit = (e) => {
                e.preventDefault();
                this.run(async () => {
                    const path = this.props.path;
                    if (path === '/verify-otp') {
                        const r = await service.verify(this.state.code);
                        await this.props.onAuthenticated(r);
                    }
                    else if (path === '/forgot-password') {
                        const r = await service.request('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: this.state.email }) }, false);
                        this.setState({ message: r.message, outbox: null });
                    }
                    else if (path === '/reset-password') {
                        if (Array.from(this.state.newPassword).length > 1024)
                            throw new Error('Use 15–1,024 characters. Passwords are never truncated.');
                        if (this.state.newPassword !== this.state.confirmPassword)
                            throw new Error('The passwords do not match.');
                        const r = await service.request('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token: this.token, newPassword: this.state.newPassword, confirmPassword: this.state.confirmPassword }) }, false);
                        this.token = '';
                        await service.bootstrap();
                        this.setState({ message: r.message, newPassword: '', confirmPassword: '', resetDone: true });
                        service.broadcast();
                    }
                    else {
                        const next = new URLSearchParams(location.search).get('next') || '';
                        const r = await service.login(this.state.email, this.state.password, this.state.remember, next);
                        this.setState({ password: '' });
                        if (r.otpRequired)
                            navigate('/verify-otp');
                        else
                            await this.props.onAuthenticated(r);
                    }
                });
            };
            this.outbox = () => this.run(async () => { const outbox = await service.request('/api/demo/outbox', {}, false); this.setState({ outbox }); });
            if (p.path === '/reset-password') {
                this.token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
                history.replaceState({}, '', '/reset-password');
            }
        }
        componentDidMount() {
            if (this.props.config?.demoMode)
                service.request('/api/demo/accounts', {}, false).then(demo => this.mounted && this.setState({ demo })).catch(() => { });
            if (this.props.path === '/verify-otp')
                service.request('/api/auth/otp', {}, false).then(otp => this.mounted && this.setState({ otp })).catch(e => this.mounted && this.setState({ error: e.message }));
            this.timer = setInterval(() => this.setState({ now: Date.now() }), 1000);
        }
        componentWillUnmount() { this.mounted = false; clearInterval(this.timer); this.token = ''; }
        render() {
            const path = this.props.path, login = path === '/login', otp = path === '/verify-otp', forgot = path === '/forgot-password', reset = path === '/reset-password';
            const title = otp ? 'Verify your sign-in' : forgot ? 'Reset your password' : reset ? 'Choose a new password' : 'Welcome back';
            const seconds = Math.max(0, Math.ceil(((this.state.otp?.resendAt || 0) * 1000 - this.state.now) / 1000));
            const config = this.props.config;
            return React.createElement("main", { className: "auth-page" },
                React.createElement("section", { className: "auth-story" },
                    React.createElement(Logo, null),
                    React.createElement("div", { className: "auth-story-body" },
                        React.createElement("span", { className: "auth-eyebrow" }, "ONE WORKSPACE. SHARED RESPONSIBILITY."),
                        React.createElement("h1", null,
                            "Research connected.",
                            React.createElement("br", null),
                            React.createElement("span", null, "Access considered.")),
                        React.createElement("p", null, "Bring your studies, evidence, and next steps together \u2014 in the workspace assigned to you."),
                        React.createElement("div", { className: "auth-principles" },
                            React.createElement("div", null,
                                React.createElement("b", null, "01"),
                                React.createElement("span", null, "Sign in with your verified staff account.")),
                            React.createElement("div", null,
                                React.createElement("b", null, "02"),
                                React.createElement("span", null, "See the trials and sites assigned to your role.")),
                            React.createElement("div", null,
                                React.createElement("b", null, "03"),
                                React.createElement("span", null, "Keep every clinical decision accountable.")))),
                    React.createElement("footer", null,
                        React.createElement("span", null, "Team Pathfindersz"),
                        React.createElement("small", null, "Synthetic research prototype \u00B7 Not a validated clinical system"))),
                React.createElement("section", { className: "auth-panel" },
                    React.createElement("div", { className: "auth-mobile-brand" },
                        React.createElement(Logo, null)),
                    React.createElement("div", { className: "auth-card" },
                        React.createElement("div", { className: "auth-card-top" },
                            React.createElement("span", { className: "auth-access-icon", "aria-hidden": "true" }, "\u21B3"),
                            React.createElement("span", { className: "demo-pill" },
                                React.createElement("i", null),
                                " Demo \u00B7 Synthetic data")),
                        React.createElement("div", { className: "auth-eyebrow" }, "AYUSETU / STAFF ACCESS"),
                        React.createElement("h2", null, title),
                        React.createElement("p", { className: "auth-subtitle" }, otp ? 'Your password was verified. Complete this challenge before any trial records become available.' : forgot ? 'Enter your account email to request a one-time recovery link.' : reset ? 'Use a long, unique passphrase. Spaces and password-manager generated passwords are supported.' : 'Sign in to your clinical research workspace.'),
                        React.createElement(Message, { text: this.state.error || this.props.error, error: true }),
                        React.createElement(Message, { text: this.state.message || this.props.notice }),
                        service.logoutUnconfirmed && React.createElement("button", { className: "btn danger", onClick: () => this.run(async () => { await service.bootstrap(); await service.logout(); }) }, "Retry sign out"),
                        this.props.error && !this.state.error && React.createElement("button", { className: "btn secondary", onClick: this.props.onRetry }, "Retry connection"),
                        React.createElement("form", { onSubmit: this.submit, "aria-busy": this.state.busy },
                            (login || forgot) && React.createElement("label", { className: "auth-field" },
                                React.createElement("span", null, "Email address"),
                                React.createElement("input", { type: "email", name: "email", autoComplete: "username", required: true, autoFocus: true, value: this.state.email, onChange: (e) => this.setState({ email: e.target.value }), placeholder: "you@research.example" })),
                            login && React.createElement(React.Fragment, null,
                                React.createElement("label", { className: "auth-field" },
                                    React.createElement("span", null, "Password"),
                                    React.createElement("div", { className: "password-control" },
                                        React.createElement("input", { name: "password", "aria-label": "Password", type: this.state.show ? 'text' : 'password', autoComplete: "current-password", required: true, value: this.state.password, onChange: (e) => this.setState({ password: e.target.value }) }),
                                        React.createElement("button", { type: "button", "aria-label": this.state.show ? 'Hide password' : 'Show password', onClick: () => this.setState({ show: !this.state.show }) }, this.state.show ? 'Hide' : 'Show'))),
                                React.createElement("div", { className: "auth-options" },
                                    React.createElement("label", null,
                                        React.createElement("input", { type: "checkbox", checked: this.state.remember, onChange: (e) => this.setState({ remember: e.target.checked }) }),
                                        " Remember this device"),
                                    React.createElement("button", { type: "button", className: "text-btn", onClick: () => navigate('/forgot-password') }, "Forgot password?")),
                                React.createElement("p", { className: "auth-policy" },
                                    "Up to ",
                                    duration(this.state.remember ? (config?.policy.rememberedSeconds || 604800) : (config?.policy.sessionSeconds || 28800)),
                                    " \u00B7 Signs out after ",
                                    duration(config?.policy.idleSeconds || 1800),
                                    " of inactivity.")),
                            otp && React.createElement(React.Fragment, null,
                                React.createElement("label", { className: "auth-field" },
                                    React.createElement("span", null, "Six-digit verification code"),
                                    React.createElement("input", { className: "otp-input", name: "code", autoComplete: "one-time-code", inputMode: "numeric", pattern: "[0-9]{6}", maxLength: 6, minLength: 6, autoFocus: true, required: true, value: this.state.code, onChange: (e) => this.setState({ code: e.target.value }), placeholder: "000000" })),
                                React.createElement("p", { className: "auth-policy" },
                                    duration(config?.policy.otpSeconds || 300),
                                    " expiry \u00B7 ",
                                    config?.policy.otpAttempts || 5,
                                    " attempts maximum",
                                    this.state.otp && React.createElement(React.Fragment, null,
                                        " \u00B7 ",
                                        this.state.otp.attemptsRemaining,
                                        " attempts at last check")),
                                config?.simulatedDelivery && React.createElement("div", { className: "auth-simulation" }, "OTP delivery simulated \u2014 not independent MFA.")),
                            reset && !this.state.resetDone && React.createElement(React.Fragment, null,
                                React.createElement("label", { className: "auth-field" },
                                    React.createElement("span", null, "New password"),
                                    React.createElement("div", { className: "password-control" },
                                        React.createElement("input", { name: "newPassword", "aria-label": "New password", type: this.state.showNew ? 'text' : 'password', autoComplete: "new-password", minLength: 15, required: true, value: this.state.newPassword, onChange: (e) => this.setState({ newPassword: e.target.value }) }),
                                        React.createElement("button", { type: "button", onClick: () => this.setState({ showNew: !this.state.showNew }) }, this.state.showNew ? 'Hide' : 'Show'))),
                                React.createElement("label", { className: "auth-field" },
                                    React.createElement("span", null, "Confirm new password"),
                                    React.createElement("input", { name: "confirmPassword", "aria-label": "Confirm new password", type: this.state.showNew ? 'text' : 'password', autoComplete: "new-password", minLength: 15, required: true, value: this.state.confirmPassword, onChange: (e) => this.setState({ confirmPassword: e.target.value }) })),
                                React.createElement("p", { className: "auth-policy" }, "15\u20131,024 characters. Passwords are never trimmed or silently shortened."),
                                !this.token && React.createElement(Message, { error: true, text: "Open the one-time reset link to continue. Reloading this form removes its in-memory token." })),
                            !this.state.resetDone && React.createElement("button", { className: "auth-submit", type: "submit", disabled: this.state.busy || !config || (reset && !this.token) },
                                this.state.busy ? 'Verifying…' : otp ? 'Verify & continue' : forgot ? 'Send recovery instructions' : reset ? 'Save new password' : 'Sign in',
                                " ",
                                React.createElement("span", { "aria-hidden": "true" }, "\u2192"))),
                        otp && React.createElement("button", { className: "auth-resend", disabled: this.state.busy || seconds > 0, onClick: () => this.run(async () => { const r = await service.request('/api/auth/otp/resend', { method: 'POST', body: '{}' }, false); this.setState({ otp: { ...this.state.otp, ...r }, outbox: null, message: 'A replacement code was requested. The previous code no longer works.' }); }) }, seconds > 0 ? 'Resend available in ' + seconds + 's' : 'Resend verification code'),
                        !login && React.createElement("button", { className: "auth-back text-btn", onClick: () => navigate('/login') }, "\u2190 Back to sign in"),
                        config?.demoMode && config?.simulatedDelivery && (otp || forgot) && React.createElement("div", { className: "auth-demo-box" },
                            React.createElement("button", { className: "text-btn", onClick: this.outbox, disabled: this.state.busy }, "Open isolated demo outbox"),
                            React.createElement("p", null, "Only messages requested in this browser context are shown. No real email or SMS has been sent."),
                            this.state.outbox && React.createElement(OutboxView, { outbox: this.state.outbox })),
                        login && this.state.demo && React.createElement("details", { className: "auth-demo-box" },
                            React.createElement("summary", null, "Explore the seven demo accounts"),
                            React.createElement("p", null, "Public credentials for this isolated synthetic instance only. Choosing an account fills the form; it does not sign you in."),
                            React.createElement("div", { className: "demo-account-grid" }, this.state.demo.accounts.map((a) => React.createElement("button", { key: a.email, type: "button", onClick: () => this.setState({ email: a.email, password: this.state.demo.password, error: '' }) },
                                React.createElement("strong", null, roleNames[a.role]),
                                React.createElement("small", null,
                                    a.email,
                                    a.otpRequired ? ' · OTP required' : '')))),
                            React.createElement("div", { className: "demo-password" },
                                "Test password ",
                                React.createElement("code", null, this.state.demo.password))),
                        React.createElement("div", { className: "auth-assurance" },
                            React.createElement("span", { "aria-hidden": "true" }, "\u2311"),
                            React.createElement("p", null, "Identity, sessions, and clinical permissions are verified by the server. This prototype is not a production security certification.")))));
        }
    }
    function OutboxView({ outbox }) { return React.createElement("div", { className: "outbox-view" },
        React.createElement("strong", null, "Simulated delivery \u00B7 Isolated demo only"),
        outbox.messages.length ? outbox.messages.map((m) => React.createElement("article", { key: m.id },
            React.createElement("small", null,
                m.kind === 'otp' ? 'Verification challenge' : m.kind === 'setup' ? 'Account setup' : 'Password recovery',
                " \u00B7 ",
                m.to),
            m.code ? React.createElement("code", { className: "outbox-code" }, m.code) : React.createElement("a", { href: m.url },
                "Open one-time ",
                m.kind,
                " link \u2192"))) : React.createElement("p", null, "No unexpired message is available for this browser context.")); }
    AyuAuthUI.OutboxView = OutboxView;
    function ProfileMenu({ user, onProfile }) { return React.createElement("details", { className: "signed-profile" },
        React.createElement("summary", { "aria-label": "Signed-in profile" },
            React.createElement("span", { className: "avatar" }, user.initials),
            React.createElement("span", null,
                React.createElement("strong", null, roleNames[user.role]),
                React.createElement("small", null, user.name)),
            React.createElement("span", { "aria-hidden": "true" }, "\u2304")),
        React.createElement("div", { className: "profile-popover" },
            React.createElement("b", null, user.name),
            React.createElement("small", null, user.email),
            React.createElement("button", { onClick: onProfile }, "Profile / Security"),
            React.createElement("button", { onClick: () => service.logout().catch(() => { }) }, "Sign out"))); }
    AyuAuthUI.ProfileMenu = ProfileMenu;
    class Profile extends React.Component {
        constructor() {
            super(...arguments);
            this.state = { busy: false, error: '', show: false, events: [] };
            this.pending = false;
            this.submit = async (e) => { e.preventDefault(); if (this.pending)
                return; const data = Object.fromEntries(new FormData(e.currentTarget).entries()); if (Array.from(String(data.newPassword)).length > 1024) {
                this.setState({ error: 'Use 15–1,024 characters. Passwords are never truncated.' });
                return;
            } if (data.newPassword !== data.confirmPassword) {
                this.setState({ error: 'The passwords do not match.' });
                return;
            } this.pending = true; this.setState({ busy: true, error: '' }); try {
                await service.changePassword(data);
            }
            catch (error) {
                this.setState({ busy: false, error: error.message });
            }
            finally {
                this.pending = false;
            } };
        }
        componentDidMount() { service.request('/api/auth/security').then(r => this.setState({ events: r.events })).catch(e => this.setState({ error: e.message })); }
        render() { const user = this.props.user, s = service.current?.session; return React.createElement("div", { className: "page-content" },
            React.createElement("div", { className: "two-columns" },
                React.createElement("section", { className: "panel" },
                    React.createElement("div", { className: "panel-head" },
                        React.createElement("h2", null, "Your verified account")),
                    React.createElement("div", { className: "pad profile-facts" },
                        React.createElement("strong", null, user.name),
                        React.createElement("p", null, user.email),
                        React.createElement("span", { className: "badge green" }, roleNames[user.role]),
                        React.createElement("h3", null, "Assigned trial / site access"),
                        user.assignments.map((a) => React.createElement("p", { key: a.trialId },
                            a.trialId,
                            " \u00B7 ",
                            a.siteIds.join(', '))),
                        React.createElement("div", { className: "notice" }, "Your role and assignments are controlled by an Administrator, not editable profile fields."),
                        s && React.createElement(React.Fragment, null,
                            React.createElement("h3", null, "Current session"),
                            React.createElement("p", null,
                                s.remembered ? 'Remembered device' : 'Normal session',
                                " \u00B7 OTP ",
                                user.otpRequired ? 'required at login' : 'not required by demo policy'),
                            React.createElement("p", { className: "muted" },
                                "Absolute expiry: ",
                                new Date(s.absoluteExpiresAt * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                                " IST",
                                React.createElement("br", null),
                                "Inactivity limit: ",
                                duration(service.config?.policy.idleSeconds || 1800),
                                ". Authentication uses the real server clock.")))),
                React.createElement("section", { className: "panel" },
                    React.createElement("div", { className: "panel-head" },
                        React.createElement("h2", null, "Change your password")),
                    React.createElement("form", { className: "pad", onSubmit: this.submit },
                        React.createElement(Message, { error: true, text: this.state.error }),
                        [['currentPassword', 'Current password', 'current-password'], ['newPassword', 'New password', 'new-password'], ['confirmPassword', 'Confirm new password', 'new-password']].map(([name, label, complete]) => React.createElement("label", { className: "auth-field", key: name },
                            React.createElement("span", null, label),
                            React.createElement("input", { name: name, "aria-label": label, autoComplete: complete, type: this.state.show ? 'text' : 'password', required: true, minLength: name === 'currentPassword' ? 1 : 15 }))),
                        React.createElement("label", { className: "checkbox-line" },
                            React.createElement("input", { type: "checkbox", checked: this.state.show, onChange: (e) => this.setState({ show: e.target.checked }) }),
                            " Show passwords"),
                        React.createElement("p", { className: "muted" }, "15\u20131,024 characters. Saving revokes all your sessions and requires a fresh login, including any required OTP."),
                        React.createElement("button", { className: "btn primary", disabled: this.state.busy }, "Change password & sign out")))),
            React.createElement("section", { className: "panel pad-top" },
                React.createElement("div", { className: "panel-head" },
                    React.createElement("h2", null, "Your recent security events")),
                React.createElement("div", { className: "table-wrap" },
                    React.createElement("table", null,
                        React.createElement("thead", null,
                            React.createElement("tr", null,
                                React.createElement("th", null, "Time (IST)"),
                                React.createElement("th", null, "Event"),
                                React.createElement("th", null, "Recorded detail"))),
                        React.createElement("tbody", null, this.state.events.map((e, i) => React.createElement("tr", { key: i },
                            React.createElement("td", null, new Date(e.at * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })),
                            React.createElement("td", null, e.event),
                            React.createElement("td", null, e.reason)))))))); }
    }
    AyuAuthUI.Profile = Profile;
    class AccountAdmin extends React.Component {
        constructor() {
            super(...arguments);
            this.state = { accounts: [], loading: true, error: '', message: '', edit: null, creating: false, role: 'Coordinator', assignments: [], active: true, name: '', email: '', reason: '', busy: false, outbox: null, logs: null };
            this.pending = false;
            this.run = async (fn) => { if (this.pending)
                return; this.pending = true; this.setState({ busy: true, error: '', message: '' }); try {
                await fn();
            }
            catch (e) {
                this.setState({ error: e.message });
            }
            finally {
                this.pending = false;
                this.setState({ busy: false });
            } };
            this.edit = (u) => this.setState({ edit: u.id, creating: false, role: u.role, name: u.name, email: u.email, active: u.active, assignments: Ayu.clone(u.assignments), reason: '', error: '', message: '' });
            this.toggle = (trialId, siteId) => { let assignments = Ayu.clone(this.state.assignments); let a = assignments.find((a) => a.trialId === trialId); if (!a) {
                a = { trialId, siteIds: [] };
                assignments.push(a);
            } a.siteIds = a.siteIds.includes(siteId) ? a.siteIds.filter((s) => s !== siteId) : [...a.siteIds, siteId]; this.setState({ assignments: assignments.filter((a) => a.siteIds.length) }); };
            this.submit = (e) => { e.preventDefault(); this.run(async () => { const create = this.state.creating; const body = create ? { email: this.state.email, name: this.state.name, role: this.state.role, assignments: this.state.assignments } : { name: this.state.name, role: this.state.role, active: this.state.active, assignments: this.state.assignments, reason: this.state.reason }; const r = await service.request('/api/admin/accounts' + (create ? '' : '/' + this.state.edit), { method: create ? 'POST' : 'PATCH', body: JSON.stringify(body) }); this.setState({ edit: null, creating: false, message: r.message }); await this.load(); await this.props.app.repo.reload(); }); };
        }
        componentDidMount() { this.load(); }
        async load() { try {
            const r = await service.request('/api/admin/accounts');
            this.setState({ accounts: r.accounts, loading: false });
        }
        catch (e) {
            this.setState({ error: e.message, loading: false });
        } }
        render() {
            const s = this.props.app.all(), editing = this.state.creating || this.state.edit;
            return React.createElement(React.Fragment, null,
                React.createElement(Message, { error: true, text: this.state.error }),
                React.createElement(Message, { text: this.state.message }),
                React.createElement("div", { className: "account-toolbar" },
                    React.createElement("div", null,
                        React.createElement("h2", null, "Accounts & access"),
                        React.createElement("p", { className: "muted" }, "The server account registry controls roles, assignments, activation, and access revocation.")),
                    React.createElement("button", { className: "btn primary", onClick: () => this.setState({ creating: true, edit: null, email: '', name: '', role: 'Coordinator', assignments: [], active: true, error: '' }) }, "Create account")),
                editing && React.createElement("section", { className: "panel" },
                    React.createElement("div", { className: "panel-head" },
                        React.createElement("h2", null, this.state.creating ? 'Create a staff account' : 'Edit account access'),
                        React.createElement("button", { className: "btn secondary small", onClick: () => this.setState({ edit: null, creating: false }) }, "Cancel")),
                    React.createElement("form", { className: "pad", onSubmit: this.submit },
                        React.createElement("div", { className: "form-grid" },
                            React.createElement("label", { className: "auth-field" },
                                React.createElement("span", null, "Staff name"),
                                React.createElement("input", { value: this.state.name, onChange: (e) => this.setState({ name: e.target.value }), required: true, maxLength: 100 })),
                            React.createElement("label", { className: "auth-field" },
                                React.createElement("span", null, "Account email"),
                                React.createElement("input", { type: "email", value: this.state.email, readOnly: !this.state.creating, onChange: (e) => this.setState({ email: e.target.value }), required: true })),
                            React.createElement("label", { className: "auth-field" },
                                React.createElement("span", null, "Assigned role"),
                                React.createElement("select", { "aria-label": "Assigned role", value: this.state.role, onChange: (e) => this.setState({ role: e.target.value }) }, Object.entries(roleNames).map(([r, n]) => React.createElement("option", { key: r, value: r }, n)))),
                            !this.state.creating && React.createElement("label", { className: "checkbox-line" },
                                React.createElement("input", { type: "checkbox", checked: this.state.active, onChange: (e) => this.setState({ active: e.target.checked }) }),
                                " Account active")),
                        React.createElement("fieldset", { className: "assignment-options" },
                            React.createElement("legend", null, "Explicit trial / site assignments"),
                            Ayu.vals(s.trials).map((t) => React.createElement("div", { key: t.id },
                                React.createElement("strong", null, t.id),
                                Ayu.vals(s.trialSites).filter((ts) => ts.trialId === t.id).map((ts) => React.createElement("label", { key: ts.id },
                                    React.createElement("input", { type: "checkbox", checked: this.state.assignments.some((a) => a.trialId === t.id && a.siteIds.includes(ts.siteId)), onChange: () => this.toggle(t.id, ts.siteId) }),
                                    s.sites[ts.siteId].city))))),
                        !this.state.creating && React.createElement("label", { className: "auth-field" },
                            React.createElement("span", null, "Access-change reason"),
                            React.createElement("input", { value: this.state.reason, onChange: (e) => this.setState({ reason: e.target.value }), required: true, minLength: 3 })),
                        React.createElement("p", { className: "muted" }, this.state.creating ? 'A single-use password-setup link will be sent through the configured channel. There is no default password or public signup.' : 'Changing access immediately revokes this user’s existing sessions and recovery/OTP challenges. Administrative access does not include PI, Ethics, or PV decisions.'),
                        React.createElement("button", { className: "btn primary", disabled: this.state.busy }, this.state.creating ? 'Create & send setup link' : 'Save access changes'))),
                React.createElement("section", { className: "panel" },
                    React.createElement("div", { className: "table-wrap" },
                        React.createElement("table", null,
                            React.createElement("thead", null,
                                React.createElement("tr", null,
                                    React.createElement("th", null, "Account"),
                                    React.createElement("th", null, "Role & status"),
                                    React.createElement("th", null, "Assigned scope"),
                                    React.createElement("th", null, "Manage"))),
                            React.createElement("tbody", null, this.state.accounts.map((u) => React.createElement("tr", { key: u.id },
                                React.createElement("td", null,
                                    React.createElement("strong", null, u.name),
                                    React.createElement("small", { className: "cell-sub" }, u.email)),
                                React.createElement("td", null,
                                    roleNames[u.role],
                                    React.createElement("small", { className: "cell-sub" },
                                        u.active ? 'Active' : 'Disabled',
                                        " \u00B7 ",
                                        u.passwordSet ? 'Password set' : 'Setup pending',
                                        u.otpRequired ? ' · OTP required' : '')),
                                React.createElement("td", null, u.assignments.map((a) => React.createElement("small", { className: "cell-sub", key: a.trialId },
                                    a.trialId,
                                    " \u00B7 ",
                                    a.siteIds.join(', ')))),
                                React.createElement("td", null,
                                    React.createElement("button", { className: "text-btn", onClick: () => this.edit(u) }, "Edit access"),
                                    React.createElement("button", { className: "text-btn cell-sub", disabled: !u.active || this.state.busy, onClick: () => this.run(async () => { const r = await service.request('/api/admin/accounts/' + u.id + '/setup-link', { method: 'POST', body: '{}' }); this.setState({ message: r.message }); }) },
                                        "Send ",
                                        u.passwordSet ? 'recovery' : 'setup',
                                        " link"))))))),
                    this.state.loading && React.createElement("p", { className: "pad" }, "Loading account registry\u2026")),
                React.createElement("div", { className: "button-row pad-top" },
                    service.config?.simulatedDelivery && React.createElement("button", { className: "btn secondary", onClick: () => this.run(async () => this.setState({ outbox: await service.request('/api/demo/outbox', {}, false) })) }, "Open isolated demo outbox"),
                    React.createElement("button", { className: "btn secondary", onClick: () => this.run(async () => { const r = await service.request('/api/admin/security-log'); this.setState({ logs: r.events }); }) }, "Review restricted security log")),
                this.state.outbox && React.createElement(OutboxView, { outbox: this.state.outbox }),
                " ",
                this.state.logs && React.createElement("section", { className: "panel" },
                    React.createElement("div", { className: "panel-head" },
                        React.createElement("h2", null, "Restricted security history")),
                    React.createElement("div", { className: "table-wrap" },
                        React.createElement("table", null,
                            React.createElement("thead", null,
                                React.createElement("tr", null,
                                    React.createElement("th", null, "Time (IST)"),
                                    React.createElement("th", null, "Actor"),
                                    React.createElement("th", null, "Event"),
                                    React.createElement("th", null, "Reason"))),
                            React.createElement("tbody", null, this.state.logs.map((e) => React.createElement("tr", { key: e.id },
                                React.createElement("td", null, new Date(e.at * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })),
                                React.createElement("td", null, e.actor_id || 'Unauthenticated / server'),
                                React.createElement("td", null, e.event),
                                React.createElement("td", null, e.reason))))))));
        }
    }
    AyuAuthUI.AccountAdmin = AccountAdmin;
})(AyuAuthUI || (AyuAuthUI = {}));
var AyuUI;
(function (AyuUI) {
    const { vals, metrics, risk, formatDate, can, ROLE_NAMES, day, overdue } = Ayu;
    const pages = [['overview', 'Overview', 'grid'], ['trials', 'Trials', 'flask'], ['sites', 'Sites', 'building'], ['participants', 'Participants & Visits', 'users'], ['safety', 'Safety', 'shield'], ['monitoring', 'Monitoring', 'activity'], ['compliance', 'Compliance & Documents', 'file'], ['intelligence', 'Intelligence', 'spark'], ['actions', 'Action Center', 'check'], ['reports', 'Reports', 'chart']];
    const names = Object.fromEntries(pages.map(p => [p[0], p[1]]));
    names.admin = 'Administration';
    names.profile = 'Profile / Security';
    function Icon(p) { const paths = { grid: React.createElement(React.Fragment, null,
            React.createElement("rect", { x: "3", y: "3", width: "7", height: "7", rx: "1.5" }),
            React.createElement("rect", { x: "14", y: "3", width: "7", height: "7", rx: "1.5" }),
            React.createElement("rect", { x: "3", y: "14", width: "7", height: "7", rx: "1.5" }),
            React.createElement("rect", { x: "14", y: "14", width: "7", height: "7", rx: "1.5" })), flask: React.createElement(React.Fragment, null,
            React.createElement("path", { d: "M9 3h6M10 3v7L5 19c-.5 1 .2 2 1.3 2h11.4c1.1 0 1.8-1 1.3-2l-5-9V3M8 15h8" })), building: React.createElement(React.Fragment, null,
            React.createElement("rect", { x: "4", y: "3", width: "16", height: "18", rx: "2" }),
            React.createElement("path", { d: "M8 7h1m6 0h1M8 11h1m6 0h1M10 21v-6h4v6" })), users: React.createElement(React.Fragment, null,
            React.createElement("circle", { cx: "9", cy: "8", r: "3" }),
            React.createElement("path", { d: "M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v2" })), shield: React.createElement(React.Fragment, null,
            React.createElement("path", { d: "M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" }),
            React.createElement("path", { d: "M12 8v5m0 3h.01" })), activity: React.createElement(React.Fragment, null,
            React.createElement("path", { d: "M2 12h5l3-8 4 16 3-8h5" })), file: React.createElement(React.Fragment, null,
            React.createElement("path", { d: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6M8 13h8m-8 4h5" })), spark: React.createElement(React.Fragment, null,
            React.createElement("path", { d: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4m-2-2h4" })), check: React.createElement(React.Fragment, null,
            React.createElement("rect", { x: "3", y: "3", width: "18", height: "18", rx: "4" }),
            React.createElement("path", { d: "m7 12 3 3 7-7" })), chart: React.createElement(React.Fragment, null,
            React.createElement("path", { d: "M4 3v17h17M8 16v-4m5 4V7m5 9V4" })), settings: React.createElement(React.Fragment, null,
            React.createElement("path", { d: "m9 3 6 0 1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z" }),
            React.createElement("circle", { cx: "12", cy: "12", r: "3" })), search: React.createElement(React.Fragment, null,
            React.createElement("circle", { cx: "10", cy: "10", r: "6" }),
            React.createElement("path", { d: "m15 15 5 5" })), bell: React.createElement(React.Fragment, null,
            React.createElement("path", { d: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" })), down: React.createElement("path", { d: "m6 9 6 6 6-6" }), right: React.createElement("path", { d: "m9 5 7 7-7 7" }), arrow: React.createElement("path", { d: "M4 12h16m-6-6 6 6-6 6" }), arrowUp: React.createElement("path", { d: "M6 18 18 6M6 6h12v12" }), plus: React.createElement("path", { d: "M12 5v14M5 12h14" }), x: React.createElement("path", { d: "m6 6 12 12M6 18 18 6" }), clock: React.createElement(React.Fragment, null,
            React.createElement("circle", { cx: "12", cy: "12", r: "9" }),
            React.createElement("path", { d: "M12 7v5l4 2" })), calendar: React.createElement(React.Fragment, null,
            React.createElement("rect", { x: "3", y: "5", width: "18", height: "16", rx: "2" }),
            React.createElement("path", { d: "M7 3v4m10-4v4M3 11h18M8 15h2m4 0h2" })), download: React.createElement(React.Fragment, null,
            React.createElement("path", { d: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" })), upload: React.createElement(React.Fragment, null,
            React.createElement("path", { d: "M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5" })), menu: React.createElement("path", { d: "M4 6h16M4 12h16M4 18h16" }), info: React.createElement(React.Fragment, null,
            React.createElement("circle", { cx: "12", cy: "12", r: "9" }),
            React.createElement("path", { d: "M12 11v6m0-10h.01" })), leaf: React.createElement(React.Fragment, null,
            React.createElement("path", { d: "M20 3C9 2 3 6 4 13s9 9 13 3c3-4 2-9 3-13Z" }),
            React.createElement("path", { d: "m3 21 12-12" })), lock: React.createElement(React.Fragment, null,
            React.createElement("rect", { x: "5", y: "10", width: "14", height: "11", rx: "2" }),
            React.createElement("path", { d: "M8 10V7a4 4 0 0 1 8 0v3" })), refresh: React.createElement(React.Fragment, null,
            React.createElement("path", { d: "M20 8a8 8 0 1 0 1 8M20 3v5h-5" })), alert: React.createElement(React.Fragment, null,
            React.createElement("path", { d: "m12 3 10 18H2L12 3Z" }),
            React.createElement("path", { d: "M12 9v5m0 3h.01" })), send: React.createElement(React.Fragment, null,
            React.createElement("path", { d: "m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13" })), print: React.createElement(React.Fragment, null,
            React.createElement("path", { d: "M7 8V3h10v5M6 17H3v-8h18v8h-3M7 14h10v7H7z" })), link: React.createElement(React.Fragment, null,
            React.createElement("path", { d: "m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l4-4m12 0 2-2a4 4 0 0 1 6 6l-4 4" })) }; return React.createElement("svg", { width: p.size || 20, height: p.size || 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round", strokeLinejoin: "round", className: p.className || '', "aria-hidden": "true" }, paths[p.name] || paths.file); }
    const Fragment = React.Fragment;
    function Badge({ children, tone = '' }) { const v = String(children); const auto = /Urgent|High|Overdue|Serious|Failed|Blocked|Screen Failed/.test(v) ? 'red' : /Watch|Pending|Submitted|Open|Follow-up|Changes|Uncoded/.test(v) ? 'amber' : /Active|Recruiting|Complete|Recorded|Reviewed|Approved|Low|Enrolled|Eligible|Verified/.test(v) ? 'green' : 'slate'; return React.createElement("span", { className: 'badge ' + (tone || auto) }, children); }
    function Button(p) { return React.createElement("button", { type: p.type || 'button', className: 'btn ' + (p.variant || 'secondary') + ' ' + (p.small ? 'small ' : '') + (p.className || ''), disabled: p.disabled, onClick: p.onClick, "aria-label": p['aria-label'], title: p.title },
        p.icon && React.createElement(Icon, { name: p.icon, size: p.small ? 15 : 17 }),
        " ",
        p.children); }
    function Empty(p) { return React.createElement("div", { className: "empty" },
        React.createElement("div", { className: "empty-icon" },
            React.createElement(Icon, { name: "file", size: 28 })),
        React.createElement("h3", null, p.title),
        React.createElement("p", null, p.text || 'There are no records in the current permitted scope.'),
        p.action); }
    function Panel(p) { return React.createElement("section", { className: 'panel ' + (p.className || '') },
        React.createElement("div", { className: "panel-head" },
            React.createElement("div", null,
                React.createElement("h2", null, p.title),
                p.subtitle && React.createElement("p", null, p.subtitle)),
            p.action),
        p.children); }
    function Progress(p) { return React.createElement("div", { className: "progress-wrap" },
        React.createElement("div", { className: "progress", role: "progressbar", "aria-valuenow": p.n, "aria-valuemin": 0, "aria-valuemax": p.d || 1, "aria-label": p.label || 'Enrollment progress' },
            React.createElement("span", { style: { width: Math.min(100, p.d ? p.n / p.d * 100 : 0) + '%' } }))); }
    function Field(p) { return React.createElement("label", { className: 'field ' + (p.wide ? 'wide' : '') },
        React.createElement("span", null,
            p.label,
            p.required && React.createElement("em", null, " *")),
        p.children ? React.cloneElement(p.children, { 'aria-label': p.label, 'aria-required': p.required || undefined }) : React.createElement("input", { "aria-label": p.label, name: p.name, defaultValue: p.value || '', type: p.type || 'text', min: p.min, max: p.max, required: p.required, placeholder: p.placeholder || '', autoComplete: "off" }),
        p.help && React.createElement("small", null, p.help)); }
    function CheckRow(p) { return React.createElement("div", { className: "checkrow" },
        React.createElement("span", { className: 'checkicon ' + (p.ok ? 'ok' : 'pending') },
            React.createElement(Icon, { name: p.ok ? 'check' : 'clock', size: 17 })),
        React.createElement("div", null,
            React.createElement("strong", null, p.title),
            React.createElement("small", null, p.detail)),
        p.action || React.createElement(Badge, null, p.ok ? 'Recorded' : 'Pending')); }
    function Statistic(p) { return React.createElement("button", { className: 'stat ' + (p.accent || ''), onClick: p.onClick },
        React.createElement("div", { className: "stat-top" },
            React.createElement("span", null, p.label),
            React.createElement("span", { className: "stat-icon" },
                React.createElement(Icon, { name: p.icon }))),
        React.createElement("div", { className: "stat-number" },
            p.value,
            React.createElement("span", null, p.denominator)),
        React.createElement("div", { className: "stat-foot" },
            p.foot,
            React.createElement(Icon, { name: "arrow", size: 15 }))); }
    function dataOf(e) { e.preventDefault(); return Object.fromEntries(new FormData(e.currentTarget).entries()); }
    function RecordLink(p) { return React.createElement("button", { className: "record-link", onClick: p.onClick },
        p.children,
        p.arrow && React.createElement(Icon, { name: "arrowUp", size: 14 })); }
    function Table(p) { return React.createElement(React.Fragment, null,
        React.createElement("div", { className: "table-wrap" },
            React.createElement("table", null,
                React.createElement("thead", null,
                    React.createElement("tr", null, p.heads.map(h => React.createElement("th", { key: h }, h)))),
                React.createElement("tbody", null, p.children))),
        p.footer && React.createElement("div", { className: "table-footer" }, p.footer)); }
    class Dialog extends React.Component {
        constructor() {
            super(...arguments);
            this.node = null;
            this.previous = null;
            this.key = (e) => {
                if (e.key === 'Escape') {
                    e.stopPropagation();
                    this.props.onClose();
                }
                if (e.key === 'Tab' && this.node) {
                    const list = Array.from(this.node.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]')).filter(el => el.offsetParent !== null);
                    const first = list[0], last = list[list.length - 1];
                    if (e.shiftKey && document.activeElement === first) {
                        e.preventDefault();
                        last?.focus();
                    }
                    else if (!e.shiftKey && document.activeElement === last) {
                        e.preventDefault();
                        first?.focus();
                    }
                }
            };
        }
        componentDidMount() { this.previous = document.activeElement; document.body.style.overflow = 'hidden'; document.addEventListener('keydown', this.key); setTimeout(() => this.node?.querySelector('input,button,select,textarea')?.focus(), 0); }
        componentWillUnmount() { document.body.style.overflow = ''; document.removeEventListener('keydown', this.key); this.previous?.focus(); }
        render() {
            return React.createElement("div", { className: 'overlay ' + (this.props.aside ? 'aside-overlay' : ''), onMouseDown: (e) => {
                    if (e.target === e.currentTarget)
                        this.props.onClose();
                } },
                React.createElement("section", { className: 'dialog ' + (this.props.wide ? 'wide-dialog ' : '') + (this.props.aside ? 'drawer' : ''), ref: (n) => this.node = n, role: "dialog", "aria-modal": "true", "aria-labelledby": "dialog-title" },
                    React.createElement("header", { className: "dialog-head" },
                        React.createElement("div", null,
                            React.createElement("h2", { id: "dialog-title" }, this.props.title),
                            this.props.subtitle && React.createElement("p", null, this.props.subtitle)),
                        React.createElement("button", { className: "icon-btn", "aria-label": "Close dialog", onClick: this.props.onClose },
                            React.createElement(Icon, { name: "x" }))),
                    React.createElement("div", { className: "dialog-body" }, this.props.children)));
        }
    }
    function download(name, content, type) { const blob = new Blob([content], { type }); const a = document.createElement('a'); const url = URL.createObjectURL(blob); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000); }
    function initial(userId, page) { return { userId, page, scope: {}, tab: '', query: '', search: '', status: 'All', sort: 'default', dialog: null, error: '', fields: {}, toast: '', mobile: false, assistantOpen: false, question: '', answer: null, reportKind: 'Recruitment', step: 0, draft: {}, calendar: false, limit: 20, tick: 0, chartMonths: 3, searchResults: [], busy: false }; }
    class App extends React.Component {
        constructor(p) {
            super(p);
            this.searchEpoch = 0;
            this.answerEpoch = 0;
            this.pending = false;
            this.mounted = true;
            this.historyRoute = () => { const page = location.pathname.slice(1); if (this.props.user.allowedPages.includes(page))
                this.setState({ page, dialog: null, search: '', searchResults: [], answer: null });
            else
                this.setState({ error: 'Access denied. This route is not available to your signed-in account.' }); };
            this.keys = (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                    e.preventDefault();
                    document.getElementById('global-search')?.focus();
                }
                if (e.key === 'Escape')
                    this.setState({ search: '', mobile: false });
            };
            this.s = () => this.repo.view(this.state.userId, this.state.scope);
            this.all = () => this.repo.view(this.state.userId);
            this.user = () => this.props.user;
            this.scopeLabel = () => { const s = this.s(); return (this.state.scope.trialId || 'All permitted trials') + ' / ' + (this.state.scope.siteId ? s.sites[this.state.scope.siteId]?.city || 'Selected site' : 'All assigned sites'); };
            this.set = (update) => this.setState(update);
            this.nav = (page, filter = 'All', tab = '') => { if (!this.props.user.allowedPages.includes(page)) {
                this.setState({ error: 'Access denied. This route is not available to your signed-in account.' });
                return;
            } history.pushState({}, '', '/' + page); this.setState({ page, status: filter, tab, query: '', limit: 20, mobile: false, dialog: null, error: '', fields: {}, search: '' }); window.scrollTo({ top: 0, behavior: 'smooth' }); };
            this.open = (type, id, extra) => { this.setState({ dialog: { type, id, extra }, error: '', fields: {}, step: 0, draft: {}, search: '', assistantOpen: false }); };
            this.close = () => this.setState({ dialog: null, error: '', fields: {}, step: 0, draft: {} });
            this.notify = (toast) => { clearTimeout(this.toastTimer); this.setState({ toast }); this.toastTimer = setTimeout(() => this.setState({ toast: '' }), 4500); };
            this.run = async (fn, success, next) => {
                if (this.pending)
                    return null;
                this.pending = true;
                this.setState({ busy: true, error: '', fields: {} });
                try {
                    const result = await fn();
                    if (!this.mounted)
                        return null;
                    this.setState({ error: '', fields: {} });
                    if (next === 'close')
                        this.close();
                    else if (typeof next === 'function')
                        next(result);
                    this.notify(success);
                    if (this.state.question)
                        this.ask(this.state.question);
                    return result;
                }
                catch (e) {
                    if (this.mounted && e.code !== 'cancelled')
                        this.setState({ error: e.message || 'Operation failed.', fields: e.fields || {} });
                    return null;
                }
                finally {
                    this.pending = false;
                    if (this.mounted)
                        this.setState({ busy: false });
                }
            };
            this.search = (value) => { const epoch = ++this.searchEpoch; this.setState({ search: value, searchResults: [] }); clearTimeout(this.searchTimer); if (value.length < 2)
                return; this.searchTimer = setTimeout(async () => { try {
                const params = new URLSearchParams({ q: value, ...this.state.scope });
                const r = await AyuAuth.authService.request('/api/search?' + params);
                if (this.mounted && epoch === this.searchEpoch)
                    this.setState({ searchResults: r.items });
            }
            catch (e) {
                if (this.mounted && e.code !== 'cancelled')
                    this.setState({ error: e.message });
            } }, 150); };
            this.filter = (key, value) => {
                const scope = { ...this.state.scope, [key]: value || undefined };
                if (key === 'trialId')
                    scope.siteId = undefined;
                this.setState({ scope, query: '', status: 'All', answer: null, search: '', limit: 20 });
            };
            this.ask = async (q) => { const epoch = ++this.answerEpoch; this.setState({ question: q, answer: null }); try {
                const answer = await AyuAuth.authService.request('/api/assistant', { method: 'POST', body: JSON.stringify({ question: q, scope: this.state.scope }) });
                if (this.mounted && epoch === this.answerEpoch)
                    this.setState({ answer });
            }
            catch (e) {
                if (this.mounted && e.code !== 'cancelled')
                    this.setState({ error: e.message });
            } };
            this.export = (format) => this.run(() => AyuAuth.authService.file('/api/exports?' + new URLSearchParams({ kind: this.state.reportKind, format, ...this.state.scope })), 'Current permitted records exported by the server.');
            this.formError = () => this.state.error ? React.createElement("div", { className: "error-box", role: "alert" },
                React.createElement(Icon, { name: "alert", size: 18 }),
                React.createElement("div", null,
                    React.createElement("strong", null, this.state.error),
                    Object.entries(this.state.fields).map(([k, v]) => React.createElement("p", { key: k },
                        React.createElement("b", null,
                            k.charAt(0).toUpperCase() + k.slice(1),
                            ":"),
                        " ",
                        v)))) : null;
            this.repo = new AyuAuth.ServerRepository(p.records, p.user, p.revision);
            this.state = initial(p.user.id, p.initialPage);
        }
        componentDidMount() { this.unsubscribe = this.repo.subscribe(() => this.setState(s => ({ tick: s.tick + 1, answer: null }))); document.addEventListener('keydown', this.keys); window.addEventListener('popstate', this.historyRoute); document.title = 'AYUSETU · Clinical research workspace'; }
        componentWillUnmount() { this.mounted = false; this.unsubscribe?.(); this.repo.dispose(); document.removeEventListener('keydown', this.keys); window.removeEventListener('popstate', this.historyRoute); clearTimeout(this.toastTimer); clearTimeout(this.searchTimer); }
        render() {
            const s = this.s(), u = this.user(), m = metrics(s), all = this.all();
            const pending = vals(s.actions).filter(a => a.status === 'Open').length;
            const results = this.state.searchResults;
            return React.createElement("div", { className: "app" },
                React.createElement("a", { className: "skip-link", href: "#main-content" }, "Skip to main content"),
                this.state.mobile && React.createElement("button", { className: "nav-scrim", "aria-label": "Close navigation", onClick: () => this.set({ mobile: false }) }),
                React.createElement("aside", { className: 'sidebar ' + (this.state.mobile ? 'is-open' : '') },
                    React.createElement("div", { className: "brand" },
                        React.createElement("div", { className: "brand-mark" },
                            React.createElement(Icon, { name: "leaf", size: 27 })),
                        React.createElement("div", null,
                            React.createElement("strong", null,
                                "AYU",
                                React.createElement("span", null, "SETU")),
                            React.createElement("small", null, "CLINICAL RESEARCH"))),
                    React.createElement("div", { className: "workspace" },
                        React.createElement("div", { className: "workspace-icon" },
                            React.createElement(Icon, { name: "building", size: 18 })),
                        React.createElement("div", null,
                            React.createElement("strong", null, "Research workspace"),
                            React.createElement("small", null, "AIIA context \u00B7 Prototype"))),
                    React.createElement("div", { className: "nav-caption" }, "WORKSPACE"),
                    React.createElement("nav", { "aria-label": "Main navigation" }, pages.map(([id, label, icon], i) => React.createElement(Fragment, { key: id },
                        i === 4 && React.createElement("div", { className: "nav-caption divider-caption" }, "OVERSIGHT & INSIGHTS"),
                        React.createElement("button", { className: 'nav-item ' + (this.state.page === id ? 'active' : ''), "aria-label": label, "aria-current": this.state.page === id ? 'page' : undefined, onClick: () => this.nav(id) },
                            React.createElement(Icon, { name: icon, size: 19 }),
                            React.createElement("span", null, label),
                            id === 'actions' && pending > 0 && React.createElement("b", null, pending))))),
                    React.createElement("div", { className: "sidebar-bottom" },
                        u.role === 'Admin' && React.createElement("button", { className: 'nav-item ' + (this.state.page === 'admin' ? 'active' : ''), onClick: () => this.nav('admin') },
                            React.createElement(Icon, { name: "settings", size: 19 }),
                            React.createElement("span", null, "Administration")),
                        React.createElement("button", { className: "help-card", onClick: () => this.open('guide') },
                            React.createElement("div", { className: "help-icon" },
                                React.createElement(Icon, { name: "leaf", size: 18 })),
                            React.createElement("div", null,
                                React.createElement("strong", null, "Research, responsibly."),
                                React.createElement("small", null,
                                    "Explore the guided demo ",
                                    React.createElement("span", null, "\u2197")))),
                        React.createElement("div", { className: "sidebar-credit" },
                            "Built by ",
                            React.createElement("strong", null, "Team Pathfindersz"),
                            React.createElement("span", null, "Prototype 02")))),
                React.createElement("div", { className: "shell" },
                    React.createElement("header", { className: "topbar" },
                        React.createElement("button", { className: "icon-btn mobile-menu", "aria-label": "Open navigation", onClick: () => this.set({ mobile: true }) },
                            React.createElement(Icon, { name: "menu" })),
                        React.createElement("div", { className: "global-search" },
                            React.createElement(Icon, { name: "search", size: 18 }),
                            React.createElement("input", { id: "global-search", "aria-label": "Search permitted records", placeholder: "Search trials, participants, records\u2026", value: this.state.search, onChange: (e) => this.search(e.target.value) }),
                            React.createElement("kbd", null, "\u2318 K"),
                            this.state.search.length > 1 && React.createElement("div", { className: "search-results" },
                                React.createElement("div", { className: "search-label" }, "PERMITTED RECORDS \u00B7 CURRENT SCOPE"),
                                results.length ? results.map(r => React.createElement("button", { key: r.type + r.id, onClick: () => this.open(r.type, r.id) },
                                    React.createElement(Icon, { name: r.icon, size: 17 }),
                                    React.createElement("div", null,
                                        React.createElement("strong", null, r.label),
                                        React.createElement("small", null, r.subtitle)),
                                    React.createElement(Icon, { name: "arrow", size: 16 }))) : React.createElement("p", null, "No matching records."))),
                        React.createElement("div", { className: "topbar-right" },
                            React.createElement("span", { className: "demo-pill", title: "Demo \u00B7 Synthetic data only" },
                                React.createElement("i", null),
                                " Demo \u00B7 Synthetic data"),
                            React.createElement("button", { className: "icon-btn notification-btn", "aria-label": "Open notifications", onClick: () => this.open('notifications') },
                                React.createElement(Icon, { name: "bell" }),
                                vals(s.actions).some(a => a.priority === 'Urgent' && a.status === 'Open') && React.createElement("i", null)),
                            React.createElement(AyuAuthUI.ProfileMenu, { user: u, onProfile: () => this.nav('profile') }))),
                    React.createElement("main", { id: "main-content" },
                        React.createElement("div", { className: "breadcrumb" },
                            React.createElement("span", null, "Workspace"),
                            React.createElement(Icon, { name: "right", size: 12 }),
                            React.createElement("strong", null, names[this.state.page]),
                            React.createElement("span", { className: "clock-label" },
                                React.createElement(Icon, { name: "calendar", size: 13 }),
                                "28 Sep 2026 \u00B7 09:30 IST \u00B7 fixed demo clock")),
                        React.createElement("div", { className: "page-heading" },
                            React.createElement("div", null,
                                React.createElement("div", { className: "eyebrow" }, this.state.page === 'overview' ? 'PREDICT · DETECT · ACT' : 'AYUSETU / RESEARCH OPERATIONS'),
                                React.createElement("h1", null, this.state.page === 'overview' ? (u.role === 'PI' ? 'Portfolio overview' : u.role === 'Coordinator' ? 'Your site workspace' : u.role === 'PV' ? 'Safety overview' : u.role === 'Monitor' ? 'Monitoring overview' : u.role === 'Ethics' ? 'Ethics review workspace' : u.role === 'Regulator' ? 'Regulatory review' : 'Workspace overview') : this.state.page === 'compliance' ? 'Compliance tracking' : names[this.state.page]),
                                React.createElement("p", null, this.state.page === 'overview' ? 'One workspace for Ayush clinical research. Every study, every next step.' : pageSubtitle(this.state.page))),
                            React.createElement("div", { className: "heading-actions" },
                                React.createElement(Button, { icon: "spark", onClick: () => this.set({ assistantOpen: true, answer: null }) }, "Ask assistant"),
                                this.state.page === 'overview' && React.createElement(Button, { variant: "primary", icon: "chart", onClick: () => this.nav('reports') }, "View reports"),
                                this.state.page === 'trials' && can(u, 'createTrial') && React.createElement(Button, { variant: "primary", icon: "plus", onClick: () => this.open('createTrial') }, "Create trial"),
                                this.state.page === 'participants' && can(u, 'screen') && React.createElement(Button, { variant: "primary", icon: "plus", onClick: () => this.open('screen') }, "New screening"),
                                this.state.page === 'safety' && can(u, 'safetyCreate') && React.createElement(Button, { variant: "primary", icon: "plus", onClick: () => this.open('newSafety') }, "Report event"),
                                this.state.page === 'compliance' && can(u, 'document') && React.createElement(Button, { variant: "primary", icon: "upload", onClick: () => this.open('newDocument') }, "Add document"))),
                        React.createElement("div", { className: "scopebar" },
                            React.createElement("div", { className: "scope-control" },
                                React.createElement(Icon, { name: "flask", size: 16 }),
                                React.createElement("label", { className: "sr-only", htmlFor: "trial-filter" }, "Trial filter"),
                                React.createElement("select", { id: "trial-filter", value: this.state.scope.trialId || '', onChange: (e) => this.filter('trialId', e.target.value) },
                                    React.createElement("option", { value: "" }, "All permitted trials"),
                                    vals(all.trials).map(t => React.createElement("option", { key: t.id, value: t.id }, t.code)))),
                            React.createElement("span", { className: "scope-divider" }),
                            React.createElement("div", { className: "scope-control" },
                                React.createElement(Icon, { name: "building", size: 16 }),
                                React.createElement("label", { className: "sr-only", htmlFor: "site-filter" }, "Site filter"),
                                React.createElement("select", { id: "site-filter", value: this.state.scope.siteId || '', onChange: (e) => this.filter('siteId', e.target.value) },
                                    React.createElement("option", { value: "" }, "All assigned sites"),
                                    vals(all.sites).filter(site => !this.state.scope.trialId || vals(all.trialSites).some(ts => ts.siteId === site.id && ts.trialId === this.state.scope.trialId)).map(site => React.createElement("option", { key: site.id, value: site.id }, site.city)))),
                            React.createElement("div", { className: "scope-summary" },
                                this.state.scope.siteId ? 'Site context' : this.state.scope.trialId ? 'Trial context' : 'Permitted portfolio',
                                " ",
                                React.createElement("span", null,
                                    "\u00B7 ",
                                    m.enrolled,
                                    " enrolled")),
                            (this.state.scope.trialId || this.state.scope.siteId) && React.createElement("button", { className: "text-btn", onClick: () => this.set({ scope: {}, status: 'All', query: '', answer: null }) }, "Clear filters")),
                        this.repo.warning && React.createElement("div", { className: "notice amber" },
                            React.createElement(Icon, { name: "info", size: 17 }),
                            React.createElement("span", null, this.repo.warning)),
                        u.role === 'Regulator' && React.createElement("div", { className: "notice blue" },
                            React.createElement(Icon, { name: "lock", size: 17 }),
                            React.createElement("span", null, "De-identified, read-only review. Exports are permitted; all domain-data writes are blocked at the service layer.")),
                        !this.state.dialog && this.formError(),
                        this.state.page === 'overview' ? React.createElement(Overview, { app: this }) : this.state.page === 'trials' ? React.createElement(Trials, { app: this }) : this.state.page === 'sites' ? React.createElement(Sites, { app: this }) : this.state.page === 'participants' ? React.createElement(Participants, { app: this }) : this.state.page === 'safety' ? React.createElement(Safety, { app: this }) : this.state.page === 'monitoring' ? React.createElement(Monitoring, { app: this }) : this.state.page === 'compliance' ? React.createElement(Compliance, { app: this }) : this.state.page === 'intelligence' ? React.createElement(Intelligence, { app: this }) : this.state.page === 'actions' ? React.createElement(Actions, { app: this }) : this.state.page === 'reports' ? React.createElement(Reports, { app: this }) : this.state.page === 'profile' ? React.createElement(AyuAuthUI.Profile, { user: u }) : React.createElement(Admin, { app: this }),
                        React.createElement("footer", { className: "main-footer" },
                            React.createElement("span", null,
                                React.createElement("i", null),
                                " All data is synthetic. No clinical or regulatory decisions."),
                            React.createElement("span", null,
                                "AYUSETU ",
                                React.createElement("b", null, "\u00B7"),
                                " Team Pathfindersz")))),
                this.state.busy && React.createElement("div", { className: "server-busy", role: "status" },
                    React.createElement("span", { className: "auth-spinner small" }),
                    " Saving through the server\u2026"),
                this.state.dialog && React.createElement(RecordDialog, { app: this }),
                " ",
                this.state.assistantOpen && React.createElement(AssistantPanel, { app: this }),
                " ",
                this.state.toast && React.createElement("div", { className: "toast", role: "status" },
                    React.createElement(Icon, { name: "check", size: 19 }),
                    this.state.toast,
                    React.createElement("button", { "aria-label": "Dismiss notification", onClick: () => this.set({ toast: '' }) },
                        React.createElement(Icon, { name: "x", size: 16 }))));
        }
    }
    AyuUI.App = App;
    function pageSubtitle(page) { return { trials: 'From protocol setup to close-out. Keep the full study lifecycle connected.', sites: 'Readiness, recruitment, and operational follow-up across your research network.', participants: 'Screening, recorded consent, enrollment, and protocol-defined visits.', safety: 'Capture evidence. Separate seriousness from severity. Route every review.', monitoring: 'Resolve data queries and follow through on site-level findings.', compliance: 'Track evidence, document versions, and human review decisions.', intelligence: 'Explainable operational context. Human judgment stays in control.', actions: 'One prioritized queue. Every next step links to the underlying work.', reports: 'Current records, permitted scope, and a traceable history of decisions.', admin: 'Configure the synthetic workspace and explore honest integration previews.' }[page]; }
    function searchRecords(s, q) { q = q.toLowerCase(); return [...vals(s.trials).map(t => ({ type: 'trial', id: t.id, label: t.code, subtitle: t.title, icon: 'flask' })), ...vals(s.participants).map(p => ({ type: 'participant', id: p.id, label: p.code, subtitle: p.trialId + ' · ' + p.status, icon: 'users' })), ...vals(s.safety).map(c => ({ type: 'safety', id: c.id, label: c.id + ' · ' + c.term, subtitle: c.status, icon: 'shield' })), ...vals(s.trialSites).map(t => ({ type: 'trialSite', id: t.id, label: s.sites[t.siteId].city, subtitle: t.trialId + ' · ' + t.status, icon: 'building' })), ...vals(s.queries).map(q => ({ type: 'query', id: q.id, label: q.id, subtitle: q.question, icon: 'activity' }))].filter(r => (r.label + ' ' + r.subtitle).toLowerCase().includes(q)).slice(0, 10); }
    const priorityRank = { Urgent: 0, High: 1, Normal: 2 };
    function sortedActions(s) { return vals(s.actions).filter(a => a.status === 'Open').sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || a.due.localeCompare(b.due)); }
    function ActionRows({ app, items, compact = false }) { const s = app.s(); return React.createElement("div", { className: 'action-rows ' + (compact ? 'compact' : '') }, items.length ? items.map(a => React.createElement("button", { className: "action-row", key: a.id, onClick: () => app.open(a.sourceType, a.sourceId) },
        React.createElement("span", { className: 'priority-dot ' + a.priority.toLowerCase() }),
        React.createElement("div", null,
            React.createElement("strong", null, a.title),
            React.createElement("small", null,
                a.trialId,
                " ",
                a.siteId ? '· ' + s.sites[a.siteId]?.city : '',
                " ",
                React.createElement("span", null,
                    "\u00B7 ",
                    formatDate(a.due)))),
        !compact && React.createElement(Badge, null, a.priority),
        React.createElement(Icon, { name: "right", size: 16 }))) : React.createElement(Empty, { title: "No open actions", text: "There is no outstanding work in this permitted scope." })); }
    function RecruitmentChart({ app }) { const s = app.s(); const participants = vals(s.participants).filter(p => p.enrolledAt); const n = app.state.chartMonths * 4; const dates = Array.from({ length: n + 1 }, (_, i) => Ayu.addDays(s.clock, -n * 7 + i * 7)); const counts = dates.map(d => participants.filter(p => p.enrolledAt <= d).length); const high = Math.max(50, Math.ceil(Math.max(...counts) / 50) * 50); const w = 650, h = 182, x = (i) => 43 + i * (w - 65) / n, y = (v) => h - 25 - v * (h - 43) / high; const line = counts.map((v, i) => (i ? 'L' : 'M') + x(i) + ',' + y(v)).join(' '); const area = line + ` L${x(n)},${h - 25} L${x(0)},${h - 25} Z`; return React.createElement("div", { className: "recruitment-chart" },
        React.createElement("div", { className: "chart-legend" },
            React.createElement("span", null,
                React.createElement("i", { className: "green-dot" }),
                " Cumulative enrolled participants"),
            React.createElement("strong", null,
                participants.length,
                " ",
                React.createElement("small", null, "enrolled"))),
        React.createElement("svg", { viewBox: `0 0 ${w} ${h}`, role: "img", "aria-labelledby": "recruitment-title" },
            React.createElement("title", { id: "recruitment-title" },
                "Cumulative enrollment from ",
                formatDate(dates[0]),
                " to ",
                formatDate(dates[n]),
                "; ",
                participants.length,
                " enrolled in this scope."),
            React.createElement("defs", null,
                React.createElement("linearGradient", { id: "area", x1: "0", y1: "0", x2: "0", y2: "1" },
                    React.createElement("stop", { offset: "0%", stopColor: "#147D64", stopOpacity: "0.18" }),
                    React.createElement("stop", { offset: "100%", stopColor: "#147D64", stopOpacity: "0.01" }))),
            [0, 1, 2, 3, 4].map(i => React.createElement("g", { key: i },
                React.createElement("line", { x1: "43", x2: "634", y1: y(i * high / 4), y2: y(i * high / 4), stroke: "#E9EEEC", strokeDasharray: "3 4" }),
                React.createElement("text", { x: "30", y: y(i * high / 4) + 4, textAnchor: "end", className: "chart-text" }, Math.round(i * high / 4)))),
            React.createElement("path", { d: area, fill: "url(#area)" }),
            React.createElement("path", { d: line, stroke: "#147D64", strokeWidth: "2.5", fill: "none", strokeLinejoin: "round" }),
            counts.map((v, i) => React.createElement("g", { key: i },
                React.createElement("circle", { cx: x(i), cy: y(v), r: i === n ? 4 : 2.3, fill: "#147D64", stroke: "white", strokeWidth: "1.5" },
                    React.createElement("title", null,
                        formatDate(dates[i]),
                        ": ",
                        v,
                        " enrolled")),
                (i === 0 || i === n || i % 4 === 0) && React.createElement("text", { x: x(i), y: h - 3, textAnchor: "middle", className: "chart-text" }, formatDate(dates[i]).slice(0, 6))))),
        React.createElement("details", { className: "chart-details" },
            React.createElement("summary", null, "View chart data"),
            React.createElement("div", { className: "chart-data" }, dates.map((d, i) => React.createElement("span", { key: d },
                formatDate(d),
                " ",
                React.createElement("b", null, counts[i])))))); }
    function Overview({ app }) {
        const s = app.s(), u = app.user(), m = metrics(s);
        const sites = vals(s.trialSites).filter(t => t.status === 'Active').sort((a, b) => (risk(s, b).score || 0) - (risk(s, a).score || 0));
        const highest = sites[0];
        const rr = highest ? risk(s, highest) : null;
        const primary = sortedActions(s);
        const upcoming = vals(s.compliance).filter(c => c.status !== 'Complete').sort((a, b) => a.due.localeCompare(b.due));
        const coord = u.role === 'Coordinator', pv = u.role === 'PV', monitor = u.role === 'Monitor', ethics = u.role === 'Ethics';
        return React.createElement("div", { className: "page-content" },
            highest && rr && rr.band === 'High' && React.createElement("div", { className: "attention-banner" },
                React.createElement("div", { className: "attention-icon" },
                    React.createElement(Icon, { name: "activity", size: 20 })),
                React.createElement("div", null,
                    React.createElement("strong", null,
                        s.sites[highest.siteId].city,
                        " needs a closer look"),
                    React.createElement("p", null,
                        rr.lateVisits,
                        " overdue visits, ",
                        rr.lateQueries,
                        " overdue queries, and recruitment below the expected-to-date plan.")),
                React.createElement(Badge, { tone: "amber" },
                    "Rule-based index \u00B7 ",
                    rr.score?.toFixed(0),
                    "/100"),
                React.createElement("button", { className: "text-btn", onClick: () => app.open('trialSite', highest.id) },
                    "Review site ",
                    React.createElement(Icon, { name: "arrow", size: 16 }))),
            React.createElement("div", { className: "stats-grid" }, pv ? React.createElement(React.Fragment, null,
                React.createElement(Statistic, { label: "Adverse-event episodes", value: m.ae, foot: "Includes serious episodes", icon: "shield", onClick: () => app.nav('safety') }),
                React.createElement(Statistic, { label: "Serious events", value: m.serious, foot: "Subset of total AE episodes", icon: "alert", accent: "urgent", onClick: () => app.nav('safety', 'Serious') }),
                React.createElement(Statistic, { label: "Open safety reviews", value: m.safetyReviews, foot: "Human PV review required", icon: "check", onClick: () => app.nav('safety', 'Open reviews') }),
                React.createElement(Statistic, { label: "Affected participants", value: new Set(vals(s.safety).map(c => c.participantId)).size, foot: "Distinct participant codes", icon: "users", onClick: () => app.nav('safety') })) : monitor ? React.createElement(React.Fragment, null,
                React.createElement(Statistic, { label: "Unresolved queries", value: m.queries, foot: "Linked to source visit fields", icon: "activity", onClick: () => app.nav('monitoring') }),
                React.createElement(Statistic, { label: "Awaiting verification", value: vals(s.queries).filter(q => q.status === 'Answered').length, foot: "Coordinator response received", icon: "check", onClick: () => app.nav('monitoring', 'Answered') }),
                React.createElement(Statistic, { label: "Overdue visits", value: m.overdueVisits, foot: "Operational follow-up needed", icon: "clock", accent: "urgent", onClick: () => app.nav('participants', 'Overdue', 'visits') }),
                React.createElement(Statistic, { label: "Open deviations", value: vals(s.deviations).filter(d => d.status === 'Open').length, foot: "Corrective action required", icon: "file", onClick: () => app.nav('monitoring', 'All', 'deviations') })) : ethics ? React.createElement(React.Fragment, null,
                React.createElement(Statistic, { label: "Submitted documents", value: vals(s.documents).filter(d => d.status === 'Submitted').length, foot: "Awaiting committee review", icon: "file", onClick: () => app.nav('compliance', 'Submitted', 'documents') }),
                React.createElement(Statistic, { label: "Approvals to track", value: vals(s.compliance).filter(c => c.kind === 'IEC' && c.status !== 'Complete').length, foot: "Recorded approval validity", icon: "calendar", onClick: () => app.nav('compliance') }),
                React.createElement(Statistic, { label: "Serious-event summaries", value: m.serious, foot: "De-identified case evidence", icon: "shield", onClick: () => app.nav('safety', 'Serious') }),
                React.createElement(Statistic, { label: "Permitted trials", value: m.trials, foot: "Assigned committee scope", icon: "flask", onClick: () => app.nav('trials') })) : React.createElement(React.Fragment, null,
                React.createElement(Statistic, { label: "Enrollment progress", value: m.enrolled, denominator: ' / ' + m.target, foot: React.createElement(React.Fragment, null,
                        React.createElement("span", { className: "positive" },
                            m.target ? (m.enrolled / m.target * 100).toFixed(1) : '0.0',
                            "%"),
                        " of scoped recruitment target"), icon: "users", accent: "enrollment", onClick: () => app.nav('participants', 'Enrolled') }),
                React.createElement(Statistic, { label: coord ? 'Screening candidates' : 'Active trials', value: coord ? vals(s.participants).filter(p => ['Screening', 'Eligible'].includes(p.status)).length : m.trials, foot: coord ? 'Eligibility and consent to review' : 'Studies in your permitted scope', icon: "flask", onClick: () => app.nav(coord ? 'participants' : 'trials', coord ? 'Screening' : 'All') }),
                React.createElement(Statistic, { label: "Active sites", value: m.uniqueSites, foot: `${m.activeAssociations} active trial-site associations`, icon: "building", onClick: () => app.nav('sites') }),
                React.createElement(Statistic, { label: "Overdue visits", value: m.overdueVisits, foot: "Protocol visits needing follow-up", icon: "clock", accent: "urgent", onClick: () => app.nav('participants', 'Overdue', 'visits') }))),
            React.createElement("div", { className: "dashboard-grid" },
                React.createElement(Panel, { title: pv ? 'Safety review queue' : monitor ? 'Queries needing follow-up' : coord ? 'Upcoming work at your sites' : 'Recruitment trajectory', subtitle: pv ? 'Serious events prioritized · sample deadlines' : monitor ? 'Resolve at source; monitors verify responses' : coord ? 'Visit and enrollment actions for assigned sites' : 'Dated participant records · current permitted scope', action: !pv && !monitor && !coord ? React.createElement("select", { "aria-label": "Recruitment chart range", className: "small-select", value: app.state.chartMonths, onChange: (e) => app.set({ chartMonths: Number(e.target.value) }) },
                        React.createElement("option", { value: 3 }, "Last 12 weeks"),
                        React.createElement("option", { value: 2 }, "Last 8 weeks"),
                        React.createElement("option", { value: 1 }, "Last 4 weeks")) : React.createElement(Button, { small: true, onClick: () => app.nav(pv ? 'safety' : monitor ? 'monitoring' : 'actions') }, "View all") }, pv || monitor || coord ? React.createElement(ActionRows, { app: app, items: primary.filter(a => pv ? a.sourceType === 'safety' : monitor ? a.sourceType === 'query' : ['participant', 'visit'].includes(a.sourceType)).slice(0, 5) }) : React.createElement(RecruitmentChart, { app: app })),
                React.createElement(Panel, { title: "Your next best actions", subtitle: "Prioritized work, not automated decisions", action: React.createElement("span", { className: "count-pill" },
                        primary.length,
                        " open") },
                    React.createElement(ActionRows, { app: app, items: primary.filter(a => pv ? a.sourceType === 'safety' : true).slice(0, 3), compact: true }),
                    React.createElement("div", { className: "panel-bottom" },
                        React.createElement("button", { className: "text-btn", onClick: () => app.nav('actions') },
                            "Open Action Center ",
                            React.createElement(Icon, { name: "arrow", size: 15 }))))),
            React.createElement("div", { className: "dashboard-grid" },
                React.createElement(Panel, { title: "Site performance", subtitle: "Operational signals across active trial-site associations", action: React.createElement("button", { className: "text-btn", onClick: () => app.nav('sites') },
                        "All sites ",
                        React.createElement(Icon, { name: "arrow", size: 15 })) },
                    React.createElement(Table, { heads: ['Site / Study', 'Enrollment', 'Overdue', 'Operational index'], footer: React.createElement(React.Fragment, null,
                            React.createElement("span", null,
                                m.uniqueSites,
                                " unique sites \u00B7 ",
                                m.activeAssociations,
                                " active associations"),
                            React.createElement("span", null, "Rule-based demo index")) }, sites.slice(0, 5).map(ts => { const r = risk(s, ts); return React.createElement("tr", { key: ts.id },
                        React.createElement("td", null,
                            React.createElement(RecordLink, { onClick: () => app.open('trialSite', ts.id) }, s.sites[ts.siteId].city),
                            React.createElement("small", { className: "cell-sub" }, ts.trialId)),
                        React.createElement("td", null,
                            React.createElement("span", { className: "tabular" },
                                r.enrollment,
                                React.createElement("span", { className: "muted" },
                                    " / ",
                                    ts.target ?? '—')),
                            React.createElement(Progress, { n: r.enrollment, d: ts.target || 0 })),
                        React.createElement("td", null,
                            React.createElement("span", { className: r.lateVisits ? 'text-amber' : '' },
                                r.lateVisits,
                                " visits"),
                            React.createElement("small", { className: "cell-sub" },
                                r.lateQueries,
                                " queries")),
                        React.createElement("td", null,
                            React.createElement("button", { className: "badge-button", onClick: () => app.open('trialSite', ts.id) },
                                React.createElement(Badge, null,
                                    r.band,
                                    " \u00B7 ",
                                    r.score?.toFixed(0) ?? '—')))); }))),
                React.createElement(Panel, { title: "On the horizon", subtitle: "Evidence and oversight deadlines" },
                    React.createElement("div", { className: "deadline-list" }, upcoming.slice(0, 3).map(c => React.createElement("button", { className: "deadline", key: c.id, onClick: () => app.open('compliance', c.id) },
                        React.createElement("div", { className: 'date-tile ' + (overdue(c, s.clock) ? 'late' : '') },
                            React.createElement("b", null, new Date(c.due).getUTCDate()),
                            React.createElement("span", null, new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' }).format(new Date(c.due)))),
                        React.createElement("div", null,
                            React.createElement("strong", null, c.title),
                            React.createElement("small", null,
                                c.trialId,
                                " \u00B7 ",
                                c.kind),
                            overdue(c, s.clock) && React.createElement("span", { className: "text-amber" }, "Overdue")),
                        React.createElement(Icon, { name: "right", size: 15 })))),
                    React.createElement("div", { className: "health-strip" },
                        React.createElement("button", { onClick: () => app.nav('safety', 'Open reviews') },
                            React.createElement(Icon, { name: "shield", size: 18 }),
                            React.createElement("div", null,
                                React.createElement("strong", null,
                                    m.safetyReviews,
                                    " open safety reviews"),
                                React.createElement("small", null,
                                    m.serious,
                                    " serious / ",
                                    m.ae,
                                    " total AE episodes")),
                            React.createElement(Icon, { name: "right", size: 15 })),
                        React.createElement("button", { onClick: () => app.nav('compliance', 'Overdue') },
                            React.createElement(Icon, { name: "file", size: 18 }),
                            React.createElement("div", null,
                                React.createElement("strong", null,
                                    m.complianceOverdue,
                                    " overdue compliance items"),
                                React.createElement("small", null, "Checklist tracking, not certification")),
                            React.createElement(Icon, { name: "right", size: 15 }))))),
            React.createElement("div", { className: "insight-strip" },
                React.createElement("div", { className: "insight-symbol" },
                    React.createElement(Icon, { name: "spark", size: 23 })),
                React.createElement("div", null,
                    React.createElement("strong", null, "From information to a clear next step."),
                    React.createElement("p", null, "Ask which sites need attention, what is overdue, or what is blocking activation.")),
                React.createElement(Button, { small: true, onClick: () => { app.set({ assistantOpen: true }); app.ask('Which sites need attention, and why?'); } },
                    "Explore demo assistant ",
                    React.createElement(Icon, { name: "arrow", size: 15 }))));
    }
    function Toolbar({ app, placeholder = 'Search records…', statuses = [], extra }) { return React.createElement("div", { className: "list-toolbar" },
        React.createElement("div", { className: "local-search" },
            React.createElement(Icon, { name: "search", size: 17 }),
            React.createElement("input", { "aria-label": "Search this list", placeholder: placeholder, value: app.state.query, onChange: (e) => app.set({ query: e.target.value, limit: 20 }) })),
        React.createElement("div", { className: "toolbar-controls" },
            statuses.length > 0 && React.createElement("select", { "aria-label": "Status filter", value: app.state.status, onChange: (e) => app.set({ status: e.target.value, limit: 20 }) }, ['All', ...statuses].map((v) => React.createElement("option", { key: v, value: v }, v === 'All' ? 'All statuses' : v))),
            React.createElement("select", { "aria-label": "Sort records", value: app.state.sort, onChange: (e) => app.set({ sort: e.target.value }) },
                React.createElement("option", { value: "default" }, "Default order"),
                React.createElement("option", { value: "asc" }, "Code / title A\u2013Z"),
                React.createElement("option", { value: "desc" }, "Code / title Z\u2013A")),
            extra)); }
    function sorted(rows, app, label) { return app.state.sort === 'default' ? rows : [...rows].sort((a, b) => (app.state.sort === 'desc' ? -1 : 1) * label(a).localeCompare(label(b))); }
    function Pager({ app, count }) { return React.createElement("div", { className: "pagination" },
        React.createElement("span", null,
            "Showing ",
            Math.min(count, app.state.limit),
            " of ",
            count,
            " records"),
        count > app.state.limit && React.createElement(Button, { small: true, onClick: () => app.set({ limit: app.state.limit + 20 }) }, "Show 20 more")); }
    function Tabs({ items, active, onChange }) { return React.createElement("div", { className: "tabs", role: "tablist" }, items.map((t) => React.createElement("button", { key: t[0], role: "tab", "aria-selected": active === t[0], className: active === t[0] ? 'active' : '', onClick: () => onChange(t[0]) },
        t[1],
        t[2] !== undefined && React.createElement("span", null, t[2])))); }
    function Trials({ app }) { const s = app.s(); const rows = sorted(vals(s.trials).filter(t => (t.title + ' ' + t.code).toLowerCase().includes(app.state.query.toLowerCase()) && (app.state.status === 'All' || t.status === app.state.status)), app, t => t.code); return React.createElement("div", { className: "page-content" },
        React.createElement(Toolbar, { app: app, placeholder: "Search a study title or short code\u2026", statuses: ['Draft', 'Setup', 'Recruiting', 'Active Follow-up', 'Close-out Review', 'Closed'] }),
        rows.length ? React.createElement("div", { className: "trial-grid" }, rows.map((t, i) => { const n = vals(s.participants).filter(p => p.trialId === t.id && p.enrolledAt).length; const sites = vals(s.trialSites).filter(ts => ts.trialId === t.id); const cases = vals(s.safety).filter(c => c.trialId === t.id && !['Reviewed', 'Closed'].includes(c.status)); return React.createElement("article", { className: "trial-card", key: t.id },
            React.createElement("div", { className: "trial-card-top" },
                React.createElement("span", { className: 'study-icon study-' + i },
                    React.createElement(Icon, { name: i === 2 ? 'leaf' : 'flask', size: 25 })),
                React.createElement(Badge, null, t.status)),
            React.createElement("div", { className: "eyebrow" }, t.code),
            React.createElement("button", { className: "title-link", onClick: () => app.open('trial', t.id) },
                React.createElement("h2", null, t.title)),
            React.createElement("p", null, t.design),
            React.createElement("div", { className: "trial-enrollment" },
                React.createElement("span", null, "Enrollment in permitted scope"),
                React.createElement("strong", null,
                    n,
                    React.createElement("small", null,
                        " / ",
                        t.target))),
            React.createElement(Progress, { n: n, d: t.target }),
            React.createElement("div", { className: "trial-facts" },
                React.createElement("span", null,
                    React.createElement(Icon, { name: "building", size: 15 }),
                    sites.filter(ts => ts.status === 'Active').length,
                    " active sites"),
                React.createElement("span", null,
                    React.createElement(Icon, { name: "shield", size: 15 }),
                    cases.length,
                    " open reviews")),
            React.createElement("div", { className: "trial-card-bottom" },
                React.createElement("span", null,
                    "Protocol ",
                    t.protocolVersion),
                React.createElement("button", { className: "text-btn", onClick: () => app.open('trial', t.id) },
                    "Open study ",
                    React.createElement(Icon, { name: "arrow", size: 16 })))); })) : React.createElement(Empty, { title: "No studies match these filters" }),
        React.createElement("div", { className: "notice" },
            React.createElement(Icon, { name: "info", size: 18 }),
            React.createElement("span", null, "Draft \u2192 Setup \u2192 Recruiting \u2192 Active Follow-up \u2192 Close-out Review \u2192 Closed. Readiness and review gates are configurable demo workflows."))); }
    function Sites({ app }) { const s = app.s(); const tab = app.state.tab || 'associations'; const rows = sorted(vals(s.trialSites).filter(t => (s.sites[t.siteId].city + ' ' + t.trialId).toLowerCase().includes(app.state.query.toLowerCase()) && (app.state.status === 'All' || t.status === app.state.status)), app, t => s.sites[t.siteId].city + t.trialId); return React.createElement("div", { className: "page-content" },
        React.createElement(Tabs, { active: tab, items: [["associations", "Trial-site associations", vals(s.trialSites).length], ["unique", "Unique sites", vals(s.sites).length]], onChange: (tab) => app.set({ tab, status: 'All', query: '' }) }),
        React.createElement(Toolbar, { app: app, placeholder: "Search a city or trial\u2026", statuses: ['Active', 'Pending'] }),
        tab === 'unique' ? React.createElement("div", { className: "site-grid" }, vals(s.sites).filter(site => site.city.toLowerCase().includes(app.state.query.toLowerCase())).map(site => React.createElement(Panel, { key: site.id, title: site.city, subtitle: site.name },
            React.createElement("div", { className: "pad" },
                React.createElement("p", { className: "muted" }, site.investigator),
                vals(s.trialSites).filter(t => t.siteId === site.id).map(t => React.createElement("button", { className: "site-assignment", key: t.id, onClick: () => app.open('trialSite', t.id) },
                    React.createElement("span", null, t.trialId),
                    React.createElement(Badge, null, t.status),
                    React.createElement(Icon, { name: "right", size: 16 }))))))) : React.createElement(Panel, { title: "Research site network", subtitle: "Site readiness is specific to each study assignment" },
            React.createElement(Table, { heads: ['Site / Trial', 'Enrollment / Target', 'Readiness', 'Overdue visits / queries', 'Operational index', 'Status'] }, rows.map(t => { const r = risk(s, t); return React.createElement("tr", { key: t.id },
                React.createElement("td", null,
                    React.createElement(RecordLink, { onClick: () => app.open('trialSite', t.id) }, s.sites[t.siteId].city),
                    React.createElement("small", { className: "cell-sub" }, t.trialId)),
                React.createElement("td", null,
                    r.enrollment,
                    " / ",
                    t.target ?? 'Not assigned'),
                React.createElement("td", null,
                    Object.values(t.readiness).filter(Boolean).length,
                    "/",
                    Object.keys(t.readiness).length,
                    " evidence items"),
                React.createElement("td", null,
                    r.lateVisits,
                    " visits ",
                    React.createElement("span", { className: "muted" },
                        "/ ",
                        r.lateQueries,
                        " queries")),
                React.createElement("td", null,
                    React.createElement(Badge, null,
                        r.band,
                        r.score !== null ? ' · ' + r.score.toFixed(1) : '')),
                React.createElement("td", null,
                    React.createElement(Badge, null, t.status))); })),
            !rows.length && React.createElement(Empty, { title: "No matching site assignments" }))); }
    function Participants({ app }) { const s = app.s(), tab = app.state.tab || 'participants'; let ps = vals(s.participants).sort((a, b) => (a.enrolledAt ? 1 : 0) - (b.enrolledAt ? 1 : 0) || a.code.localeCompare(b.code)); ps = sorted(ps.filter(p => (p.code + ' ' + p.screeningCode + ' ' + p.trialId).toLowerCase().includes(app.state.query.toLowerCase()) && (app.state.status === 'All' || p.status === app.state.status || (app.state.status === 'Screening' && p.status === 'Eligible'))), app, p => p.code); const visits = sorted(vals(s.visits).filter(v => (s.participants[v.participantId].code + ' ' + v.label).toLowerCase().includes(app.state.query.toLowerCase()) && (app.state.status === 'All' || (app.state.status === 'Overdue' ? overdue(v, s.clock) : v.status === app.state.status))).sort((a, b) => a.due.localeCompare(b.due)), app, v => s.participants[v.participantId].code + v.label); return React.createElement("div", { className: "page-content" },
        React.createElement(Tabs, { active: tab, items: [["participants", "Participants", vals(s.participants).length], ["visits", "Protocol visits", vals(s.visits).length]], onChange: (tab) => app.set({ tab, status: 'All', query: '', limit: 20 }) }),
        React.createElement(Toolbar, { app: app, placeholder: tab === 'visits' ? 'Search participant code or visit…' : 'Search screening or study code…', statuses: tab === 'visits' ? ['Scheduled', 'Overdue', 'Completed', 'Missed', 'Cancelled'] : ['Screening', 'Eligible', 'Enrolled', 'Screen Failed', 'Completed', 'Withdrawn'], extra: tab === 'visits' ? React.createElement(Button, { small: true, icon: app.state.calendar ? 'file' : 'calendar', onClick: () => app.set({ calendar: !app.state.calendar }) }, app.state.calendar ? 'List view' : 'Calendar') : null }),
        tab === 'participants' ? React.createElement(Panel, { title: "Participant records", subtitle: "Synthetic codes only \u00B7 screening records are outside enrolled totals" },
            React.createElement(Table, { heads: ['Participant / Screening code', 'Study / Site', 'Status', 'Eligibility', 'Consent', 'Next step'] }, ps.slice(0, app.state.limit).map(p => { const c = vals(s.consents).some(c => c.participantId === p.id && c.status === 'Recorded' && c.version === s.trials[p.trialId].consentVersion); return React.createElement("tr", { key: p.id },
                React.createElement("td", null,
                    React.createElement(RecordLink, { onClick: () => app.open('participant', p.id) }, p.code),
                    p.id === 'SCR-001' ? React.createElement("small", { className: "cell-sub positive" }, "Enrollment demo starts here") : p.screeningCode !== p.code ? React.createElement("small", { className: "cell-sub" }, p.screeningCode) : null),
                React.createElement("td", null,
                    p.trialId,
                    React.createElement("small", { className: "cell-sub" }, s.sites[p.siteId].city)),
                React.createElement("td", null,
                    React.createElement(Badge, null, p.status)),
                React.createElement("td", null, p.eligibility ? React.createElement("span", { className: "positive" }, "Recorded") : 'Pending'),
                React.createElement("td", null,
                    React.createElement(Badge, { tone: c ? 'green' : 'slate' }, c ? 'Recorded' : 'Not recorded')),
                React.createElement("td", null,
                    React.createElement("button", { className: "text-btn", onClick: () => app.open('participant', p.id) },
                        p.enrolledAt ? 'Open record' : 'Review screening',
                        " ",
                        React.createElement(Icon, { name: "right", size: 14 })))); })),
            !ps.length && React.createElement(Empty, { title: "No matching participants" }),
            React.createElement(Pager, { app: app, count: ps.length })) : app.state.calendar ? React.createElement(Panel, { title: "September 2026", subtitle: "Fixed demo month \u00B7 select a visit to record work" },
            React.createElement("div", { className: "calendar-grid" },
                ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => React.createElement("div", { className: "day-label", key: d }, d)),
                React.createElement("div", { className: "calendar-cell disabled" }),
                Array.from({ length: 30 }, (_, i) => { const d = '2026-09-' + String(i + 1).padStart(2, '0'); const items = visits.filter(v => v.due === d); return React.createElement("div", { className: 'calendar-cell ' + (d === day() ? 'today' : ''), key: d },
                    React.createElement("strong", null, i + 1),
                    items.slice(0, 2).map(v => React.createElement("button", { key: v.id, onClick: () => app.open('visit', v.id) },
                        v.label,
                        React.createElement("small", null, s.participants[v.participantId].code))),
                    items.length > 2 && React.createElement("button", { className: "text-btn", onClick: () => { app.set({ calendar: false, query: '', status: 'All' }); app.notify('List view includes all visits; sort by due date is the default.'); } },
                        "+",
                        items.length - 2,
                        " more")); })),
            React.createElement("p", { className: "pad muted" }, "List view includes protocol visits outside this displayed month.")) : React.createElement(Panel, { title: "Protocol visit schedule", subtitle: "Overdue is derived from a scheduled status and the fixed demo date" },
            React.createElement(Table, { heads: ['Participant', 'Visit', 'Study / Site', 'Due date', 'Status', 'Action'] }, visits.slice(0, app.state.limit).map(v => React.createElement("tr", { key: v.id },
                React.createElement("td", null,
                    React.createElement(RecordLink, { onClick: () => app.open('participant', v.participantId) }, s.participants[v.participantId].code)),
                React.createElement("td", null, v.label),
                React.createElement("td", null,
                    v.trialId,
                    React.createElement("small", { className: "cell-sub" }, s.sites[v.siteId].city)),
                React.createElement("td", null, formatDate(v.due)),
                React.createElement("td", null,
                    React.createElement(Badge, null, overdue(v, s.clock) ? 'Overdue' : v.status)),
                React.createElement("td", null,
                    React.createElement("button", { className: "text-btn", onClick: () => app.open('visit', v.id) },
                        can(app.user(), 'visit') ? 'Record visit' : 'View visit',
                        " ",
                        React.createElement(Icon, { name: "right", size: 14 })))))),
            !visits.length && React.createElement(Empty, { title: "No matching visits" }),
            React.createElement(Pager, { app: app, count: visits.length }))); }
    function Safety({ app }) { const s = app.s(), m = metrics(s); const rows = sorted(vals(s.safety).filter(c => (c.id + ' ' + c.term + ' ' + s.participants[c.participantId].code).toLowerCase().includes(app.state.query.toLowerCase()) && (app.state.status === 'All' || (app.state.status === 'Serious' ? c.serious : app.state.status === 'Open reviews' ? !['Reviewed', 'Closed'].includes(c.status) : c.status === app.state.status))), app, c => c.id); return React.createElement("div", { className: "page-content" },
        React.createElement("div", { className: "inline-metrics" },
            React.createElement("div", null,
                React.createElement("span", null, "Total AE episodes"),
                React.createElement("strong", null, m.ae)),
            React.createElement("div", null,
                React.createElement("span", null, "Serious episodes \u00B7 subset"),
                React.createElement("strong", null, m.serious)),
            React.createElement("div", null,
                React.createElement("span", null, "Open reviews"),
                React.createElement("strong", null, m.safetyReviews)),
            React.createElement("div", null,
                React.createElement("span", null, "Affected participants"),
                React.createElement("strong", null, new Set(vals(s.safety).map(c => c.participantId)).size))),
        React.createElement(Toolbar, { app: app, placeholder: "Search case, participant, or uncoded term\u2026", statuses: ['Serious', 'Open reviews', 'Submitted', 'Under Review', 'Follow-up Required', 'Reviewed', 'Closed'] }),
        React.createElement(Panel, { title: "Safety case register", subtitle: "Preliminary reports are supported. Unknown details can remain pending follow-up." },
            React.createElement(Table, { heads: ['Case / Event term', 'Participant / Site', 'Severity', 'Seriousness', 'Review status', 'Sample due date'] }, rows.slice(0, app.state.limit).map(c => React.createElement("tr", { key: c.id },
                React.createElement("td", null,
                    React.createElement(RecordLink, { onClick: () => app.open('safety', c.id) },
                        c.id,
                        " ",
                        React.createElement(Icon, { name: "arrowUp", size: 13 })),
                    React.createElement("small", { className: "cell-sub" }, c.term)),
                React.createElement("td", null,
                    s.participants[c.participantId].code,
                    React.createElement("small", { className: "cell-sub" }, s.sites[c.siteId].city)),
                React.createElement("td", null, c.severity),
                React.createElement("td", null,
                    React.createElement(Badge, { tone: c.serious ? 'red' : 'slate' }, c.serious ? 'Serious' : 'Not serious')),
                React.createElement("td", null,
                    React.createElement(Badge, null, c.status)),
                React.createElement("td", null, formatDate(c.deadline))))),
            !rows.length && React.createElement(Empty, { title: "No matching safety cases" }),
            React.createElement(Pager, { app: app, count: rows.length })),
        React.createElement("div", { className: "notice" },
            React.createElement(Icon, { name: "info", size: 18 }),
            React.createElement("span", null, "Severity is separate from seriousness. Event terms are uncoded demo terms; no causality or official MedDRA code is inferred."))); }
    function Monitoring({ app }) { const s = app.s(), tab = app.state.tab || 'queries'; const qs = sorted(vals(s.queries).filter(q => (q.id + ' ' + q.participantId).toLowerCase().includes(app.state.query.toLowerCase()) && (app.state.status === 'All' || q.status === app.state.status)), app, q => q.id); return React.createElement("div", { className: "page-content" },
        React.createElement(Tabs, { active: tab, items: [["queries", "Data queries", vals(s.queries).filter(q => q.status !== 'Closed').length], ["deviations", "Protocol deviations", vals(s.deviations).length], ["notes", "Monitoring history"]], onChange: (tab) => app.set({ tab, status: 'All', query: '' }) }),
        tab === 'queries' ? React.createElement(React.Fragment, null,
            React.createElement(Toolbar, { app: app, placeholder: "Search query or participant code\u2026", statuses: ['Open', 'Answered', 'Closed'] }),
            React.createElement(Panel, { title: "Query aging & follow-up", subtitle: "Coordinator answers \u2192 monitor verifies. Source-value changes retain response history." },
                React.createElement(Table, { heads: ['Query / Source field', 'Participant / Site', 'Due / Aging', 'Status', 'Next action'] }, qs.map(q => React.createElement("tr", { key: q.id },
                    React.createElement("td", null,
                        React.createElement(RecordLink, { onClick: () => app.open('query', q.id) }, q.id),
                        React.createElement("small", { className: "cell-sub" }, q.field)),
                    React.createElement("td", null,
                        s.participants[q.participantId].code,
                        React.createElement("small", { className: "cell-sub" }, s.sites[q.siteId].city)),
                    React.createElement("td", null,
                        formatDate(q.due),
                        overdue(q, s.clock) && React.createElement("small", { className: "cell-sub text-amber" },
                            Math.floor((Date.parse(day()) - Date.parse(q.due)) / 86400000),
                            " days overdue")),
                    React.createElement("td", null,
                        React.createElement(Badge, null, q.status)),
                    React.createElement("td", null,
                        React.createElement("button", { className: "text-btn", onClick: () => app.open('query', q.id) },
                            q.status === 'Answered' ? 'Verify response' : q.status === 'Closed' ? 'View history' : 'Answer query',
                            React.createElement(Icon, { name: "right", size: 14 })))))),
                !qs.length && React.createElement(Empty, { title: "No queries match these filters" }))) : tab === 'deviations' ? React.createElement(Panel, { title: "Protocol deviations", subtitle: "Corrective actions are recorded by the assigned monitor" },
            React.createElement(Table, { heads: ['Deviation', 'Site', 'Category', 'Discovered', 'Status', 'Action'] }, vals(s.deviations).map(d => React.createElement("tr", { key: d.id },
                React.createElement("td", null,
                    d.id,
                    React.createElement("small", { className: "cell-sub" }, d.description)),
                React.createElement("td", null, s.sites[d.siteId].city),
                React.createElement("td", null, d.category),
                React.createElement("td", null, formatDate(d.discovered)),
                React.createElement("td", null,
                    React.createElement(Badge, null, d.status)),
                React.createElement("td", null,
                    React.createElement("button", { className: "text-btn", onClick: () => app.open('deviation', d.id) },
                        "Review ",
                        React.createElement(Icon, { name: "right", size: 14 }))))))) : React.createElement(Panel, { title: "Monitoring observations & decision history", subtitle: "Recorded query responses, verification rationale, and corrective actions" },
            React.createElement(AuditList, { app: app, rows: vals(s.audit).filter(a => ['queryAnswer', 'queryVerify', 'deviation'].includes(a.operation)) }))); }
    function Compliance({ app }) { const s = app.s(), tab = app.state.tab || 'tracking'; const complete = vals(s.compliance).filter(c => c.status === 'Complete').length; const cs = sorted(vals(s.compliance).filter(c => (c.title + ' ' + c.trialId).toLowerCase().includes(app.state.query.toLowerCase()) && (app.state.status === 'All' || (app.state.status === 'Overdue' ? overdue(c, s.clock) : c.status === app.state.status))), app, c => c.title); const ds = sorted(vals(s.documents).filter(d => (d.title + ' ' + d.trialId).toLowerCase().includes(app.state.query.toLowerCase()) && (app.state.status === 'All' || d.status === app.state.status)), app, d => d.title); return React.createElement("div", { className: "page-content" },
        React.createElement("div", { className: "compliance-banner" },
            React.createElement(Icon, { name: "file", size: 25 }),
            React.createElement("div", null,
                React.createElement("strong", null,
                    complete,
                    " / ",
                    vals(s.compliance).length,
                    " checklist items complete"),
                React.createElement("p", null, "Operational tracking only. This is not a compliance certification or a verified legal assessment.")),
            React.createElement(Badge, { tone: "slate" },
                vals(s.compliance).length ? Math.round(complete / vals(s.compliance).length * 100) : 0,
                "% checklist completion")),
        React.createElement(Tabs, { active: tab, items: [["tracking", "Tracking items", vals(s.compliance).length], ["documents", "Document versions", vals(s.documents).length]], onChange: (tab) => app.set({ tab, status: 'All', query: '' }) }),
        React.createElement(Toolbar, { app: app, statuses: tab === 'tracking' ? ['Open', 'Overdue', 'Complete'] : ['Submitted', 'Approved', 'Changes requested', 'Superseded'] }),
        tab === 'tracking' ? React.createElement(Panel, { title: "Evidence & deadlines", subtitle: "IEC, protocol, consent, training, and registration are tracked as study records" },
            React.createElement(Table, { heads: ['Tracking item', 'Scope', 'Owner', 'Due date', 'Status', 'Evidence'] }, cs.map(c => React.createElement("tr", { key: c.id },
                React.createElement("td", null,
                    React.createElement(RecordLink, { onClick: () => app.open('compliance', c.id) }, c.title),
                    React.createElement("small", { className: "cell-sub" }, c.kind)),
                React.createElement("td", null,
                    c.trialId,
                    React.createElement("small", { className: "cell-sub" }, c.siteId ? s.sites[c.siteId].city : 'Trial level')),
                React.createElement("td", null, s.users[c.owner]?.name || c.owner),
                React.createElement("td", null, formatDate(c.due)),
                React.createElement("td", null,
                    React.createElement(Badge, null, overdue(c, s.clock) ? 'Overdue' : c.status)),
                React.createElement("td", null,
                    React.createElement("button", { className: "text-btn", onClick: () => app.open('document', c.documentId) },
                        "View evidence ",
                        React.createElement(Icon, { name: "arrowUp", size: 14 })))))),
            !cs.length && React.createElement(Empty, { title: "No matching tracking items" })) : React.createElement(Panel, { title: "Versioned document library", subtitle: "Synthetic text previews and decision history; uploads are not automatically verified" },
            React.createElement(Table, { heads: ['Document', 'Study', 'Version / Family', 'State', 'Review comments', 'Action'] }, ds.map(d => React.createElement("tr", { key: d.id },
                React.createElement("td", null,
                    React.createElement(RecordLink, { onClick: () => app.open('document', d.id) }, d.title),
                    React.createElement("small", { className: "cell-sub" }, d.id)),
                React.createElement("td", null, d.trialId),
                React.createElement("td", null,
                    "v",
                    d.version,
                    React.createElement("small", { className: "cell-sub" }, d.family)),
                React.createElement("td", null,
                    React.createElement(Badge, null, d.status)),
                React.createElement("td", null, d.comments.length),
                React.createElement("td", null,
                    React.createElement("button", { className: "text-btn", onClick: () => app.open('document', d.id) },
                        "Open version ",
                        React.createElement(Icon, { name: "right", size: 14 })))))),
            !ds.length && React.createElement(Empty, { title: "No matching document versions" }))); }
    function RiskBreakdown({ s, ts }) { const r = risk(s, ts); return React.createElement("div", { className: "risk-breakdown" },
        React.createElement("div", { className: "risk-score" },
            React.createElement("strong", null,
                r.score === null ? '—' : r.score.toFixed(1),
                React.createElement("span", null, "/100")),
            React.createElement("div", null,
                React.createElement(Badge, null, r.band),
                React.createElement("p", null, "Rule-based demo index \u00B7 not a probability"))),
        r.contributions.map(c => React.createElement("div", { className: "contribution", key: c.label },
            React.createElement("div", null,
                React.createElement("span", null, c.label),
                React.createElement("strong", null,
                    c.points.toFixed(2),
                    React.createElement("small", null,
                        " / ",
                        c.max))),
            React.createElement("div", { className: "contribution-track" },
                React.createElement("span", { style: { width: 100 * c.points / c.max + '%' } })),
            React.createElement("code", null, c.formula))),
        React.createElement("details", { className: "methodology" },
            React.createElement("summary", null, "Formula, denominators & source records"),
            React.createElement("p", null, "Recruitment: 50 \u00D7 clamp(1 \u2212 enrolled / expected-to-date, 0, 1). If expected enrollment is zero, its contribution is zero. Missing expected enrollment produces \u201CInsufficient data.\u201D"),
            React.createElement("p", null, "Visits due = non-cancelled visits dated on or before the demo date. Overdue visits = scheduled visits dated before that date. Unresolved queries include Open and Answered. A query is overdue when its due date has passed and it is not Closed."),
            React.createElement("p", null,
                "Low < 30; Watch 30\u201359.99; High \u2265 60. Contributions are rules, not SHAP output. Source: ",
                ts.id,
                ", linked participants, visits, and queries. Data clock: ",
                formatDate(s.clock),
                "."))); }
    function Intelligence({ app }) { const s = app.s(); const groups = {}; vals(s.safety).filter(c => c.onset >= day(-30)).forEach(c => { const k = c.trialId + '|' + c.siteId + '|' + c.term; (groups[k] ||= []).push(c); }); return React.createElement("div", { className: "page-content" },
        React.createElement("div", { className: "intelligence-heading" },
            React.createElement("span", { className: "eyebrow" }, "PREDICT"),
            React.createElement("h2", null, "Operational risk, with the reasoning visible."),
            React.createElement("p", null, "Current records drive each contribution. Nothing here is a clinical recommendation.")),
        React.createElement("div", { className: "risk-grid" }, vals(s.trialSites).sort((a, b) => (risk(s, b).score ?? -1) - (risk(s, a).score ?? -1)).map(ts => React.createElement(Panel, { key: ts.id, title: s.sites[ts.siteId].city + ' · ' + ts.trialId, subtitle: ts.id, action: React.createElement("button", { className: "icon-btn", "aria-label": 'Open ' + ts.id, onClick: () => app.open('trialSite', ts.id) },
                React.createElement(Icon, { name: "arrowUp", size: 17 })) },
            React.createElement(RiskBreakdown, { s: s, ts: ts })))),
        React.createElement("div", { className: "intelligence-heading" },
            React.createElement("span", { className: "eyebrow" }, "DETECT"),
            React.createElement("h2", null, "Safety pattern radar"),
            React.createElement("p", null, "Descriptive 30-day counts. Sample highlighting threshold: at least 3 episodes with the same term, trial, and site.")),
        React.createElement(Panel, { title: "Potential patterns \u2014 require PV review", subtitle: "Event episodes and affected participants are counted separately; no causality is inferred" },
            React.createElement(Table, { heads: ['Event term / Scope', 'Episodes', 'Affected / Enrolled', 'Serious episodes', 'Interpretation', 'Review'] }, Object.entries(groups).sort((a, b) => b[1].length - a[1].length).map(([k, cases]) => { const first = cases[0]; const denom = vals(s.participants).filter(p => p.trialId === first.trialId && p.siteId === first.siteId && p.enrolledAt).length; return React.createElement("tr", { key: k },
                React.createElement("td", null,
                    React.createElement("strong", null, first.term),
                    React.createElement("small", { className: "cell-sub" },
                        first.trialId,
                        " \u00B7 ",
                        s.sites[first.siteId].city)),
                React.createElement("td", null,
                    cases.length,
                    React.createElement("div", { className: "radar-bar", style: { width: Math.max(8, cases.length * 16) + 'px' } })),
                React.createElement("td", null,
                    new Set(cases.map(c => c.participantId)).size,
                    " / ",
                    denom,
                    React.createElement("small", { className: "cell-sub" }, "Small denominator visible")),
                React.createElement("td", null, cases.filter(c => c.serious).length),
                React.createElement("td", null,
                    React.createElement(Badge, { tone: cases.length >= 3 ? 'amber' : 'slate' }, cases.length >= 3 ? 'Potential pattern' : 'Descriptive count')),
                React.createElement("td", null,
                    React.createElement("button", { className: "text-btn", onClick: () => app.open('pattern', undefined, { cases: cases.map(c => c.id) }) },
                        "Inspect cases ",
                        React.createElement(Icon, { name: "right", size: 14 })))); }))),
        React.createElement("div", { className: "notice" },
            React.createElement(Icon, { name: "spark", size: 18 }),
            React.createElement("span", null, "XGBoost / LightGBM, SHAP, and LLM integration remain future architecture notes. Current intelligence uses transparent deterministic handlers."))); }
    function Actions({ app }) { const s = app.s(), u = app.user(); const tab = app.state.tab || 'all'; let rows = vals(s.actions).filter(a => (app.state.status === 'All' ? a.status === 'Open' : app.state.status === a.status || app.state.status === a.priority) && (tab !== 'mine' || a.owner === u.id) && (a.title + ' ' + a.reason + ' ' + a.sourceId).toLowerCase().includes(app.state.query.toLowerCase())); rows = sorted(rows.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || a.due.localeCompare(b.due)), app, a => a.title); return React.createElement("div", { className: "page-content" },
        React.createElement(Tabs, { active: tab, items: [["all", "All permitted work"], ["mine", "Assigned to me", vals(s.actions).filter(a => a.owner === u.id && a.status === 'Open').length]], onChange: (tab) => app.set({ tab }) }),
        React.createElement(Toolbar, { app: app, placeholder: "Search action, reason, or source record\u2026", statuses: ['Urgent', 'High', 'Normal', 'Open', 'Complete'] }),
        React.createElement(Panel, { title: "Operational queue", subtitle: "Tasks complete through validated source workflows, never by a generic checkbox" },
            React.createElement(Table, { heads: ['Priority', 'Action / Why it matters', 'Scope / Owner', 'Due', 'Status', 'Next step'] }, rows.slice(0, app.state.limit).map(a => React.createElement("tr", { key: a.id },
                React.createElement("td", null,
                    React.createElement(Badge, null, a.priority)),
                React.createElement("td", null,
                    React.createElement(RecordLink, { onClick: () => app.open('action', a.id) }, a.title),
                    React.createElement("small", { className: "cell-sub wrap" }, a.reason)),
                React.createElement("td", null,
                    a.trialId,
                    a.siteId ? ' · ' + s.sites[a.siteId].city : '',
                    React.createElement("small", { className: "cell-sub" }, s.users[a.owner]?.name || a.owner)),
                React.createElement("td", { className: a.status === 'Open' && a.due < day() ? 'text-amber' : '' }, formatDate(a.due)),
                React.createElement("td", null,
                    React.createElement(Badge, null, a.status)),
                React.createElement("td", null,
                    React.createElement("button", { className: "text-btn", onClick: () => app.open(a.sourceType, a.sourceId) },
                        a.nextAction,
                        React.createElement(Icon, { name: "right", size: 14 })))))),
            !rows.length && React.createElement(Empty, { title: "No matching action items" }),
            React.createElement(Pager, { app: app, count: rows.length }))); }
    function AuditList({ app, rows }) { return rows.length ? React.createElement("div", { className: "audit-list" }, rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, app.state.limit).map(a => React.createElement("button", { className: "audit-row", key: a.id, onClick: () => app.open('audit', a.id) },
        React.createElement("span", { className: "audit-icon" },
            React.createElement(Icon, { name: "check", size: 17 })),
        React.createElement("div", null,
            React.createElement("strong", null,
                a.operation,
                " ",
                React.createElement("span", null,
                    "\u00B7 ",
                    a.entityId)),
            React.createElement("p", null, a.reason),
            React.createElement("small", null,
                app.s().users[a.actor]?.name || a.actor,
                " \u00B7 ",
                ROLE_NAMES[a.role],
                " \u00B7 ",
                new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Kolkata' }).format(new Date(a.createdAt)),
                " IST")),
        React.createElement(Icon, { name: "right", size: 16 })))) : React.createElement(Empty, { title: "No recorded decisions yet", text: "Complete an authorized workflow to see its append-only local audit event here." }); }
    function Reports({ app }) { const s = app.s(), kind = app.state.reportKind; const rows = Ayu.report(s, kind).filter(r => JSON.stringify(r).toLowerCase().includes(app.state.query.toLowerCase())); const heads = rows.length ? Object.keys(rows[0]).filter(k => !['before', 'after'].includes(k)) : []; return React.createElement("div", { className: "page-content reports-page" },
        React.createElement("div", { className: "report-actions" },
            React.createElement("label", { className: "field inline-field" },
                React.createElement("span", null, "Report type"),
                React.createElement("select", { "aria-label": "Report type", value: kind, onChange: (e) => app.set({ reportKind: e.target.value, query: '', limit: 20 }) }, ['Recruitment', 'Site performance', 'Safety', 'Compliance', 'Audit'].map(v => React.createElement("option", { key: v }, v)))),
            React.createElement("div", { className: "button-row" },
                React.createElement(Button, { icon: "download", onClick: () => app.export('csv') }, "Export CSV"),
                React.createElement(Button, { icon: "download", onClick: () => app.export('json') }, "Export JSON"),
                React.createElement(Button, { icon: "print", onClick: () => app.run(async () => { await app.repo.reload(); window.print(); }, 'Current permitted summary prepared for printing.') }, "Print summary"))),
        React.createElement("div", { className: "print-heading" },
            React.createElement("h1", null,
                "AYUSETU \u00B7 ",
                kind,
                " report"),
            React.createElement("p", null,
                "Synthetic demo data \u00B7 ",
                app.scopeLabel()),
            React.createElement("p", null,
                "Generated at fixed demo clock: ",
                formatDate(s.clock),
                " \u00B7 09:30 IST")),
        React.createElement("div", { className: "report-summary" },
            React.createElement("div", null,
                React.createElement("span", null, "Report scope"),
                React.createElement("strong", null, app.scopeLabel())),
            React.createElement("div", null,
                React.createElement("span", null, "Current permitted records"),
                React.createElement("strong", null, Ayu.report(s, kind).length)),
            React.createElement("div", null,
                React.createElement("span", null, "Generated at demo clock"),
                React.createElement("strong", null, "28 Sep 2026 \u00B7 09:30 IST"))),
        React.createElement(Toolbar, { app: app, placeholder: "Filter the on-screen report preview\u2026" }),
        React.createElement(Panel, { title: kind === 'Audit' ? 'Read-only audit history' : kind + ' report preview', subtitle: "Downloads include all current permitted records in the trial/site scope; text search filters only this preview." },
            kind === 'Audit' ? React.createElement(AuditList, { app: app, rows: vals(s.audit).filter(a => JSON.stringify(a).toLowerCase().includes(app.state.query.toLowerCase())) }) : React.createElement(Table, { heads: heads.map(h => h.replaceAll('_', ' ')) }, rows.slice(0, app.state.limit).map((r, i) => React.createElement("tr", { key: i }, heads.map(h => React.createElement("td", { key: h }, r[h] === null ? 'Not assigned' : typeof r[h] === 'boolean' ? (r[h] ? 'Yes' : 'No') : String(r[h])))))),
            !rows.length && kind !== 'Audit' && React.createElement(Empty, { title: "No records for this report" }),
            React.createElement(Pager, { app: app, count: rows.length })),
        React.createElement("div", { className: "notice" },
            React.createElement(Icon, { name: "lock", size: 18 }),
            React.createElement("span", null, kind === 'Audit' ? 'Clinical audit events are recorded by the authenticated server actor and persisted in SQLite. This prototype is not a tamper-evident or validated audit system.' : 'Exports are synthetic and unvalidated. A basic CSV is not a validated SDTM/ADaM submission package.'))); }
    function Admin({ app }) {
        const s = app.s(), u = app.user();
        if (u.role !== 'Admin')
            return React.createElement(Empty, { title: "Permission denied", text: "Administration is available only to the Administrator demo identity." });
        const tab = app.state.tab || 'settings';
        return React.createElement("div", { className: "page-content" },
            React.createElement(Tabs, { active: tab, items: [["settings", "Workspace settings"], ["users", "Accounts & access"], ["integrations", "Integration previews"]], onChange: (tab) => app.set({ tab }) }),
            tab === 'settings' ? React.createElement("div", { className: "two-columns" },
                React.createElement(Panel, { title: "Deterministic demo settings", subtitle: "Dates do not drift with the real-world clock" },
                    React.createElement("form", { className: "pad", onSubmit: (e) => { const f = dataOf(e); app.run(() => app.repo.settings(u.id, Number(f.hours), Number(f.days)), 'Sample task deadlines updated.'); } },
                        React.createElement("div", { className: "fixed-clock" },
                            React.createElement(Icon, { name: "clock", size: 25 }),
                            React.createElement("div", null,
                                React.createElement("strong", null, "28 September 2026 \u00B7 09:30 IST"),
                                React.createElement("small", null, "Fixed for reproducible overdue calculations"))),
                        React.createElement("div", { className: "notice amber" },
                            React.createElement(Icon, { name: "info", size: 17 }),
                            React.createElement("span", null, "These are sample operational rules, not legal reporting time limits. Changes apply only to new safety reports.")),
                        React.createElement(Field, { label: "Serious-case review deadline (hours)", name: "hours", type: "number", value: s.settings.seriousHours, min: 1, max: 720, required: true }),
                        React.createElement(Field, { label: "Routine-case review deadline (days)", name: "days", type: "number", value: s.settings.routineDays, min: 1, max: 90, required: true }),
                        React.createElement(Button, { type: "submit", variant: "primary" }, "Save sample rules"))),
                React.createElement(Panel, { title: "Reset the scenario", subtitle: "Synthetic data only" },
                    React.createElement("div", { className: "pad" },
                        React.createElement("p", null, "Restore 3 studies, 5 unique sites, 190 enrolled participants, 12 screening candidates, 6 screen-failed candidates, and 10 adverse-event episodes including 2 serious."),
                        React.createElement("p", { className: "muted" }, "Reset restores the synthetic clinical scenario and removes uploaded document content. It preserves account passwords, account status, assignments, clinical audit history, and restricted security history."),
                        React.createElement(Button, { icon: "refresh", variant: "danger", onClick: () => app.open('reset') }, "Reset demo"),
                        React.createElement("hr", null),
                        React.createElement("h3", null, "Prototype boundaries"),
                        React.createElement("p", { className: "muted" }, "Server-verified authentication and revocable sessions are active. Clinical records and accounts persist in SQLite. OTP/recovery delivery is simulated only in the isolated demo outbox. Production security review, clinical governance, and validated integrations remain separate work.")))) : tab === 'users' ? React.createElement(AyuAuthUI.AccountAdmin, { app: app }) : React.createElement(React.Fragment, null,
                React.createElement("div", { className: "integration-grid" }, vals(s.integrations).map(i => React.createElement(Panel, { key: i.id, title: i.name, action: React.createElement(Badge, null, i.status) },
                    React.createElement("div", { className: "pad" },
                        React.createElement("p", { className: "muted" }, i.description),
                        i.lastRun && React.createElement("small", null,
                            "Last local run: ",
                            formatDate(i.lastRun)),
                        React.createElement(Button, { icon: i.id === 'edc' ? 'upload' : 'file', onClick: () => app.open(i.id === 'edc' ? 'import' : 'integration', i.id) }, i.id === 'edc' ? 'Run sample import' : i.id === 'fhir' ? 'View FHIR-shaped JSON' : i.id === 'cdisc' ? 'View mapping preview' : 'View adapter details'))))),
                React.createElement("div", { className: "notice" },
                    React.createElement(Icon, { name: "lock", size: 18 }),
                    React.createElement("span", null, "No connector is live. No data is sent to CTRI, ABDM, an authority, or any external service."))));
    }
    function RecordDialog({ app }) {
        const s = app.s(), u = app.user(), d = app.state.dialog, id = d.id || '';
        let title = 'Record details', subtitle = 'Demo · Synthetic data', body = null;
        const allow = (op) => can(u, op);
        const audit = (entityId) => React.createElement(Button, { small: true, icon: "clock", onClick: () => { app.nav('reports'); app.set({ reportKind: 'Audit', query: entityId }); } }, "View audit history");
        const missing = () => React.createElement(Empty, { title: "Record not available", text: "This record does not exist in your current permitted scope. Clear incompatible filters or contact your Administrator about assignments." });
        if (d.type === 'participant') {
            const p = s.participants[id];
            title = p ? p.code : 'Participant';
            subtitle = p ? p.trialId + ' · ' + s.sites[p.siteId].city + ' · Synthetic participant' : subtitle;
            if (!p)
                body = missing();
            else {
                const consent = vals(s.consents).filter(c => c.participantId === id);
                const latest = consent[consent.length - 1];
                const valid = consent.some(c => c.status === 'Recorded' && c.version === s.trials[p.trialId].consentVersion);
                const visits = vals(s.visits).filter(v => v.participantId === id);
                body = React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "record-summary" },
                        React.createElement(Badge, null, p.status),
                        React.createElement("span", null,
                            "Screening code ",
                            React.createElement("b", null, p.screeningCode)),
                        audit(id)),
                    React.createElement("h3", null, "Enrollment readiness"),
                    React.createElement(CheckRow, { ok: p.eligibility, title: "Eligibility review", detail: p.reviewer ? 'Reviewed by ' + s.users[p.reviewer]?.name : 'Authorized reviewer not recorded', action: !p.enrolledAt && allow('eligibility') ? React.createElement(Button, { small: true, onClick: () => app.open('eligibility', id) }, "Record review") : undefined }),
                    React.createElement(CheckRow, { ok: valid, title: 'Recorded consent · v' + s.trials[p.trialId].consentVersion, detail: latest ? formatDate(latest.date) + ' · demo record, not an electronic signature' : 'Consent is required before enrollment', action: !p.enrolledAt && allow('consent') ? React.createElement(Button, { small: true, onClick: () => app.open('consent', id) }, "Record consent") : undefined }),
                    app.state.fields.consent && React.createElement("p", { className: "field-error", "data-testid": "consent-gate" }, app.state.fields.consent),
                    React.createElement(CheckRow, { ok: s.trials[p.trialId].status === 'Recruiting' && s.trialSites[p.trialId + '-' + p.siteId]?.status === 'Active', title: "Active recruiting study and site", detail: "Configured readiness and capacity rules apply" }),
                    !p.enrolledAt && allow('enroll') && React.createElement("div", { className: "form-actions" },
                        React.createElement(Button, { variant: "primary", icon: "users", onClick: () => app.run(() => app.repo.enroll(u.id, id), 'Enrollment saved exactly once; linked protocol visits created.', () => app.open('participant', id)) }, "Enroll participant"),
                        React.createElement("small", null, "Eligibility, consent, readiness, and capacity are checked again by the service.")),
                    p.enrolledAt && React.createElement("div", { className: "success-banner" },
                        React.createElement(Icon, { name: "check", size: 20 }),
                        React.createElement("span", null,
                            "Enrolled ",
                            formatDate(p.enrolledAt),
                            " \u00B7 ",
                            visits.length,
                            " linked protocol visits \u00B7 screening history retained")),
                    React.createElement("h3", null, "Protocol visits"),
                    visits.length ? React.createElement(Table, { heads: ['Visit', 'Due date', 'Status', 'Record'] }, visits.map(v => React.createElement("tr", { key: v.id },
                        React.createElement("td", null, v.label),
                        React.createElement("td", null, formatDate(v.due)),
                        React.createElement("td", null,
                            React.createElement(Badge, null, overdue(v, s.clock) ? 'Overdue' : v.status)),
                        React.createElement("td", null,
                            React.createElement("button", { className: "text-btn", onClick: () => app.open('visit', v.id) },
                                "Open ",
                                React.createElement(Icon, { name: "right", size: 14 })))))) : React.createElement("p", { className: "muted" }, "Protocol visits are generated after successful enrollment."),
                    allow('safetyCreate') && React.createElement("div", { className: "button-row pad-top" },
                        React.createElement(Button, { icon: "shield", onClick: () => app.open('newSafety', id) }, "Report an adverse event")),
                    React.createElement("h3", null, "Screening & consent history"),
                    React.createElement("div", { className: "timeline" },
                        p.history.map((h, i) => React.createElement("div", { className: "timeline-item", key: i },
                            React.createElement("strong", null, h.status),
                            React.createElement("small", null, formatDate(h.at)),
                            React.createElement("p", null, h.note))),
                        consent.map(c => React.createElement("div", { className: "timeline-item", key: c.id },
                            React.createElement("strong", null,
                                "Consent metadata recorded \u00B7 v",
                                c.version),
                            React.createElement("small", null, formatDate(c.date)),
                            React.createElement("p", null,
                                c.id,
                                " \u00B7 ",
                                s.users[c.recordedBy]?.name)))));
            }
        }
        else if (d.type === 'eligibility') {
            title = 'Record eligibility review';
            const p = s.participants[id];
            body = p ? React.createElement("form", { onSubmit: (e) => { const f = dataOf(e); app.run(() => app.repo.eligibility(u.id, id, f.eligible === 'yes', f.reason), 'Eligibility review recorded.', () => app.open('participant', id)); } },
                React.createElement("p", { className: "muted" },
                    p.code,
                    " \u00B7 ",
                    s.trials[p.trialId].eligibility),
                React.createElement(Field, { label: "Protocol eligibility checklist", required: true },
                    React.createElement("select", { name: "eligible", defaultValue: "yes" },
                        React.createElement("option", { value: "yes" }, "Complete \u2014 candidate is eligible"),
                        React.createElement("option", { value: "no" }, "Reviewed \u2014 screen failed"))),
                React.createElement(Field, { label: "Review rationale", required: true },
                    React.createElement("textarea", { name: "reason", required: true, placeholder: "Record your protocol-based review rationale\u2026" })),
                React.createElement("div", { className: "notice" },
                    React.createElement(Icon, { name: "info", size: 17 }),
                    React.createElement("span", null,
                        "Reviewer identity is recorded as ",
                        u.name,
                        ". The app does not determine eligibility.")),
                React.createElement(Button, { type: "submit", variant: "primary" }, "Save eligibility review")) : missing();
        }
        else if (d.type === 'consent') {
            title = 'Record consent metadata';
            const p = s.participants[id];
            body = p ? React.createElement("form", { onSubmit: (e) => { const f = dataOf(e); app.run(() => app.repo.consent(u.id, id, f.version, f.date), 'Consent metadata recorded locally.', () => app.open('participant', id)); } },
                React.createElement("div", { className: "notice amber" },
                    React.createElement(Icon, { name: "info", size: 18 }),
                    React.createElement("span", null, "This records a synthetic consent workflow only. It is not a real electronic signature.")),
                React.createElement("p", null,
                    React.createElement("strong", null, p.code),
                    " \u00B7 ",
                    p.trialId),
                React.createElement("div", { className: "form-grid" },
                    React.createElement(Field, { name: "version", label: "Consent version", value: s.trials[p.trialId].consentVersion, required: true }),
                    React.createElement(Field, { name: "date", label: "Recorded consent date", type: "date", value: day(), max: day(), required: true })),
                React.createElement("label", { className: "checkbox-line" },
                    React.createElement("input", { type: "checkbox", required: true }),
                    " I confirm this is a synthetic demo consent record."),
                React.createElement(Button, { type: "submit", variant: "primary" }, "Save consent record")) : missing();
        }
        else if (d.type === 'screen') {
            title = 'New synthetic screening';
            body = React.createElement("form", { onSubmit: (e) => { const f = dataOf(e); const [trialId, siteId] = f.association.split('|'); app.run(() => app.repo.screen(u.id, { trialId, siteId }), 'Synthetic screening candidate created.', p => app.open('participant', p.id)); } },
                React.createElement(Field, { label: "Assigned trial / site", required: true },
                    React.createElement("select", { name: "association" }, vals(s.trialSites).map(ts => React.createElement("option", { key: ts.id, value: ts.trialId + '|' + ts.siteId },
                        ts.trialId,
                        " \u00B7 ",
                        s.sites[ts.siteId].city,
                        " \u00B7 ",
                        ts.status)))),
                React.createElement("p", { className: "muted" }, "A stable synthetic screening code is generated locally. No name, contact information, Aadhaar, or real health identifier is collected."),
                React.createElement(Button, { type: "submit", variant: "primary" }, "Create screening record"));
        }
        else if (d.type === 'visit') {
            const v = s.visits[id];
            title = v ? v.label + ' visit' : 'Visit';
            subtitle = v ? s.participants[v.participantId].code + ' · ' + v.trialId : subtitle;
            body = v ? React.createElement(React.Fragment, null,
                React.createElement("div", { className: "record-summary" },
                    React.createElement(Badge, null, overdue(v, s.clock) ? 'Overdue' : v.status),
                    React.createElement("span", null,
                        "Due ",
                        formatDate(v.due)),
                    audit(id)),
                React.createElement("p", { className: "muted" }, "Protocol-defined observations only. No automated clinical decision or treatment recommendation."),
                allow('visit') ? React.createElement("form", { onSubmit: (e) => { const f = dataOf(e); app.run(() => app.repo.visit(u.id, id, f.status, f.observations), 'Visit, linked action, and derived metrics updated.', 'close'); } },
                    React.createElement(Field, { label: "Visit status" },
                        React.createElement("select", { name: "status", defaultValue: v.status === 'Scheduled' ? 'Completed' : v.status }, ['Completed', 'Missed', 'Cancelled', 'Scheduled'].map(st => React.createElement("option", { key: st }, st)))),
                    React.createElement(Field, { label: "Protocol observations / reason", required: true },
                        React.createElement("textarea", { name: "observations", defaultValue: v.observations, placeholder: "Record synthetic protocol observations or explain the missed/cancelled visit\u2026", required: true })),
                    React.createElement(Button, { type: "submit", variant: "primary" }, "Save visit record")) : React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "notice" },
                        React.createElement(Icon, { name: "lock", size: 17 }),
                        React.createElement("span", null, "Your role can inspect this visit but cannot edit source observations.")),
                    React.createElement("pre", { className: "document-preview" }, v.observations || 'No observations recorded.'))) : missing();
        }
        else if (d.type === 'newSafety') {
            title = 'Report an adverse event';
            subtitle = 'Initial safety capture · unknown details can remain pending follow-up';
            body = React.createElement("form", { onSubmit: (e) => { const f = dataOf(e); app.run(() => app.repo.safetyCreate(u.id, { participantId: f.participantId, term: f.term, description: f.description, onset: f.onset, awareness: f.awareness, severity: f.severity, serious: f.serious === 'yes', criterion: f.serious === 'yes' ? f.criterion : 'Not serious', outcome: f.outcome, interventionAction: f.interventionAction }), 'Safety case submitted; linked PV review action and in-app notification created.', c => app.open('safety', c.id)); } },
                React.createElement("div", { className: "form-grid" },
                    React.createElement(Field, { label: "Synthetic participant", wide: true, required: true },
                        React.createElement("select", { name: "participantId", defaultValue: s.participants[id] ? id : undefined }, vals(s.participants).map(p => React.createElement("option", { key: p.id, value: p.id },
                            p.code,
                            " \u00B7 ",
                            p.trialId,
                            " \u00B7 ",
                            s.sites[p.siteId].city)))),
                    React.createElement(Field, { label: "Uncoded demo event term", name: "term", required: true, placeholder: "e.g. Gastrointestinal discomfort", wide: true }),
                    React.createElement(Field, { label: "Event description", wide: true, required: true },
                        React.createElement("textarea", { name: "description", required: true, placeholder: "Record the preliminary event, without implying causality\u2026" })),
                    React.createElement(Field, { label: "Onset date", name: "onset", type: "date", max: day(), help: "Leave blank if unknown / pending follow-up." }),
                    React.createElement(Field, { label: "Awareness / entry date", name: "awareness", type: "date", value: day(), max: day(), required: true }),
                    React.createElement(Field, { label: "Severity", required: true },
                        React.createElement("select", { name: "severity", defaultValue: "Moderate" }, ['Mild', 'Moderate', 'Severe', 'Unknown/pending follow-up'].map(v => React.createElement("option", { key: v }, v)))),
                    React.createElement(Field, { label: "Seriousness", required: true },
                        React.createElement("select", { name: "serious", value: app.state.draft.serious || 'no', onChange: (e) => app.set({ draft: { ...app.state.draft, serious: e.target.value } }) },
                            React.createElement("option", { value: "no" }, "Not serious"),
                            React.createElement("option", { value: "yes" }, "Serious \u2014 criterion required"))),
                    React.createElement(Field, { label: "Recorded seriousness criterion", wide: true, help: "Seriousness must not be inferred from severity alone." },
                        React.createElement("select", { name: "criterion", defaultValue: "" },
                            React.createElement("option", { value: "" }, "Choose a criterion for a serious event"),
                            ['Hospitalization (recorded demo criterion)', 'Life-threatening (recorded demo criterion)', 'Death (recorded demo criterion)', 'Persistent disability (recorded demo criterion)', 'Other medically important event (recorded demo criterion)'].map(v => React.createElement("option", { key: v }, v)))),
                    React.createElement(Field, { label: "Outcome" },
                        React.createElement("select", { name: "outcome", defaultValue: "Unknown/pending follow-up" }, ['Unknown/pending follow-up', 'Resolved', 'Resolving', 'Not resolved'].map(v => React.createElement("option", { key: v }, v)))),
                    React.createElement(Field, { name: "interventionAction", label: "Intervention / action recorded", value: "Unknown/pending follow-up" })),
                React.createElement("div", { className: "notice" },
                    React.createElement(Icon, { name: "info", size: 17 }),
                    React.createElement("span", null, "Recruitment status does not block safety capture for an existing participant. No external report is sent.")),
                React.createElement(Button, { type: "submit", variant: app.state.draft.serious === 'yes' ? 'danger' : 'primary', icon: "shield" }, "Submit safety report"));
        }
        else if (d.type === 'safety') {
            const c = s.safety[id];
            title = c ? c.id + ' · ' + c.term : 'Safety case';
            subtitle = c ? c.trialId + ' · ' + s.sites[c.siteId].city + ' · ' + s.participants[c.participantId].code : subtitle;
            if (!c)
                body = missing();
            else {
                const options = { Submitted: ['Under Review', 'Follow-up Required', 'Reviewed'], 'Under Review': ['Follow-up Required', 'Reviewed'], 'Follow-up Required': ['Under Review', 'Reviewed'], Reviewed: ['Closed'], Closed: [] };
                body = React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "record-summary" },
                        React.createElement(Badge, null, c.status),
                        React.createElement(Badge, { tone: c.serious ? 'red' : 'slate' }, c.serious ? 'Serious' : 'Not serious'),
                        audit(id)),
                    React.createElement("div", { className: "detail-grid" },
                        React.createElement("div", null,
                            React.createElement("small", null, "Severity"),
                            React.createElement("strong", null, c.severity)),
                        React.createElement("div", null,
                            React.createElement("small", null, "Recorded seriousness criterion"),
                            React.createElement("strong", null, c.criterion)),
                        React.createElement("div", null,
                            React.createElement("small", null, "Onset"),
                            React.createElement("strong", null, c.onset ? formatDate(c.onset) : 'Unknown/pending follow-up')),
                        React.createElement("div", null,
                            React.createElement("small", null, "Awareness / entry date"),
                            React.createElement("strong", null, formatDate(c.awareness))),
                        React.createElement("div", null,
                            React.createElement("small", null, "Outcome"),
                            React.createElement("strong", null, c.outcome)),
                        React.createElement("div", null,
                            React.createElement("small", null, "Intervention / action recorded"),
                            React.createElement("strong", null, c.interventionAction || 'Unknown/pending follow-up'))),
                    React.createElement("h3", null, "Initial report"),
                    React.createElement("p", null, c.description),
                    React.createElement("div", { className: "notice" },
                        React.createElement(Icon, { name: "info", size: 17 }),
                        React.createElement("span", null,
                            c.coding,
                            " \u00B7 MedDRA-ready mapping placeholder only. No official code or causal relationship is inferred.")),
                    React.createElement("h3", null, "PV review & follow-up"),
                    allow('pvReview') && (options[c.status] || []).length ? React.createElement("form", { className: "nested-form", onSubmit: (e) => { const f = dataOf(e); app.run(() => app.repo.pvReview(u.id, id, f.status, f.reason), 'PV decision recorded; workflow and action queue updated.', () => app.open('safety', id)); } },
                        React.createElement(Field, { label: "Review transition" },
                            React.createElement("select", { name: "status", defaultValue: c.status === 'Submitted' ? 'Follow-up Required' : undefined }, (options[c.status] || []).map(st => React.createElement("option", { key: st }, st)))),
                        React.createElement(Field, { label: "Review rationale / follow-up request", required: true },
                            React.createElement("textarea", { name: "reason", required: true, placeholder: "Record reviewed evidence and the reason for this decision\u2026" })),
                        React.createElement(Button, { type: "submit", variant: "primary" }, "Record PV decision")) : React.createElement("p", { className: "muted" }, c.status === 'Closed' ? 'This case is closed. Its history is retained.' : 'A Pharmacovigilance Officer must perform the review. Your role cannot complete this transition.'),
                    React.createElement("h3", null, "Reporting task"),
                    React.createElement("div", { className: "report-task" },
                        React.createElement("div", null,
                            React.createElement("strong", null,
                                "Sample review due ",
                                formatDate(c.deadline)),
                            React.createElement("small", null, "Configurable sample rule \u00B7 not a legal reporting deadline"),
                            React.createElement(Badge, { tone: "slate" }, c.reportStatus)),
                        allow('reportPrepare') && React.createElement(Button, { small: true, onClick: () => app.run(() => app.repo.prepareReport(u.id, id), 'Report prepared locally; nothing was transmitted.') }, "Prepare locally")),
                    React.createElement("h3", null, "Case timeline"),
                    React.createElement("div", { className: "timeline" }, c.notes.map((n, i) => React.createElement("div", { className: "timeline-item", key: i },
                        React.createElement("strong", null, n.status),
                        React.createElement("small", null,
                            formatDate(n.at),
                            " \u00B7 ",
                            s.users[n.by]?.name || n.by),
                        React.createElement("p", null, n.text)))));
            }
        }
        else if (d.type === 'query') {
            const q = s.queries[id];
            title = q ? 'Data query · ' + q.id : 'Data query';
            subtitle = q ? q.trialId + ' · ' + s.sites[q.siteId].city : subtitle;
            body = q ? React.createElement(React.Fragment, null,
                React.createElement("div", { className: "record-summary" },
                    React.createElement(Badge, null, q.status),
                    React.createElement("span", null,
                        "Due ",
                        formatDate(q.due)),
                    audit(id)),
                React.createElement("h3", null, q.question),
                React.createElement("div", { className: "detail-grid" },
                    React.createElement("div", null,
                        React.createElement("small", null, "Source participant"),
                        React.createElement(RecordLink, { onClick: () => app.open('participant', q.participantId) }, s.participants[q.participantId].code)),
                    React.createElement("div", null,
                        React.createElement("small", null, "Source visit field"),
                        React.createElement(RecordLink, { onClick: () => app.open('visit', q.visitId) },
                            q.field,
                            " \u00B7 ",
                            s.visits[q.visitId].label))),
                q.status === 'Open' && allow('queryAnswer') ? React.createElement("form", { onSubmit: (e) => { const f = dataOf(e); app.run(() => app.repo.answerQuery(u.id, id, f.value, f.note), 'Response recorded; awaiting monitor verification.', () => app.open('query', id)); } },
                    React.createElement(Field, { label: "Corrected source observation", required: true },
                        React.createElement("textarea", { name: "value", required: true, defaultValue: q.value })),
                    React.createElement(Field, { label: "Response rationale", required: true },
                        React.createElement("textarea", { name: "note", required: true })),
                    React.createElement(Button, { variant: "primary", type: "submit" }, "Submit query response")) : q.status === 'Answered' && allow('queryVerify') ? React.createElement("form", { onSubmit: (e) => { const f = dataOf(e); app.run(() => app.repo.verifyQuery(u.id, id, f.reason), 'Response verified; query and linked action closed.', 'close'); } },
                    React.createElement("div", { className: "document-preview" }, q.value),
                    React.createElement(Field, { label: "Verification rationale", required: true },
                        React.createElement("textarea", { name: "reason", required: true })),
                    React.createElement(Button, { variant: "primary", type: "submit" }, "Verify & close query")) : React.createElement("div", { className: "notice" },
                    React.createElement(Icon, { name: "lock", size: 17 }),
                    React.createElement("span", null, q.status === 'Closed' ? 'This query is closed. Previous values and responses remain available.' : q.status === 'Open' ? 'A Coordinator must answer before monitor verification.' : 'Only a Monitor can verify and close this answered query.')),
                React.createElement("h3", null, "Preserved response history"),
                q.responses.length ? q.responses.map((r, i) => React.createElement("div", { className: "history-card", key: i },
                    React.createElement("small", null,
                        formatDate(r.at),
                        " \u00B7 ",
                        s.users[r.by]?.name),
                    React.createElement("p", null,
                        React.createElement("b", null, "Previous:"),
                        " ",
                        r.previous || '(empty)'),
                    React.createElement("p", null,
                        React.createElement("b", null, "New value:"),
                        " ",
                        r.value),
                    React.createElement("p", null,
                        React.createElement("b", null, "Reason:"),
                        " ",
                        r.note))) : React.createElement("p", { className: "muted" }, "No response recorded yet.")) : missing();
        }
        else if (d.type === 'deviation') {
            const x = s.deviations[id];
            title = 'Protocol deviation · ' + id;
            body = x ? React.createElement(React.Fragment, null,
                React.createElement(Badge, null, x.status),
                React.createElement("h3", null, x.category),
                React.createElement("p", null, x.description),
                allow('deviation') && x.status !== 'Closed' ? React.createElement("form", { onSubmit: (e) => { const f = dataOf(e); app.run(() => app.repo.deviation(u.id, id, f.reason), 'Corrective action recorded.', 'close'); } },
                    React.createElement(Field, { label: "Corrective action and review rationale", required: true },
                        React.createElement("textarea", { name: "reason", required: true })),
                    React.createElement(Button, { type: "submit", variant: "primary" }, "Record corrective action")) : React.createElement("p", null, x.correctiveAction || 'A Monitor must record the corrective action.'),
                audit(id)) : missing();
        }
        else if (d.type === 'trialSite') {
            const ts = s.trialSites[id];
            title = ts ? s.sites[ts.siteId].city + ' · ' + ts.trialId : 'Trial-site';
            subtitle = ts ? s.sites[ts.siteId].name : subtitle;
            if (!ts)
                body = missing();
            else {
                const r = risk(s, ts);
                body = React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "record-summary" },
                        React.createElement(Badge, null, ts.status),
                        React.createElement("span", null,
                            r.enrollment,
                            " enrolled / ",
                            ts.target ?? 'unassigned',
                            " target"),
                        audit(id)),
                    React.createElement("div", { className: "detail-grid" },
                        React.createElement("div", null,
                            React.createElement("small", null, "Investigator"),
                            React.createElement("strong", null, s.sites[ts.siteId].investigator)),
                        React.createElement("div", null,
                            React.createElement("small", null, "Study"),
                            React.createElement(RecordLink, { onClick: () => app.open('trial', ts.trialId) }, ts.trialId))),
                    React.createElement("h3", null, "Readiness evidence"),
                    React.createElement("p", { className: "muted" }, "Configurable demo checklist; not a universal regulatory rule."),
                    Object.entries(ts.readiness).map(([key, ok]) => React.createElement("div", { className: "readiness-item", key: key },
                        React.createElement(CheckRow, { ok: ok, title: key.charAt(0).toUpperCase() + key.slice(1), detail: ts.evidence[key] || 'Evidence reference not recorded' }),
                        !ok && allow('readiness') && React.createElement("form", { className: "inline-form", onSubmit: (e) => { const f = dataOf(e); app.run(() => app.repo.readiness(u.id, id, key, f.evidence), 'Readiness evidence recorded.'); } },
                            React.createElement("input", { "aria-label": key + ' evidence reference', name: "evidence", required: true, placeholder: 'Synthetic ' + key + ' evidence reference…' }),
                            React.createElement(Button, { type: "submit", small: true }, "Record evidence")),
                        s.documents[ts.evidence[key]] && React.createElement("button", { className: "text-btn evidence-link", onClick: () => app.open('document', ts.evidence[key]) },
                            "Open linked evidence ",
                            React.createElement(Icon, { name: "arrowUp", size: 13 })))),
                    ts.status !== 'Active' && allow('activateSite') && React.createElement("div", { className: "form-actions" },
                        React.createElement(Button, { variant: "primary", onClick: () => app.run(() => app.repo.activateSite(u.id, id), 'Trial-site activated. The study recruitment target is unchanged.') }, "Activate site"),
                        React.createElement("small", null, "All readiness evidence and valid recorded ethics approval are required.")),
                    ts.target === null && React.createElement("div", { className: "notice amber" },
                        React.createElement(Icon, { name: "info", size: 17 }),
                        React.createElement("span", null,
                            "Recruitment target is not assigned. Activation does not change the trial target (",
                            s.trials[ts.trialId].target,
                            "); enrollment at this association remains capacity-blocked.")),
                    React.createElement("h3", null, "Operational risk explanation"),
                    React.createElement(RiskBreakdown, { s: s, ts: ts }),
                    React.createElement("div", { className: "button-row" },
                        React.createElement(Button, { small: true, onClick: () => { app.set({ scope: { trialId: ts.trialId, siteId: ts.siteId } }); app.nav('participants', 'Overdue', 'visits'); } },
                            "Inspect ",
                            r.lateVisits,
                            " overdue visits"),
                        React.createElement(Button, { small: true, onClick: () => { app.set({ scope: { trialId: ts.trialId, siteId: ts.siteId } }); app.nav('monitoring'); } },
                            "Inspect ",
                            r.openQueries,
                            " unresolved queries")));
            }
        }
        else if (d.type === 'trial') {
            const t = s.trials[id];
            title = t ? t.code + ' · Study workspace' : 'Trial';
            subtitle = t ? t.title : subtitle;
            if (!t)
                body = missing();
            else {
                const tab = app.state.draft.detailTab || 'overview';
                const intervention = vals(s.interventions).find(i => i.trialId === id);
                const lifecycle = ['Draft', 'Setup', 'Recruiting', 'Active Follow-up', 'Close-out Review', 'Closed'];
                const next = lifecycle[lifecycle.indexOf(t.status) + 1];
                body = React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "record-summary" },
                        React.createElement(Badge, null, t.status),
                        React.createElement("span", null,
                            "Target ",
                            t.target,
                            " \u00B7 protocol v",
                            t.protocolVersion),
                        audit(id)),
                    React.createElement(Tabs, { active: tab, items: [["overview", "Overview"], ["sites", "Sites"], ["intervention", "Intervention"], ["closeout", "Close-out"]], onChange: (detailTab) => app.set({ draft: { ...app.state.draft, detailTab } }) }),
                    tab === 'overview' ? React.createElement(React.Fragment, null,
                        React.createElement("div", { className: "detail-grid" },
                            React.createElement("div", null,
                                React.createElement("small", null, "Study design"),
                                React.createElement("strong", null, t.design)),
                            React.createElement("div", null,
                                React.createElement("small", null, "Principal Investigator"),
                                React.createElement("strong", null, s.users[t.piId]?.name || t.piId)),
                            React.createElement("div", null,
                                React.createElement("small", null, "Planned dates"),
                                React.createElement("strong", null,
                                    formatDate(t.startDate),
                                    " \u2014 ",
                                    formatDate(t.endDate))),
                            React.createElement("div", null,
                                React.createElement("small", null, "Protocol"),
                                React.createElement("strong", null,
                                    t.protocol || 'Not recorded',
                                    " \u00B7 v",
                                    t.protocolVersion)),
                            React.createElement("div", null,
                                React.createElement("small", null, "IEC approval validity"),
                                React.createElement("strong", null,
                                    t.iecStatus,
                                    " \u00B7 ",
                                    formatDate(t.iecExpiry))),
                            React.createElement("div", null,
                                React.createElement("small", null, "CTRI tracking"),
                                React.createElement("strong", null, t.registration))),
                        React.createElement("h3", null, "Eligibility & endpoints"),
                        React.createElement("p", null, t.eligibility || 'Eligibility text not configured.'),
                        React.createElement("p", null, t.endpoints || 'Endpoints not configured.'),
                        React.createElement("h3", null, "Protocol visit schedule"),
                        React.createElement("div", { className: "schedule-steps" }, t.schedule.map(n => React.createElement("div", { key: n },
                            React.createElement(Icon, { name: "calendar", size: 19 }),
                            React.createElement("strong", null, n === 0 ? 'Baseline' : 'Day ' + n),
                            React.createElement("small", null, "Protocol-defined visit")))),
                        React.createElement("div", { className: "button-row" },
                            allow('readiness') && React.createElement(Button, { small: true, onClick: () => app.open('trialSetup', id) }, "Edit setup records"),
                            React.createElement(Button, { small: true, onClick: () => { app.set({ scope: { trialId: id } }); app.nav('participants'); } }, "Participants & visits"),
                            React.createElement(Button, { small: true, onClick: () => { app.set({ scope: { trialId: id } }); app.nav('safety'); } }, "Safety"),
                            React.createElement(Button, { small: true, onClick: () => { app.set({ scope: { trialId: id } }); app.nav('compliance'); } }, "Compliance & documents")),
                        Ayu.trialBlockers(s, t).length > 0 && React.createElement("div", { className: "notice amber" },
                            React.createElement(Icon, { name: "alert", size: 17 }),
                            React.createElement("span", null,
                                "Recruitment readiness: ",
                                Ayu.trialBlockers(s, t).join('; '),
                                ".")),
                        next && allow('lifecycle') && React.createElement("form", { className: "nested-form", onSubmit: (e) => { const f = dataOf(e); app.run(() => app.repo.lifecycle(u.id, id, next, f.reason), 'Trial lifecycle decision recorded.', () => app.open('trial', id)); } },
                            React.createElement("h3", null,
                                "Next lifecycle transition: ",
                                next),
                            React.createElement(Field, { label: "Decision rationale", required: true },
                                React.createElement("textarea", { name: "reason", required: true })),
                            React.createElement(Button, { type: "submit" },
                                "Move to ",
                                next))) : tab === 'sites' ? React.createElement("div", null, vals(s.trialSites).filter(ts => ts.trialId === id).map(ts => React.createElement("button", { className: "site-assignment", key: ts.id, onClick: () => app.open('trialSite', ts.id) },
                        React.createElement("span", null,
                            s.sites[ts.siteId].city,
                            React.createElement("small", { className: "cell-sub" }, ts.id)),
                        React.createElement(Badge, null, ts.status),
                        React.createElement(Icon, { name: "right", size: 16 })))) : tab === 'intervention' && intervention ? React.createElement(React.Fragment, null,
                        React.createElement("div", { className: "notice" },
                            React.createElement(Icon, { name: "leaf", size: 18 }),
                            React.createElement("span", null, "Generic fictional intervention. No efficacy claims, real dosage recommendations, or automated Ayurveda diagnoses.")),
                        React.createElement("div", { className: "detail-grid" }, [['Intervention type', intervention.type], ['Fictional name', intervention.name], ['Formulation / ingredient notes', intervention.ingredients], ['Protocol-defined dose text', intervention.doseText], ['Administration schedule', intervention.schedule], ['Duration', intervention.duration], ['Comparator', intervention.comparator], ['Batch / manufacturer metadata', intervention.batch], ['Ayurveda assessment fields', intervention.assessment]].map(([l, v]) => React.createElement("div", { key: l },
                            React.createElement("small", null, l),
                            React.createElement("strong", null, v || 'Not recorded'))))) : React.createElement(React.Fragment, null,
                        React.createElement("h3", null, "Close-out readiness"),
                        React.createElement("p", { className: "muted" }, "Required visits, queries, safety cases, documents, and compliance reviews must be complete. Closing preserves records and history."),
                        Ayu.closeoutBlockers(s, id).length ? React.createElement("div", { className: "blocked-list" },
                            React.createElement(Badge, { tone: "red" }, "Close-out blocked"),
                            Ayu.closeoutBlockers(s, id).map(b => React.createElement("p", { key: b },
                                React.createElement(Icon, { name: "alert", size: 16 }),
                                b))) : React.createElement("div", { className: "success-banner" },
                            React.createElement(Icon, { name: "check", size: 20 }),
                            "No outstanding required items."),
                        t.status === 'Close-out Review' && allow('lifecycle') && React.createElement("form", { onSubmit: (e) => { const f = dataOf(e); app.run(() => app.repo.lifecycle(u.id, id, 'Closed', f.reason), 'Eligible demo trial closed; history retained.', 'close'); } },
                            React.createElement(Field, { label: "Close-out decision rationale", required: true },
                                React.createElement("textarea", { name: "reason", required: true })),
                            React.createElement(Button, { type: "submit", variant: "primary" }, "Close eligible trial"))));
            }
        }
        else if (d.type === 'trialSetup') {
            const t = s.trials[id];
            title = 'Configure study setup';
            body = t ? React.createElement("form", { onSubmit: (e) => { const f = dataOf(e); app.run(() => app.repo.configureTrial(u.id, id, { protocol: f.protocol, protocolVersion: f.protocolVersion, registration: f.registration, staffTrained: f.staffTrained === 'on', eligibility: f.eligibility, endpoints: f.endpoints }), 'Study setup records updated; ethics approval was not changed.', () => app.open('trial', id)); } },
                React.createElement("div", { className: "form-grid" },
                    React.createElement(Field, { label: "Protocol identifier", name: "protocol", value: t.protocol, required: true }),
                    React.createElement(Field, { label: "Protocol version", name: "protocolVersion", value: t.protocolVersion, required: true }),
                    React.createElement(Field, { label: "CTRI tracking status", wide: true },
                        React.createElement("select", { name: "registration", defaultValue: t.registration }, ['Not recorded', 'Recorded (demo)', 'Pending verification (demo)'].map(v => React.createElement("option", { key: v }, v)))),
                    React.createElement(Field, { label: "Eligibility criteria", wide: true },
                        React.createElement("textarea", { name: "eligibility", defaultValue: t.eligibility })),
                    React.createElement(Field, { label: "Endpoints", wide: true },
                        React.createElement("textarea", { name: "endpoints", defaultValue: t.endpoints }))),
                React.createElement("label", { className: "checkbox-line" },
                    React.createElement("input", { name: "staffTrained", type: "checkbox", defaultChecked: t.staffTrained }),
                    " Staff assigned and training evidence recorded (demo)"),
                React.createElement("div", { className: "notice" },
                    React.createElement(Icon, { name: "lock", size: 17 }),
                    React.createElement("span", null, "Only Ethics Committee decisions can record approval. Setup editing does not grant ethics approval.")),
                React.createElement(Button, { type: "submit", variant: "primary" }, "Save setup records")) : missing();
        }
        else if (d.type === 'createTrial') {
            title = 'Create a fictional trial';
            subtitle = 'Save as Draft · readiness gates apply before recruitment';
            body = React.createElement(TrialWizard, { app: app });
        }
        else if (d.type === 'document') {
            const doc = s.documents[id];
            title = doc ? doc.title + ' · v' + doc.version : 'Document';
            subtitle = doc ? doc.trialId + ' · ' + doc.family + ' · synthetic preview' : subtitle;
            body = doc ? React.createElement(React.Fragment, null,
                React.createElement("div", { className: "record-summary" },
                    React.createElement(Badge, null, doc.status),
                    React.createElement("span", null, doc.fileName || 'Generated synthetic text'),
                    audit(id)),
                React.createElement(Button, { small: true, icon: "download", onClick: () => app.run(() => AyuAuth.authService.file('/api/documents/' + encodeURIComponent(doc.id) + '/download'), 'Permitted synthetic document downloaded.') }, "Download synthetic text"),
                React.createElement("pre", { className: "document-preview" }, doc.content),
                React.createElement("p", { className: "muted" }, "Permitted text content and metadata are served from the persistent backend. Documents are not automatically verified."),
                React.createElement("h3", null, "Version history"),
                vals(s.documents).filter(x => x.trialId === doc.trialId && x.family === doc.family).sort((a, b) => b.version - a.version).map(x => React.createElement("button", { className: "site-assignment", key: x.id, onClick: () => app.open('document', x.id) },
                    React.createElement("span", null,
                        "v",
                        x.version,
                        " \u00B7 ",
                        x.title),
                    React.createElement(Badge, null, x.status))),
                React.createElement("h3", null, "Review decisions"),
                doc.comments.length ? doc.comments.map((c, i) => React.createElement("div", { className: "history-card", key: i },
                    React.createElement(Badge, null, c.decision),
                    React.createElement("small", null,
                        formatDate(c.at),
                        " \u00B7 ",
                        s.users[c.by]?.name),
                    React.createElement("p", null, c.text))) : React.createElement("p", { className: "muted" }, "No review decision recorded."),
                allow('ethicsDecision') && doc.status === 'Submitted' && React.createElement("form", { className: "nested-form", onSubmit: (e) => { const f = dataOf(e); app.run(() => app.repo.ethicsDecision(u.id, id, f.decision, f.reason, f.expiry), 'Demo committee decision recorded; prior versions and decisions preserved.', () => app.open('document', id)); } },
                    React.createElement(Field, { label: "Demo committee decision" },
                        React.createElement("select", { name: "decision" },
                            React.createElement("option", null, "Approved"),
                            React.createElement("option", null, "Changes requested"))),
                    React.createElement(Field, { label: "Approval expiry, if approved", name: "expiry", type: "date", value: day(180) }),
                    React.createElement(Field, { label: "Committee rationale", required: true },
                        React.createElement("textarea", { name: "reason", required: true })),
                    React.createElement(Button, { variant: "primary", type: "submit" }, "Record committee decision"))) : missing();
        }
        else if (d.type === 'newDocument') {
            title = 'Add a synthetic document version';
            body = React.createElement("form", { onSubmit: (e) => { const f = dataOf(e); app.run(() => app.repo.document(u.id, { trialId: f.trialId, family: f.family, title: f.title, content: f.content, fileName: app.state.draft.fileName, size: app.state.draft.fileSize }), 'Document version submitted locally.', doc => app.open('document', doc.id)); } },
                React.createElement("div", { className: "form-grid" },
                    React.createElement(Field, { label: "Study" },
                        React.createElement("select", { name: "trialId", defaultValue: app.state.scope.trialId }, vals(s.trials).map(t => React.createElement("option", { key: t.id }, t.id)))),
                    React.createElement(Field, { label: "Document family" },
                        React.createElement("select", { name: "family" }, ['Protocol', 'IEC renewal', 'Consent', 'Training', 'Supporting evidence'].map(v => React.createElement("option", { key: v }, v)))),
                    React.createElement(Field, { label: "Document title", name: "title", wide: true, required: true, placeholder: "e.g. Synthetic training evidence" }),
                    React.createElement(Field, { label: "Optional local upload", wide: true, help: "Only synthetic .txt files, up to 100 KB. Text and metadata persist on the server." },
                        React.createElement("input", { type: "file", accept: ".txt,text/plain", onChange: (e) => {
                                const file = e.target.files?.[0];
                                if (!file)
                                    return;
                                if (!/\.txt$/i.test(file.name) || file.size > 100000) {
                                    app.set({ error: 'Unsupported file: choose a synthetic .txt document of 100 KB or less.' });
                                    e.target.value = '';
                                    return;
                                }
                                const reader = new FileReader();
                                reader.onload = () => app.set({ draft: { ...app.state.draft, content: String(reader.result), fileName: file.name, fileSize: file.size }, error: '' });
                                reader.onerror = () => app.set({ error: 'File could not be read. No document was saved.' });
                                reader.readAsText(file);
                            } })),
                    React.createElement(Field, { label: "Synthetic preview content", wide: true, required: true },
                        React.createElement("textarea", { name: "content", required: true, rows: 8, value: app.state.draft.content || '', onChange: (e) => app.set({ draft: { ...app.state.draft, content: e.target.value } }), placeholder: "Use generated synthetic text or paste a fictional document\u2026" }))),
                React.createElement("div", { className: "button-row" },
                    React.createElement(Button, { onClick: () => app.set({ draft: { content: 'SYNTHETIC SUPPORTING DOCUMENT\n\nThis fictional document demonstrates controlled version history, human review, and local evidence tracking. It is not a real protocol or certification.' } }) }, "Generate sample text"),
                    React.createElement(Button, { variant: "primary", type: "submit" }, "Submit new version")));
        }
        else if (d.type === 'compliance') {
            const c = s.compliance[id];
            title = c ? c.title : 'Compliance item';
            body = c ? React.createElement(React.Fragment, null,
                React.createElement("div", { className: "record-summary" },
                    React.createElement(Badge, null, overdue(c, s.clock) ? 'Overdue' : c.status),
                    React.createElement("span", null,
                        c.trialId,
                        " \u00B7 due ",
                        formatDate(c.due)),
                    audit(id)),
                React.createElement("p", null,
                    "Owner: ",
                    React.createElement("strong", null, s.users[c.owner]?.name || c.owner)),
                React.createElement(Button, { icon: "file", onClick: () => app.open('document', c.documentId) }, "Open linked evidence"),
                c.kind === 'IEC' ? React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "notice amber" },
                        React.createElement(Icon, { name: "lock", size: 17 }),
                        React.createElement("span", null, "This item can only complete through an Ethics Committee review decision. PI, Coordinator, and Admin cannot approve it using a checklist action.")),
                    vals(s.documents).filter(d => d.trialId === c.trialId && d.status === 'Submitted').map(doc => React.createElement("button", { className: "site-assignment", key: doc.id, onClick: () => app.open('document', doc.id) },
                        React.createElement("span", null,
                            doc.title,
                            " \u00B7 v",
                            doc.version),
                        React.createElement(Badge, null, doc.status)))) : allow('compliance') && c.status !== 'Complete' ? React.createElement("form", { className: "nested-form", onSubmit: (e) => { const f = dataOf(e); app.run(() => app.repo.completeCompliance(u.id, id, f.reason), 'Evidence decision recorded; linked action resolved.', 'close'); } },
                    React.createElement(Field, { label: "Supporting evidence rationale", required: true },
                        React.createElement("textarea", { name: "reason", required: true })),
                    React.createElement(Button, { variant: "primary", type: "submit" }, "Record evidence completion")) : null) : missing();
        }
        else if (d.type === 'action') {
            const a = s.actions[id];
            title = a ? a.title : 'Action item';
            body = a ? React.createElement(React.Fragment, null,
                React.createElement("div", { className: "record-summary" },
                    React.createElement(Badge, null, a.priority),
                    React.createElement(Badge, null, a.status),
                    audit(id)),
                React.createElement("p", null, a.reason),
                React.createElement("div", { className: "detail-grid" },
                    React.createElement("div", null,
                        React.createElement("small", null, "Due"),
                        React.createElement("strong", null, formatDate(a.due))),
                    React.createElement("div", null,
                        React.createElement("small", null, "Owner"),
                        React.createElement("strong", null, s.users[a.owner]?.name || a.owner)),
                    React.createElement("div", null,
                        React.createElement("small", null, "Source record"),
                        React.createElement("strong", null, a.sourceId)),
                    React.createElement("div", null,
                        React.createElement("small", null, "Permitted next action"),
                        React.createElement("strong", null, a.nextAction))),
                React.createElement(Button, { variant: "primary", icon: "arrow", onClick: () => app.open(a.sourceType, a.sourceId) }, "Open underlying work"),
                allow('assign') && React.createElement("form", { className: "nested-form", onSubmit: (e) => { const f = dataOf(e); app.run(() => app.repo.assign(u.id, id, f.owner, f.reason), 'Action reassigned with audit rationale.', 'close'); } },
                    React.createElement(Field, { label: "Assign to demo user" },
                        React.createElement("select", { name: "owner", defaultValue: a.owner }, app.repo.identities().filter(p => p.role !== 'Regulator').map(p => React.createElement("option", { key: p.id, value: p.id },
                            p.name,
                            " \u00B7 ",
                            ROLE_NAMES[p.role])))),
                    React.createElement(Field, { label: "Reassignment reason", required: true },
                        React.createElement("textarea", { name: "reason", required: true })),
                    React.createElement(Button, { type: "submit" }, "Save assignment"),
                    React.createElement("p", { className: "muted" }, "The service rejects assignees without the required role and trial/site scope."))) : missing();
        }
        else if (d.type === 'audit') {
            const a = s.audit[id];
            title = 'Audit event · ' + id;
            body = a ? React.createElement(React.Fragment, null,
                React.createElement("div", { className: "detail-grid" },
                    React.createElement("div", null,
                        React.createElement("small", null, "Actor / role"),
                        React.createElement("strong", null,
                            s.users[a.actor]?.name || a.actor,
                            " \u00B7 ",
                            ROLE_NAMES[a.role])),
                    React.createElement("div", null,
                        React.createElement("small", null, "Operation"),
                        React.createElement("strong", null, a.operation))),
                React.createElement("p", null,
                    React.createElement("b", null, "Reason:"),
                    " ",
                    a.reason),
                React.createElement("p", null,
                    React.createElement("b", null, "Entity:"),
                    " ",
                    a.entityId),
                React.createElement("p", null,
                    React.createElement("b", null, "Timestamp:"),
                    " ",
                    a.createdAt,
                    " \u00B7 displayed elsewhere in Asia/Kolkata"),
                React.createElement("h3", null, "Relevant before values"),
                React.createElement("pre", { className: "code-preview" }, JSON.stringify(a.before, null, 2)),
                React.createElement("h3", null, "Relevant after values"),
                React.createElement("pre", { className: "code-preview" }, JSON.stringify(a.after, null, 2)),
                React.createElement("p", { className: "muted" }, "Append-only in the demo service layer. Browser storage is not tamper-proof.")) : missing();
        }
        else if (d.type === 'notifications') {
            title = 'In-app notifications';
            subtitle = 'Generated from current open actions · nothing is sent externally';
            body = React.createElement(ActionRows, { app: app, items: sortedActions(s).filter(a => ['Urgent', 'High'].includes(a.priority)).slice(0, 15) });
        }
        else if (d.type === 'pattern') {
            title = 'Potential pattern — requires PV review';
            const cases = (d.extra?.cases || []).map((id) => s.safety[id]).filter(Boolean);
            const c = cases[0];
            body = c ? React.createElement(React.Fragment, null,
                React.createElement("p", { className: "muted" }, "30-day descriptive grouping. Highlighting threshold: at least 3 episodes with the same term, site, and trial. No causality is established."),
                cases.map(c => React.createElement("button", { className: "site-assignment", key: c.id, onClick: () => app.open('safety', c.id) },
                    React.createElement("span", null,
                        c.id,
                        " \u00B7 ",
                        c.term,
                        React.createElement("small", { className: "cell-sub" }, s.participants[c.participantId].code)),
                    React.createElement(Badge, null, c.serious ? 'Serious' : c.status))),
                allow('patternReview') && React.createElement(Button, { variant: "primary", onClick: () => app.run(() => app.repo.patternReview(u.id, c.trialId, c.siteId, c.term), 'PV pattern-review task created or existing task retained.', 'close') }, "Create PV review task")) : missing();
        }
        else if (d.type === 'reset') {
            title = 'Reset the synthetic workspace?';
            body = React.createElement("form", { onSubmit: (e) => {
                    const f = dataOf(e);
                    if (f.confirm !== 'RESET') {
                        app.set({ error: 'Type RESET to confirm.' });
                        return;
                    }
                    app.run(() => app.repo.reset(u.id), 'Deterministic baseline restored.', () => { app.nav('overview'); app.set({ scope: {} }); });
                } },
                React.createElement("div", { className: "notice amber" },
                    React.createElement(Icon, { name: "alert", size: 18 }),
                    React.createElement("span", null, "All local demo changes, document text, and audit events will be replaced by the deterministic baseline. No external data is affected.")),
                React.createElement(Field, { label: "Type RESET to confirm", name: "confirm", required: true }),
                React.createElement(Button, { variant: "danger", type: "submit", icon: "refresh" }, "Confirm reset"));
        }
        else if (d.type === 'assignment') {
            title = 'Edit demo identity scope';
            const target = s.users[id];
            body = target ? React.createElement("form", { onSubmit: (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); app.run(() => app.repo.updateAssignment(u.id, id, String(f.get('trialId')), f.getAll('siteIds').map(String)), 'Explicit demo assignment updated.', 'close'); } },
                React.createElement("p", null,
                    React.createElement("strong", null, target.name),
                    " \u00B7 ",
                    ROLE_NAMES[target.role]),
                React.createElement(Field, { label: "Trial" },
                    React.createElement("select", { name: "trialId", value: app.state.draft.trialId || 'AYU-001', onChange: (e) => app.set({ draft: { trialId: e.target.value } }) }, vals(s.trials).map(t => React.createElement("option", { key: t.id }, t.id)))),
                React.createElement("h3", null, "Assigned trial-sites"),
                React.createElement("div", { key: app.state.draft.trialId || 'AYU-001' }, vals(s.trialSites).filter(ts => ts.trialId === (app.state.draft.trialId || 'AYU-001')).map(ts => React.createElement("label", { className: "checkbox-line", key: ts.id },
                    React.createElement("input", { type: "checkbox", name: "siteIds", value: ts.siteId, defaultChecked: vals(s.assignments).some(a => a.userId === id && a.trialId === ts.trialId && a.siteIds.includes(ts.siteId)) }),
                    s.sites[ts.siteId].city,
                    " \u00B7 ",
                    ts.status))),
                React.createElement(Button, { variant: "primary", type: "submit" }, "Save assignment"),
                React.createElement("p", { className: "muted" }, "An empty site selection removes domain-record scope for this trial. Trial-level context remains visible to an assigned identity.")) : missing();
        }
        else if (d.type === 'import') {
            title = 'EDC-style sample import';
            subtitle = 'Map → validate → preview → confirm → local commit';
            body = React.createElement(ImportWizard, { app: app });
        }
        else if (d.type === 'integration') {
            const i = s.integrations[id];
            title = i?.name || 'Integration preview';
            const p = vals(s.participants).find(p => p.enrolledAt);
            body = i ? React.createElement(React.Fragment, null,
                React.createElement(Badge, null, i.status),
                React.createElement("p", null, i.description),
                id === 'fhir' ? React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "notice amber" },
                        React.createElement(Icon, { name: "info", size: 17 }),
                        React.createElement("span", null, "Synthetic FHIR R4-shaped JSON. Unvalidated; not an ABDM connection or conformance claim.")),
                    React.createElement("pre", { className: "code-preview" }, JSON.stringify({ resourceType: 'Bundle', type: 'collection', entry: p ? [{ resource: { resourceType: 'ResearchSubject', id: p.id, status: 'on-study', study: { reference: 'ResearchStudy/' + p.trialId }, individual: { reference: 'Patient/SYNTHETIC-' + p.id } } }] : [] }, null, 2))) : id === 'cdisc' ? React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "notice amber" },
                        React.createElement(Icon, { name: "info", size: 17 }),
                        React.createElement("span", null, "Unvalidated CDISC-oriented mapping only. Not a validated SDTM / ADaM submission package.")),
                    React.createElement(Table, { heads: ['Local field', 'Illustrative mapping', 'Validation'] }, [['trialId', 'STUDYID'], ['code', 'USUBJID'], ['siteId', 'SITEID'], ['status', 'Workflow metadata; no asserted standard mapping']].map(([a, b]) => React.createElement("tr", { key: a },
                        React.createElement("td", null, a),
                        React.createElement("td", null, b),
                        React.createElement("td", null, "Not validated"))))) : React.createElement("div", { className: "adapter-notes" },
                    React.createElement("h3", null, "Future service boundary"),
                    React.createElement("p", null,
                        "Configured state: ",
                        React.createElement("b", null, "Not connected"),
                        ". The prototype keeps domain services separate from UI components so a governed backend adapter can replace local persistence."),
                    React.createElement("p", { className: "muted" }, "Production work includes authority-approved interfaces, credentials, consent/legal basis review, schema validation, server-side access control, and operational monitoring. No real request is made here."))) : missing();
        }
        else if (d.type === 'guide') {
            title = 'Walk through AYUSETU';
            subtitle = 'A 5–7 minute demo using only synthetic records';
            body = React.createElement(React.Fragment, null,
                React.createElement("div", { className: "guide-intro" },
                    React.createElement("div", { className: "brand-mark" },
                        React.createElement(Icon, { name: "leaf", size: 26 })),
                    React.createElement("div", null,
                        React.createElement("h3", null, "One workspace for Ayush clinical research."),
                        React.createElement("p", null, "Predict \u2192 Detect \u2192 Act \u00B7 Team Pathfindersz"))),
                [['1', 'PI overview', 'Review Varanasi’s recruitment shortfall, overdue visits, and overdue queries. Open the rule contributions.'], ['2', 'Coordinator enrollment', 'Sign out and sign in as coordinator@ayusetu.test. Open SCR-001. Try enrollment before consent, record consent v2.0, then enroll. AYU-001 moves from 96 to 97.'], ['3', 'Safety capture', 'Report a serious event for an existing synthetic participant. Record a seriousness criterion independently of severity.'], ['4', 'PV review', 'Sign out and sign in as pv@ayusetu.test; complete its fresh OTP using the labeled demo outbox. Open the new case, inspect evidence, and record Follow-up Required with rationale.'], ['5', 'Demo assistant', 'Ask “Which sites need attention, and why?” Follow the supporting record links.'], ['6', 'Regulator review', 'Sign out and sign in as Regulator. Inspect read-only audit history and export a scoped JSON or CSV report.']].map(([n, h, t]) => React.createElement("div", { className: "guide-step", key: n },
                    React.createElement("b", null, n),
                    React.createElement("div", null,
                        React.createElement("h3", null, h),
                        React.createElement("p", null, t)))),
                React.createElement("div", { className: "notice" },
                    React.createElement(Icon, { name: "info", size: 17 }),
                    React.createElement("span", null, "Reset is available under Administrator \u2192 Workspace settings. This prototype is not certified, clinically validated, or production-secure.")));
        }
        return React.createElement(Dialog, { title: title, subtitle: subtitle, onClose: app.close, wide: ['createTrial', 'import', 'trial', 'newSafety'].includes(d.type), aside: !['reset', 'consent', 'eligibility', 'screen', 'assignment'].includes(d.type) },
            app.formError(),
            body);
    }
    function TrialWizard({ app }) { const draft = app.state.draft, step = app.state.step, s = app.s(); const next = (e) => { const f = dataOf(e); app.set({ draft: { ...draft, ...f }, step: step + 1, error: '' }); }; return React.createElement(React.Fragment, null,
        React.createElement("div", { className: "wizard-steps" }, ['Study essentials', 'Protocol & intervention', 'Review draft'].map((t, i) => React.createElement("div", { className: i === step ? 'current' : i < step ? 'done' : '', key: t },
            React.createElement("b", null, i + 1),
            React.createElement("span", null, t)))),
        step === 0 ? React.createElement("form", { onSubmit: next },
            React.createElement("div", { className: "form-grid" },
                React.createElement(Field, { name: "title", label: "Fictional study title", value: draft.title, required: true, wide: true }),
                React.createElement(Field, { name: "code", label: "Unique short code", value: draft.code || 'AYU-004', required: true }),
                React.createElement(Field, { name: "target", label: "Recruitment target", type: "number", min: 1, value: draft.target || 60, required: true }),
                React.createElement(Field, { label: "Study design", wide: true },
                    React.createElement("select", { name: "design", defaultValue: draft.design || 'Prospective observational' },
                        React.createElement("option", null, "Prospective observational"),
                        React.createElement("option", null, "Parallel-group observational"),
                        React.createElement("option", null, "Single-arm feasibility"))),
                React.createElement(Field, { name: "startDate", label: "Planned start", type: "date", value: draft.startDate || day() }),
                React.createElement(Field, { name: "endDate", label: "Planned end", type: "date", value: draft.endDate || day(180) }),
                React.createElement(Field, { label: "Initial site assignment", wide: true },
                    React.createElement("select", { name: "siteId", defaultValue: draft.siteId || 'S1' }, vals(s.sites).map(site => React.createElement("option", { value: site.id, key: site.id }, site.name))))),
            React.createElement(Button, { variant: "primary", type: "submit" },
                "Continue to protocol ",
                React.createElement(Icon, { name: "arrow", size: 15 }))) : step === 1 ? React.createElement("form", { onSubmit: next },
            React.createElement("div", { className: "form-grid" },
                React.createElement(Field, { name: "protocol", label: "Protocol identifier", value: draft.protocol || 'DEMO-P01' }),
                React.createElement(Field, { name: "protocolVersion", label: "Protocol version", value: draft.protocolVersion || '1.0' }),
                React.createElement(Field, { name: "eligibility", label: "Protocol eligibility text", value: draft.eligibility, wide: true }),
                React.createElement(Field, { name: "endpoints", label: "Endpoints", value: draft.endpoints, wide: true }),
                React.createElement(Field, { label: "Intervention type" },
                    React.createElement("select", { name: "type", defaultValue: draft.type || 'Fictional formulation' },
                        React.createElement("option", null, "Fictional formulation"),
                        React.createElement("option", null, "Lifestyle protocol"),
                        React.createElement("option", null, "Procedure record"))),
                React.createElement(Field, { name: "name", label: "Fictional intervention name", value: draft.name || 'Formulation D' }),
                React.createElement(Field, { name: "ingredients", label: "Formulation / ingredient notes", value: draft.ingredients, wide: true }),
                React.createElement(Field, { name: "doseText", label: "Protocol-defined dose text", value: draft.doseText || 'Recorded in the fictional study protocol; no real dosage recommendation.', wide: true }),
                React.createElement(Field, { name: "schedule", label: "Administration schedule", value: draft.schedule || 'Protocol-defined' }),
                React.createElement(Field, { name: "duration", label: "Duration", value: draft.duration || '28-day demo observation' }),
                React.createElement(Field, { name: "comparator", label: "Comparator", value: draft.comparator || 'Not applicable' }),
                React.createElement(Field, { name: "batch", label: "Batch / manufacturer metadata", value: draft.batch }),
                React.createElement(Field, { name: "assessment", label: "Optional Ayurveda assessment fields", value: draft.assessment, wide: true }),
                React.createElement(Field, { label: "CTRI tracking status", wide: true },
                    React.createElement("select", { name: "registration", defaultValue: draft.registration || 'Not recorded' },
                        React.createElement("option", null, "Not recorded"),
                        React.createElement("option", null, "Recorded (demo)")))),
            React.createElement("p", { className: "muted" }, "Default demo visit schedule: baseline, day 14, day 28. No randomization service is simulated for these observational studies."),
            React.createElement("div", { className: "button-row" },
                React.createElement(Button, { onClick: () => app.set({ step: 0 }) }, "Back"),
                React.createElement(Button, { variant: "primary", type: "submit" },
                    "Review draft ",
                    React.createElement(Icon, { name: "arrow", size: 15 })))) : React.createElement(React.Fragment, null,
            React.createElement("div", { className: "review-draft" },
                React.createElement("h2", null, draft.title),
                React.createElement("p", null,
                    draft.code,
                    " \u00B7 ",
                    draft.design,
                    " \u00B7 Target ",
                    draft.target),
                React.createElement("div", { className: "detail-grid" },
                    React.createElement("div", null,
                        React.createElement("small", null, "Protocol"),
                        React.createElement("strong", null,
                            draft.protocol,
                            " \u00B7 ",
                            draft.protocolVersion)),
                    React.createElement("div", null,
                        React.createElement("small", null, "Initial site"),
                        React.createElement("strong", null, s.sites[draft.siteId]?.city)),
                    React.createElement("div", null,
                        React.createElement("small", null, "Intervention"),
                        React.createElement("strong", null,
                            draft.name,
                            " \u00B7 ",
                            draft.type)),
                    React.createElement("div", null,
                        React.createElement("small", null, "PI owner"),
                        React.createElement("strong", null, app.user().name)))),
            React.createElement("div", { className: "notice amber" },
                React.createElement(Icon, { name: "lock", size: 18 }),
                React.createElement("span", null, "The trial will be saved as Draft with ethics approval Pending. Recruitment is blocked until configuration, valid committee approval, staff readiness, and site activation are complete.")),
            React.createElement("div", { className: "button-row" },
                React.createElement(Button, { onClick: () => app.set({ step: 1 }) }, "Back"),
                React.createElement(Button, { variant: "primary", onClick: () => app.run(() => app.repo.createTrial(app.user().id, { title: draft.title, code: draft.code, target: Number(draft.target), design: draft.design, startDate: draft.startDate, endDate: draft.endDate, protocol: draft.protocol, protocolVersion: draft.protocolVersion, eligibility: draft.eligibility, endpoints: draft.endpoints, registration: draft.registration }, { type: draft.type, name: draft.name, ingredients: draft.ingredients, doseText: draft.doseText, schedule: draft.schedule, duration: draft.duration, comparator: draft.comparator, batch: draft.batch, assessment: draft.assessment }, draft.siteId), 'Fictional trial saved as Draft.', t => app.open('trial', t.id)) }, "Save trial draft")))); }
    const SAMPLE_IMPORT = 'subject_code,study_code,site_code,record_state\nEDC-DEMO-001,AYU-001,S1,Screening\nEDC-DEMO-001,AYU-001,S1,Screening\nEDC-DEMO-002,AYU-099,S3,Screening\nEDC-DEMO-003,AYU-002,S4,Screening';
    function parseCSV(text) {
        const rows = [];
        let row = [], cell = '', quoted = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (ch === '"') {
                if (quoted && text[i + 1] === '"') {
                    cell += '"';
                    i++;
                }
                else
                    quoted = !quoted;
            }
            else if (ch === ',' && !quoted) {
                row.push(cell.trim());
                cell = '';
            }
            else if (ch === '\n' && !quoted) {
                row.push(cell.trim());
                rows.push(row);
                row = [];
                cell = '';
            }
            else if (ch !== '\r')
                cell += ch;
        }
        if (quoted)
            throw new Ayu.DomainError('CSV has an unclosed quoted field.');
        if (cell || row.length) {
            row.push(cell.trim());
            rows.push(row);
        }
        return rows.filter(r => r.some(Boolean));
    }
    function ImportWizard({ app }) {
        const step = app.state.step, draft = app.state.draft;
        const text = draft.csv ?? SAMPLE_IMPORT;
        let parsed = [];
        try {
            parsed = parseCSV(text);
        }
        catch { }
        const headers = parsed[0] || [];
        const defaults = { id: 'subject_code', trialId: 'study_code', siteId: 'site_code', status: 'record_state' };
        const results = (draft.results || []);
        return React.createElement(React.Fragment, null,
            React.createElement("div", { className: "wizard-steps" }, ['Map fields', 'Validate & preview', 'Confirm commit'].map((t, i) => React.createElement("div", { className: i === step ? 'current' : i < step ? 'done' : '', key: t },
                React.createElement("b", null, i + 1),
                React.createElement("span", null, t)))),
            step === 0 ? React.createElement("form", { onSubmit: (e) => {
                    const f = dataOf(e);
                    app.run(async () => {
                        const data = parseCSV(text);
                        if (data.length < 2)
                            throw new Ayu.DomainError('Include a header row and at least one data row.');
                        const cols = data[0];
                        const rows = data.slice(1).map(r => ({ id: r[cols.indexOf(f.id)] || '', trialId: r[cols.indexOf(f.trialId)] || '', siteId: r[cols.indexOf(f.siteId)] || '', status: r[cols.indexOf(f.status)] || '' }));
                        const results = await app.repo.validateImport(app.user().id, rows);
                        app.set({ draft: { csv: text, results, rows }, step: 1 });
                        return results;
                    }, 'Sample rows validated; no records have been written.');
                } },
                React.createElement("div", { className: "notice" },
                    React.createElement(Icon, { name: "info", size: 17 }),
                    React.createElement("span", null, "The sample intentionally includes a duplicate ID and an invalid trial reference. Only screening states can be imported; consent and enrollment gates cannot be bypassed.")),
                React.createElement(Field, { label: "Synthetic CSV input", wide: true },
                    React.createElement("textarea", { rows: 7, name: "csv", value: text, onChange: (e) => app.set({ draft: { ...draft, csv: e.target.value } }), spellCheck: false })),
                React.createElement("div", { className: "form-grid" }, Object.entries(defaults).map(([k, v]) => React.createElement(Field, { key: k, label: 'Map required field: ' + k },
                    React.createElement("select", { name: k, defaultValue: v }, headers.map(h => React.createElement("option", { key: h }, h)))))),
                React.createElement(Button, { type: "submit", variant: "primary" }, "Validate & preview rows")) : step === 1 ? React.createElement(React.Fragment, null,
                React.createElement("div", { className: "inline-metrics two" },
                    React.createElement("div", null,
                        React.createElement("span", null, "Valid rows"),
                        React.createElement("strong", null, results.filter(r => r.valid).length)),
                    React.createElement("div", null,
                        React.createElement("span", null, "Rejected rows"),
                        React.createElement("strong", null, results.filter(r => !r.valid).length))),
                React.createElement(Table, { heads: ['Row', 'Participant / Trial / Site', 'Validation'] }, results.map(r => React.createElement("tr", { key: r.row },
                    React.createElement("td", null, r.row),
                    React.createElement("td", null,
                        r.input.id,
                        React.createElement("small", { className: "cell-sub" },
                            r.input.trialId,
                            " \u00B7 ",
                            r.input.siteId,
                            " \u00B7 ",
                            r.input.status)),
                    React.createElement("td", null, r.valid ? React.createElement(Badge, { tone: "green" }, "Valid") : React.createElement("span", { className: "field-error" }, r.errors.join(' ')))))),
                React.createElement("div", { className: "button-row pad-top" },
                    React.createElement(Button, { onClick: () => app.set({ step: 0 }) }, "Back to mapping"),
                    results.some(r => !r.valid) ? React.createElement(Button, { onClick: () => { const rows = results.filter(r => r.valid).map(r => r.input); app.run(async () => { const checked = await app.repo.validateImport(app.user().id, rows); app.set({ draft: { ...draft, rows, results: checked } }); }, 'Rejected rows explicitly removed; remaining rows revalidated.'); } }, "Remove rejected rows & revalidate") : React.createElement(Button, { variant: "primary", disabled: !results.length, onClick: () => app.set({ step: 2 }) }, "Continue to confirmation"))) : React.createElement("form", { onSubmit: (e) => { e.preventDefault(); app.run(() => app.repo.commitImport(app.user().id, draft.rows || []), 'Validated synthetic import committed atomically; no records overwritten.', 'close'); } },
                React.createElement("h3", null,
                    "Commit ",
                    results.length,
                    " validated screening records locally?"),
                React.createElement("p", { className: "muted" }, "References and duplicate IDs are rechecked immediately before the atomic commit. Enrollment totals will not change."),
                React.createElement("label", { className: "checkbox-line" },
                    React.createElement("input", { type: "checkbox", required: true }),
                    " I confirm these are synthetic records and authorize this local import."),
                React.createElement("div", { className: "button-row" },
                    React.createElement(Button, { onClick: () => app.set({ step: 1 }) }, "Back to preview"),
                    React.createElement(Button, { variant: "primary", type: "submit" }, "Confirm local commit"))));
    }
    function AssistantPanel({ app }) { const questions = ['Which sites need attention, and why?', 'What is overdue in this trial?', 'Summarize the open serious-event reviews.', 'What is blocking site activation?', 'Prepare a recruitment summary.']; const answer = app.state.answer; return React.createElement(Dialog, { title: "Your research copilot", subtitle: "Demo assistant \u00B7 deterministic, permission-scoped handlers", onClose: () => app.set({ assistantOpen: false }), aside: true },
        React.createElement("div", { className: "assistant-hello" },
            React.createElement("div", { className: "assistant-symbol" },
                React.createElement(Icon, { name: "spark", size: 28 })),
            React.createElement("h2", null, "What needs your attention?"),
            React.createElement("p", null, "Explore current records. Follow the evidence. Keep decisions human.")),
        React.createElement("div", { className: "assistant-scope" },
            React.createElement(Icon, { name: "lock", size: 15 }),
            app.scopeLabel()),
        React.createElement("div", { className: "question-list" }, questions.map(q => React.createElement("button", { key: q, onClick: () => app.ask(q) },
            q,
            React.createElement(Icon, { name: "arrowUp", size: 15 })))),
        answer && React.createElement("div", { className: "assistant-answer", "aria-live": "polite" },
            React.createElement("span", { className: "eyebrow" }, "DEMO ASSISTANT \u00B7 CURRENT STORE"),
            React.createElement("p", { className: "question-echo" }, app.state.question),
            React.createElement("h3", null, answer.summary),
            React.createElement("small", null,
                "Scope: ",
                answer.scope),
            React.createElement("div", { className: "assistant-sources" }, answer.items.map((item, i) => React.createElement("button", { key: i, onClick: () => app.open(item.type, item.id) },
                React.createElement("span", null, item.text),
                React.createElement("small", null,
                    React.createElement(Icon, { name: "link", size: 13 }),
                    item.id))))),
        React.createElement("form", { className: "assistant-input", onSubmit: (e) => { const f = dataOf(e); app.ask(f.question); e.currentTarget.reset(); } },
            React.createElement("input", { name: "question", "aria-label": "Ask the demo assistant", placeholder: "Ask about your research operations\u2026", required: true }),
            React.createElement("button", { type: "submit", "aria-label": "Send assistant question" },
                React.createElement(Icon, { name: "send", size: 18 }))),
        React.createElement("p", { className: "assistant-boundary" }, "No LLM or external service is connected. Responses update from permitted records. The assistant cannot approve protocols, sign consent, prescribe, establish causality, or submit reports.")); }
})(AyuUI || (AyuUI = {}));
ReactDOM.render(React.createElement(AyuAuthUI.Gate, null), document.getElementById('root'));
