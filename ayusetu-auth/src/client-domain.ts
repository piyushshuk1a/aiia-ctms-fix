/** AYUSETU: synthetic-only, deterministic local repository.
 * All writes pass through one transactional service; scoped reads never return raw store records.
 * Browser persistence and role switching are NOT production security controls.
 */
namespace Ayu {
    export const VERSION = 1;
    export const STORAGE_KEY = 'ayusetu.synthetic.v1';
    export const CLOCK = '2026-09-28T04:00:00.000Z';
    export type Role = 'PI' | 'Coordinator' | 'Monitor' | 'Ethics' | 'PV' | 'Admin' | 'Regulator';
    export const ROLE_NAMES: Record<Role, string> = { PI: 'Principal Investigator', Coordinator: 'Study Coordinator', Monitor: 'Clinical Trial Monitor', Ethics: 'Ethics Committee', PV: 'Pharmacovigilance Officer', Admin: 'Administrator', Regulator: 'Regulator' };
    export type EntityMap<T> = Record<string, T>;
    export interface Base {
        id: string;
        createdAt: string;
        updatedAt: string;
        owner: string;
        status: string;
        trialId?: string;
        siteId?: string;
    }
    export interface User {
        id: string;
        name: string;
        initials: string;
        role: Role;
        subtitle: string;
    }
    export interface RoleAssignment {
        id: string;
        userId: string;
        trialId: string;
        siteIds: string[];
    }
    export interface Trial extends Base {
        code: string;
        title: string;
        target: number;
        piId: string;
        design: string;
        startDate: string;
        endDate: string;
        protocol: string;
        protocolVersion: string;
        consentVersion: string;
        eligibility: string;
        endpoints: string;
        schedule: number[];
        iecStatus: string;
        iecExpiry: string;
        registration: string;
        staffTrained: boolean;
    }
    export interface Site extends Base {
        city: string;
        name: string;
        investigator: string;
    }
    export interface TrialSite extends Base {
        trialId: string;
        siteId: string;
        target: number | null;
        expectedToDate: number | null;
        readiness: Record<string, boolean>;
        evidence: Record<string, string>;
    }
    export interface Intervention extends Base {
        trialId: string;
        type: string;
        name: string;
        ingredients: string;
        doseText: string;
        schedule: string;
        duration: string;
        comparator: string;
        batch: string;
        assessment: string;
    }
    export interface Participant extends Base {
        trialId: string;
        siteId: string;
        code: string;
        screeningCode: string;
        eligibility: boolean;
        reviewer: string;
        enrolledAt: string | null;
        history: {
            at: string;
            status: string;
            note: string;
        }[];
    }
    export interface ConsentRecord extends Base {
        trialId: string;
        siteId: string;
        participantId: string;
        version: string;
        date: string;
        recordedBy: string;
    }
    export interface Visit extends Base {
        trialId: string;
        siteId: string;
        participantId: string;
        label: string;
        due: string;
        completedAt: string | null;
        observations: string;
    }
    export interface SafetyCase extends Base {
        trialId: string;
        siteId: string;
        participantId: string;
        term: string;
        description: string;
        onset: string;
        awareness: string;
        severity: string;
        serious: boolean;
        criterion: string;
        outcome: string;
        interventionAction: string;
        reporter: string;
        coding: string;
        notes: {
            at: string;
            by: string;
            text: string;
            status: string;
        }[];
        reviewer?: string;
        deadline: string;
        reportStatus: string;
    }
    export interface ComplianceItem extends Base {
        trialId: string;
        siteId?: string;
        title: string;
        kind: string;
        due: string;
        documentId: string;
    }
    export interface DocumentVersion extends Base {
        trialId: string;
        siteId?: string;
        family: string;
        title: string;
        version: number;
        content: string;
        comments: {
            at: string;
            by: string;
            text: string;
            decision: string;
        }[];
        fileName?: string;
        size?: number;
    }
    export interface DataQuery extends Base {
        trialId: string;
        siteId: string;
        participantId: string;
        visitId: string;
        field: string;
        question: string;
        due: string;
        value: string;
        responses: {
            at: string;
            by: string;
            previous: string;
            value: string;
            note: string;
        }[];
    }
    export interface ProtocolDeviation extends Base {
        trialId: string;
        siteId: string;
        category: string;
        description: string;
        discovered: string;
        correctiveAction: string;
    }
    export interface ActionItem extends Base {
        trialId: string;
        siteId?: string;
        title: string;
        reason: string;
        priority: 'Urgent' | 'High' | 'Normal';
        due: string;
        sourceId: string;
        sourceType: string;
        nextAction: string;
        trigger: string;
    }
    export interface AuditEvent extends Base {
        actor: string;
        role: Role;
        entity: string;
        entityId: string;
        operation: string;
        before: any;
        after: any;
        reason: string;
    }
    export interface IntegrationStatus {
        id: string;
        name: string;
        status: string;
        description: string;
        lastRun: string | null;
    }
    export interface State {
        viewTarget?: number;
        permittedTrialTargets?: Record<string,number>;
        viewScope?: Scope;
        version: number;
        seq: number;
        clock: string;
        users: EntityMap<User>;
        assignments: EntityMap<RoleAssignment>;
        trials: EntityMap<Trial>;
        sites: EntityMap<Site>;
        trialSites: EntityMap<TrialSite>;
        interventions: EntityMap<Intervention>;
        participants: EntityMap<Participant>;
        consents: EntityMap<ConsentRecord>;
        visits: EntityMap<Visit>;
        safety: EntityMap<SafetyCase>;
        compliance: EntityMap<ComplianceItem>;
        documents: EntityMap<DocumentVersion>;
        queries: EntityMap<DataQuery>;
        deviations: EntityMap<ProtocolDeviation>;
        actions: EntityMap<ActionItem>;
        audit: EntityMap<AuditEvent>;
        integrations: EntityMap<IntegrationStatus>;
        settings: {
            seriousHours: number;
            routineDays: number;
        };
    }
    export interface Scope {
        trialId?: string;
        siteId?: string;
    }
    export type Operation = 'screen' | 'eligibility' | 'consent' | 'enroll' | 'visit' | 'safetyCreate' | 'pvReview' | 'reportPrepare' | 'queryAnswer' | 'queryVerify' | 'deviation' | 'document' | 'ethicsDecision' | 'compliance' | 'readiness' | 'activateSite' | 'createTrial' | 'lifecycle' | 'assign' | 'import' | 'settings' | 'reset' | 'patternReview';
    const PERMISSIONS: Record<Operation, Role[]> = {
        screen: ['Coordinator'], eligibility: ['PI', 'Coordinator'], consent: ['Coordinator'], enroll: ['Coordinator'], visit: ['Coordinator'], safetyCreate: ['Coordinator', 'PI', 'PV'], pvReview: ['PV'], reportPrepare: ['PV'], queryAnswer: ['Coordinator'], queryVerify: ['Monitor'], deviation: ['Monitor'], document: ['PI', 'Coordinator', 'Admin'], ethicsDecision: ['Ethics'], compliance: ['PI', 'Coordinator', 'Admin'], readiness: ['PI', 'Admin'], activateSite: ['PI', 'Admin'], createTrial: ['PI', 'Admin'], lifecycle: ['PI'], assign: ['PI', 'Admin'], import: ['Admin'], settings: ['Admin'], reset: ['Admin'], patternReview: ['PV']
    };
    export class DomainError extends Error {
        fields: Record<string, string>;
        constructor(message: string, fields: Record<string, string> = {}) { super(message); this.name = 'DomainError'; this.fields = fields; }
    }
    export const vals = <T>(m: EntityMap<T>): T[] => Object.values(m);
    export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
    export function day(offset = 0): string { return new Date(Date.parse(CLOCK) + offset * 86400000).toISOString().slice(0, 10); }
    export function addDays(date: string, n: number): string { return new Date(Date.parse(date) + n * 86400000).toISOString().slice(0, 10); }
    export function formatDate(date: string | undefined): string { if (!date)
        return 'Not recorded'; return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(date.length === 10 ? date + 'T04:00:00Z' : date)); }
    export function dateValid(d: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d; }
    export function overdue(r: {
        status: string;
        due: string;
    }, clock = CLOCK): boolean { return ['Scheduled', 'Open', 'Answered', 'Submitted', 'Pending', 'Under Review', 'Follow-up Required'].includes(r.status) && r.due < clock.slice(0, 10); }
    export const can = (user: User, op: Operation): boolean => !!user && PERMISSIONS[op].includes(user.role);
    export function inScope(s: State, u: User, r: {
        trialId?: string;
        siteId?: string;
    }, scope: Scope = {}): boolean {
        if (scope.trialId && r.trialId && scope.trialId !== r.trialId)
            return false;
        if (scope.siteId && r.siteId && scope.siteId !== r.siteId)
            return false;
        if (!r.trialId)
            return u.role === 'Admin';
        const as = vals(s.assignments).filter(a => a.userId === u.id && a.trialId === r.trialId);
        return as.some(a => !r.siteId || a.siteIds.includes(r.siteId));
    }
    export function scoped(s: State, userId: string, scope: Scope = {}): State {
        const u = s.users[userId];
        if (!u)
            throw new DomainError('Unknown demo identity.');
        const o = clone(s);
        const scopedMaps = ['participants', 'consents', 'visits', 'safety', 'compliance', 'documents', 'queries', 'deviations', 'actions', 'audit', 'interventions', 'trialSites'] as const;
        for (const map of scopedMaps)
            (o as any)[map] = Object.fromEntries(vals(s[map] as EntityMap<Base>).filter(r => inScope(s, u, r, scope)).map(r => [r.id, clone(r)]));
        o.trials = Object.fromEntries(vals(s.trials).filter(t => inScope(s, u, { trialId: t.id }, scope) && (!scope.siteId || vals(o.trialSites).some(ts => ts.trialId === t.id && ts.siteId === scope.siteId))).map(t => [t.id, clone(t)]));
        const siteIds = new Set(vals(o.trialSites).map(ts => ts.siteId));
        o.sites = Object.fromEntries(vals(s.sites).filter(r => siteIds.has(r.id)).map(r => [r.id, clone(r)]));
        o.assignments = Object.fromEntries(vals(s.assignments).filter(a => u.role === 'Admin' || a.userId === u.id).map(a => [a.id, clone(a)]));
        o.integrations = u.role === 'Admin' ? clone(s.integrations) : {};
        o.viewScope = scope;
        o.viewTarget = vals(o.trials).reduce((n, t) => { const visible = vals(o.trialSites).filter(ts => ts.trialId === t.id); const all = vals(s.trialSites).filter(ts => ts.trialId === t.id); return n + (!scope.siteId && (s.permittedTrialTargets || visible.length === all.length) ? (s.permittedTrialTargets?.[t.id] ?? t.target) : visible.reduce((v, ts) => v + (ts.target || 0), 0)); }, 0);
        // Identity directory contains only synthetic staff labels, never participant identity fields.
        return o;
    }
    export function base(id: string, status: string, owner: string, trialId: string, siteId?: string): Base & {
        trialId: string;
    };
    export function base(id: string, status: string, owner?: string, trialId?: string, siteId?: string): Base;
    export function base(id: string, status: string, owner = 'u-pi', trialId?: string, siteId?: string): Base { return { id, status, owner, trialId, siteId, createdAt: CLOCK, updatedAt: CLOCK }; }
    export function metrics(s: State, scope: Scope = s.viewScope || {}): {
        enrolled: number;
        target: number;
        trials: number;
        uniqueSites: number;
        activeAssociations: number;
        overdueVisits: number;
        safetyReviews: number;
        serious: number;
        ae: number;
        complianceOverdue: number;
        queries: number;
    } {
        const match = (r: Base) => (!scope.trialId || r.trialId === scope.trialId) && (!scope.siteId || r.siteId === scope.siteId);
        const ts = vals(s.trialSites).filter(match);
        const trialIds = new Set(ts.map(t => t.trialId));
        return { enrolled: vals(s.participants).filter(p => match(p) && !!p.enrolledAt).length, target: scope.siteId ? ts.reduce((n, t) => n + (t.target || 0), 0) : (s.viewTarget ?? vals(s.trials).filter(t => (!scope.trialId || t.id === scope.trialId) && (!scope.siteId || trialIds.has(t.id))).reduce((n, t) => n + t.target, 0)), trials: vals(s.trials).filter(t => (!scope.trialId || t.id === scope.trialId) && t.status !== 'Closed').length, uniqueSites: new Set(ts.filter(t => t.status === 'Active').map(t => t.siteId)).size, activeAssociations: ts.filter(t => t.status === 'Active').length, overdueVisits: vals(s.visits).filter(v => match(v) && overdue(v, s.clock)).length, safetyReviews: vals(s.safety).filter(c => match(c) && !['Reviewed', 'Closed'].includes(c.status)).length, serious: vals(s.safety).filter(c => match(c) && c.serious).length, ae: vals(s.safety).filter(match).length, complianceOverdue: vals(s.compliance).filter(c => match(c) && overdue(c, s.clock)).length, queries: vals(s.queries).filter(q => match(q) && q.status !== 'Closed').length };
    }
    export interface Risk {
        score: number | null;
        band: string;
        enrollment: number;
        expected: number | null;
        visitsDue: number;
        lateVisits: number;
        openQueries: number;
        lateQueries: number;
        contributions: {
            label: string;
            points: number;
            max: number;
            formula: string;
        }[];
    }
    export function risk(s: State, ts: TrialSite): Risk {
        const match = (r: Base) => r.trialId === ts.trialId && r.siteId === ts.siteId;
        const enrollment = vals(s.participants).filter(p => match(p) && !!p.enrolledAt).length;
        const due = vals(s.visits).filter(v => match(v) && v.status !== 'Cancelled' && v.due <= s.clock.slice(0, 10));
        const late = due.filter(v => overdue(v, s.clock));
        const open = vals(s.queries).filter(q => match(q) && q.status !== 'Closed');
        const lateQ = open.filter(q => overdue(q, s.clock));
        const expected = ts.expectedToDate;
        const rc = expected === null ? 0 : expected === 0 ? 0 : 50 * Math.max(0, Math.min(1, 1 - enrollment / expected));
        const vc = 30 * late.length / Math.max(due.length, 1);
        const qc = 20 * lateQ.length / Math.max(open.length, 1);
        const score = expected === null ? null : Math.min(100, Math.max(0, rc + vc + qc));
        return { score, band: score === null ? 'Insufficient data' : score >= 60 ? 'High' : score >= 30 ? 'Watch' : 'Low', enrollment, expected, visitsDue: due.length, lateVisits: late.length, openQueries: open.length, lateQueries: lateQ.length, contributions: [{ label: 'Recruitment shortfall', points: rc, max: 50, formula: `50 × clamp(1 − ${enrollment} / ${expected ?? 'unknown'}, 0, 1)` }, { label: 'Overdue visits', points: vc, max: 30, formula: `30 × ${late.length} / max(${due.length}, 1)` }, { label: 'Overdue unresolved queries', points: qc, max: 20, formula: `20 × ${lateQ.length} / max(${open.length}, 1)` }] };
    }
    export function trialBlockers(s: State, t: Trial): string[] { const b: string[] = []; if (!t.protocol || !t.protocolVersion)
        b.push('Protocol identifier and version'); if (t.iecStatus !== 'Approved' || t.iecExpiry < s.clock.slice(0, 10))
        b.push('Valid recorded ethics approval'); if (!t.registration || t.registration === 'Not recorded')
        b.push('Configured registration status'); if (!t.staffTrained)
        b.push('Trained / assigned staff'); if (!vals(s.trialSites).some(ts => ts.trialId === t.id && ts.status === 'Active'))
        b.push('At least one active, ready trial-site'); return b; }
    export function closeoutBlockers(s: State, trialId: string): string[] { const m = (r: Base) => r.trialId === trialId; const b: string[] = []; const v = vals(s.visits).filter(r => m(r) && ['Scheduled', 'Missed'].includes(r.status)).length; const q = vals(s.queries).filter(r => m(r) && r.status !== 'Closed').length; const c = vals(s.safety).filter(r => m(r) && r.status !== 'Closed').length; const d = vals(s.documents).filter(r => m(r) && ['Draft', 'Submitted', 'Changes requested'].includes(r.status)).length; const cp = vals(s.compliance).filter(r => m(r) && r.status !== 'Complete').length; if (v)
        b.push(v + ' outstanding visits'); if (q)
        b.push(q + ' unresolved queries'); if (c)
        b.push(c + ' safety cases not closed'); if (d)
        b.push(d + ' documents awaiting review'); if (cp)
        b.push(cp + ' open compliance items'); return b; }
    export interface StoragePort {
        getItem(key: string): string | null;
        setItem(key: string, value: string): void;
        removeItem(key: string): void;
    }
    export interface ImportRow {
        id: string;
        trialId: string;
        siteId: string;
        status: string;
    }
    export interface ImportResult {
        row: number;
        input: ImportRow;
        valid: boolean;
        errors: string[];
    }
    export interface Answer {
        scope: string;
        summary: string;
        items: {
            text: string;
            type: string;
            id: string;
        }[];
        supported: boolean;
    }
    export function assistant(s: State, question: string, scopeLabel: string): Answer {
        const q = question.toLowerCase();
        const m = metrics(s);
        const items: Answer['items'] = [];
        let summary = '';
        let supported = true;
        if (/attention|sites|risk|why/.test(q)) {
            const sites = vals(s.trialSites).filter(ts => ts.status === 'Active').map(ts => ({ ts, r: risk(s, ts) })).sort((a, b) => (b.r.score ?? -1) - (a.r.score ?? -1));
            for (const { ts, r } of sites.slice(0, 4))
                items.push({ text: `${s.sites[ts.siteId].city} · ${ts.trialId}: ${r.score === null ? 'insufficient data' : r.score.toFixed(1) + '/100'}; ${r.enrollment}/${r.expected ?? 'unknown'} expected-to-date, ${r.lateVisits} overdue visits, ${r.lateQueries} overdue queries.`, type: 'trialSite', id: ts.id });
            summary = 'Prioritized by the rule-based demo operational index, not probability or clinical prediction.';
        }
        else if (/serious|safety|sae/.test(q)) {
            const cases = vals(s.safety).filter(c => c.serious && !['Reviewed', 'Closed'].includes(c.status));
            summary = `${cases.length} open serious-event review(s). Serious events are a subset of ${m.ae} adverse-event episodes in this scope.`;
            cases.forEach(c => items.push({ text: `${c.id}: ${c.term} · ${c.status}. Criterion: ${c.criterion}.`, type: 'safety', id: c.id }));
        }
        else if (/activation|blocking|readiness/.test(q)) {
            const ts = vals(s.trialSites).filter(ts => ts.status !== 'Active');
            summary = `${ts.length} trial-site association(s) pending activation.`;
            ts.forEach(t => items.push({ text: `${t.id}: missing ${Object.entries(t.readiness).filter(([, v]) => !v).map(([k]) => k).join(', ') || 'no checklist evidence; activation decision pending'}. Target ${t.target ?? 'not assigned'}.`, type: 'trialSite', id: t.id }));
        }
        else if (/overdue|needs attention|deadline/.test(q)) {
            const tasks = vals(s.actions).filter(a => a.status === 'Open' && a.due < s.clock.slice(0, 10));
            summary = `${tasks.length} overdue action(s); ${m.overdueVisits} overdue visits and ${m.complianceOverdue} overdue compliance item(s).`;
            tasks.slice(0, 8).forEach(a => items.push({ text: `${a.title} · due ${formatDate(a.due)}`, type: a.sourceType, id: a.sourceId }));
        }
        else if (/recruit|enroll|summary/.test(q)) {
            summary = `${m.enrolled}/${m.target} enrolled (${m.target ? (100 * m.enrolled / m.target).toFixed(1) : '0.0'}%) across ${m.trials} permitted trial(s).`;
            vals(s.trials).forEach(t => { const n = vals(s.participants).filter(p => p.trialId === t.id && p.enrolledAt).length; items.push({ text: `${t.id}: ${n} enrolled in permitted scope; trial target ${t.target}.`, type: 'trial', id: t.id }); });
        }
        else {
            supported = false;
            summary = 'This demo assistant supports operational attention, overdue work, serious-event reviews, site activation, and recruitment summaries. It cannot diagnose, prescribe, infer causality, or approve records.';
        }
        return { scope: scopeLabel, summary, items, supported };
    }
    export function report(s: State, kind: string): Record<string, any>[] { switch (kind) {
        case 'Recruitment': return vals(s.participants).map(p => ({ participant_id: p.id, study_code: p.code, trial_id: p.trialId, site_id: p.siteId, status: p.status, enrolled_at: p.enrolledAt || '' }));
        case 'Site performance': return vals(s.trialSites).map(t => { const r = risk(s, t); return { association_id: t.id, trial_id: t.trialId, site_id: t.siteId, site: s.sites[t.siteId].city, status: t.status, enrolled: r.enrollment, target: t.target, rule_index: r.score?.toFixed(2) ?? 'Insufficient data', overdue_visits: r.lateVisits, overdue_queries: r.lateQueries }; });
        case 'Safety': return vals(s.safety).map(c => ({ case_id: c.id, participant_id: c.participantId, trial_id: c.trialId, site_id: c.siteId, term: c.term, severity: c.severity, serious: c.serious, criterion: c.criterion, status: c.status, report_status: c.reportStatus }));
        case 'Compliance': return vals(s.compliance).map(c => ({ id: c.id, trial_id: c.trialId, site_id: c.siteId || '', title: c.title, status: c.status, due: c.due, document_id: c.documentId }));
        case 'Audit': return vals(s.audit).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(a => ({ id: a.id, timestamp: a.createdAt, actor: a.actor, role: a.role, entity_id: a.entityId, operation: a.operation, reason: a.reason, before: JSON.stringify(a.before), after: JSON.stringify(a.after) }));
        default: return [];
    } }
    export function csv(rows: Record<string, any>[]): string { if (!rows.length)
        return ''; const keys = Object.keys(rows[0]); const cell = (v: any) => { let t = v == null ? '' : String(v); if (/^[=+@\-\t\r]/.test(t))
        t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; }; return [keys.map(cell).join(','), ...rows.map(r => keys.map(k => cell(r[k])).join(','))].join('\r\n'); }
}
