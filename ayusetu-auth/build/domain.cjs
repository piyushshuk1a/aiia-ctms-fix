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
    function seed() {
        const s = { version: Ayu.VERSION, seq: 0, clock: Ayu.CLOCK, users: {}, assignments: {}, trials: {}, sites: {}, trialSites: {}, interventions: {}, participants: {}, consents: {}, visits: {}, safety: {}, compliance: {}, documents: {}, queries: {}, deviations: {}, actions: {}, audit: {}, integrations: {}, settings: { seriousHours: 24, routineDays: 7 } };
        const people = [['u-pi', 'Dr. Mira Sen', 'PI', 'Portfolio oversight'], ['u-coord', 'Ananya Rao', 'Coordinator', 'AYU-001 · all assigned sites'], ['u-monitor', 'Rohan Mehta', 'Monitor', 'Monitoring & data quality'], ['u-ethics', 'Dr. Leela Shah', 'Ethics', 'Protocol review'], ['u-pv', 'Dr. Kabir Das', 'PV', 'Safety operations'], ['u-admin', 'Ishaan Nair', 'Admin', 'Workspace administration'], ['u-regulator', 'Review Officer 01', 'Regulator', 'De-identified oversight'], ['u-varanasi', 'Neha Verma', 'Coordinator', 'AYU-001 · Varanasi only']];
        for (const [id, name, role, subtitle] of people)
            s.users[id] = { id, name, role, subtitle, initials: name.replace('Dr. ', '').split(' ').slice(0, 2).map(n => n[0]).join('') };
        ['Delhi', 'Jaipur', 'Varanasi', 'Pune', 'Bengaluru'].forEach((city, i) => { const id = 'S' + (i + 1); s.sites[id] = { ...base(id, 'Active', 'u-admin'), city, name: 'Demo Research Site — ' + city, investigator: ['Dr. Mira Sen', 'Dr. Arjun Dev', 'Dr. Tara Bose', 'Dr. Ravi Kale', 'Dr. Asha Iyer'][i] }; });
        const defs = [['AYU-001', 'Formulation A — Joint Comfort Study', 180, 'Parallel-group observational'], ['AYU-002', 'Formulation B — Digestive Wellbeing Study', 120, 'Prospective observational'], ['AYU-003', 'Lifestyle Protocol C — Sleep Quality Study', 100, 'Prospective observational']];
        for (const [id, title, target, design] of defs) {
            s.trials[id] = { ...base(id, 'Recruiting'), code: id, title, target, piId: 'u-pi', design, startDate: day(-90), endDate: day(120), protocol: id + '-P01', protocolVersion: '2.0', consentVersion: '2.0', eligibility: 'Protocol-specific eligibility checklist reviewed by authorized study staff. All records are synthetic.', endpoints: 'Protocol-defined visit completion and participant-reported assessment records; no efficacy inference.', schedule: [0, 14, 28], iecStatus: 'Approved', iecExpiry: day(id === 'AYU-001' ? 14 : 120), registration: 'Recorded (demo)', staffTrained: true };
            s.interventions['INT-' + id] = { ...base('INT-' + id, 'Configured', 'u-pi', id), type: id === 'AYU-003' ? 'Lifestyle protocol' : 'Fictional formulation', name: id === 'AYU-001' ? 'Formulation A' : id === 'AYU-002' ? 'Formulation B' : 'Lifestyle Protocol C', ingredients: 'Fictional study material; composition recorded only in synthetic protocol.', doseText: 'As specified in the fictional approved protocol. No real dosage recommendation.', schedule: 'Protocol-defined administration record', duration: '28-day demo observation schedule', comparator: 'Not applicable — observational demo', batch: 'DEMO-BATCH-01', assessment: 'Optional protocol-defined Prakriti / wellbeing observations; not an automated diagnosis.' };
            s.documents['DOC-' + id + '-1'] = { ...base('DOC-' + id + '-1', 'Superseded', 'u-ethics', id), family: 'Protocol', title: 'Study protocol', version: 1, content: 'SYNTHETIC PROTOCOL\nVersion 1.0\nHistorical demo version. No clinical use.', comments: [{ at: day(-95), by: 'u-ethics', text: 'Historical demo decision.', decision: 'Approved' }] };
            s.documents['DOC-' + id + '-2'] = { ...base('DOC-' + id + '-2', 'Approved', 'u-ethics', id), family: 'Protocol', title: 'Study protocol', version: 2, content: 'SYNTHETIC PROTOCOL\n' + title + '\nProtocol 2.0. Visit schedule: baseline, day 14, day 28. Eligibility and consent must be recorded by authorized staff. This preview is not a real clinical protocol.', comments: [{ at: day(-90), by: 'u-ethics', text: 'Recorded demo approval only.', decision: 'Approved' }] };
            s.compliance['CMP-' + id] = { ...base('CMP-' + id, 'Open', 'u-coord', id), title: 'IEC approval renewal', kind: 'IEC', due: day(id === 'AYU-001' ? 14 : 120), documentId: 'DOC-' + id + '-2' };
        }
        const allocations = [['AYU-001', 'S1', 48, 70, 50], ['AYU-001', 'S2', 30, 60, 40], ['AYU-001', 'S3', 18, 50, 48], ['AYU-002', 'S4', 30, 70, 35], ['AYU-002', 'S5', 24, 50, 30], ['AYU-003', 'S1', 20, 50, 25], ['AYU-003', 'S5', 20, 50, 24]];
        for (const [trialId, siteId, n, target, expected] of allocations) {
            const tsId = trialId + '-' + siteId;
            s.trialSites[tsId] = { ...base(tsId, 'Active', 'u-pi', trialId, siteId), trialId, siteId, target, expectedToDate: expected, readiness: { protocol: true, ethics: true, training: true, facilities: true }, evidence: { protocol: 'DOC-' + trialId + '-2', ethics: 'Recorded demo approval', training: 'DEMO-TRAINING-' + siteId, facilities: 'DEMO-CHECKLIST-' + siteId } };
            for (let i = 1; i <= n; i++) {
                const id = `${trialId}-${siteId}-${String(i).padStart(3, '0')}`;
                const enrolledAt = day(-85 + ((i * 7 + Number(siteId[1]) * 11) % 76));
                s.participants[id] = { ...base(id, 'Enrolled', 'u-coord', trialId, siteId), trialId, siteId, code: id, screeningCode: 'SCR-' + id, eligibility: true, reviewer: 'u-coord', enrolledAt, history: [{ at: enrolledAt, status: 'Screening', note: 'Synthetic screening completed' }, { at: enrolledAt, status: 'Enrolled', note: 'Seeded demo enrollment' }] };
                const cid = 'CON-' + id;
                s.consents[cid] = { ...base(cid, 'Recorded', 'u-coord', trialId, siteId), trialId, siteId, participantId: id, version: '2.0', date: enrolledAt, recordedBy: 'u-coord' };
                for (let j = 0; j < 3; j++) {
                    const vid = `VIS-${id}-${j}`;
                    let due = addDays(enrolledAt, j * 14);
                    let status = 'Completed';
                    if (j === 2 && siteId === 'S3' && i <= 16) {
                        status = 'Scheduled';
                        due = day(-i - 1);
                    }
                    else if (j === 2 && i <= 3) {
                        status = 'Scheduled';
                        due = day(-i);
                    }
                    else if (due >= day()) {
                        status = 'Scheduled';
                    }
                    s.visits[vid] = { ...base(vid, status, siteId === 'S3' ? 'u-varanasi' : 'u-coord', trialId, siteId), trialId, siteId, participantId: id, label: j === 0 ? 'Baseline' : `Day ${j * 14}`, due, completedAt: status === 'Completed' ? due : null, observations: status === 'Completed' ? 'Protocol observations recorded — synthetic' : '' };
                }
            }
        }
        s.trialSites['AYU-002-S2'] = { ...base('AYU-002-S2', 'Pending', 'u-pi', 'AYU-002', 'S2'), trialId: 'AYU-002', siteId: 'S2', target: null, expectedToDate: null, readiness: { protocol: true, ethics: true, training: false, facilities: false }, evidence: { protocol: 'DOC-AYU-002-2', ethics: 'Recorded demo approval', training: '', facilities: '' } };
        for (const u of Ayu.vals(s.users)) {
            const ids = u.id === 'u-coord' || u.id === 'u-varanasi' ? ['AYU-001'] : Object.keys(s.trials);
            for (const trialId of ids) {
                const aid = u.id + '-' + trialId;
                s.assignments[aid] = { id: aid, userId: u.id, trialId, siteIds: u.id === 'u-varanasi' ? ['S3'] : Ayu.vals(s.trialSites).filter(ts => ts.trialId === trialId).map(ts => ts.siteId) };
            }
        }
        for (let i = 1; i <= 18; i++) {
            const trialId = i <= 12 ? 'AYU-001' : 'AYU-002', siteId = i <= 12 ? 'S1' : 'S4', id = 'SCR-' + String(i).padStart(3, '0');
            s.participants[id] = { ...base(id, i <= 12 ? 'Screening' : 'Screen Failed', 'u-coord', trialId, siteId), trialId, siteId, code: id, screeningCode: id, eligibility: i === 1, reviewer: i === 1 ? 'u-coord' : '', enrolledAt: null, history: [{ at: day(-2), status: i <= 12 ? 'Screening' : 'Screen Failed', note: 'Synthetic screening record' }] };
        }
        const safetyIds = ['AYU-001-S3-001', 'AYU-001-S1-002', 'AYU-001-S3-003', 'AYU-001-S3-004', 'AYU-001-S3-005', 'AYU-001-S2-002', 'AYU-002-S4-001', 'AYU-002-S5-002', 'AYU-003-S1-001', 'AYU-003-S5-001'];
        safetyIds.forEach((pid, i) => { const p = s.participants[pid], id = 'AE-' + String(i + 1).padStart(3, '0'), serious = i < 2; s.safety[id] = { ...base(id, i < 4 ? 'Submitted' : 'Reviewed', 'u-pv', p.trialId, p.siteId), trialId: p.trialId, siteId: p.siteId, participantId: pid, term: i === 0 || i === 2 || i === 3 || i === 4 ? 'Gastrointestinal discomfort' : i === 1 ? 'Dizziness' : 'Headache', description: 'Synthetic adverse-event episode for workflow demonstration. Causality not assessed.', onset: day(-3 - i), awareness: day(-2 - i), severity: serious ? 'Moderate' : 'Mild', serious, criterion: serious ? 'Hospitalization (recorded demo criterion)' : 'Not serious', outcome: i < 4 ? 'Unknown/pending follow-up' : 'Resolved', interventionAction: 'Unknown/pending follow-up', reporter: 'u-coord', coding: 'Uncoded demo term', notes: [{ at: day(-2 - i), by: 'u-coord', text: 'Initial synthetic report.', status: 'Submitted' }], deadline: day(serious ? -1 : 4), reportStatus: 'Not prepared' }; });
        for (let i = 1; i <= 8; i++) {
            const siteId = i <= 6 ? 'S3' : 'S1', pid = `AYU-001-${siteId}-${String(i).padStart(3, '0')}`, id = 'Q-' + String(i).padStart(3, '0');
            s.queries[id] = { ...base(id, 'Open', 'u-coord', 'AYU-001', siteId), trialId: 'AYU-001', siteId, participantId: pid, visitId: 'VIS-' + pid + '-2', field: 'observations', question: 'Confirm protocol observation completeness for this visit.', due: day(i <= 6 ? -i - 2 : 3), value: '', responses: [] };
        }
        s.deviations['DEV-001'] = { ...base('DEV-001', 'Open', 'u-monitor', 'AYU-001', 'S3'), trialId: 'AYU-001', siteId: 'S3', category: 'Visit window', description: 'Synthetic visit recorded outside the protocol window.', discovered: day(-4), correctiveAction: '' };
        s.documents['DOC-RENEWAL'] = { ...base('DOC-RENEWAL', 'Submitted', 'u-ethics', 'AYU-001'), family: 'IEC renewal', title: 'IEC renewal application', version: 1, content: 'SYNTHETIC IEC RENEWAL\nThis is a local demo submission awaiting committee review. No external transmission.', comments: [] };
        s.compliance['CMP-TRAINING'] = { ...base('CMP-TRAINING', 'Open', 'u-coord', 'AYU-001', 'S3'), trialId: 'AYU-001', siteId: 'S3', title: 'Refresher training evidence', kind: 'Training', due: day(-3), documentId: 'DOC-AYU-001-2' };
        const integrations = [['ctri', 'CTRI tracking', 'Not connected', 'Manual registration-status tracking; no registry submission.'], ['edc', 'EDC sample import', 'Mock connector', 'Validate mapped synthetic rows, preview, then commit locally.'], ['fhir', 'ABDM / FHIR R4', 'Not connected', 'Synthetic FHIR-shaped preview; unvalidated.'], ['cdisc', 'CDISC mapping', 'Sample validation', 'CDISC-oriented mapping preview; not SDTM/ADaM validation.'], ['ayush', 'CCRAS / AYUSH references', 'Not connected', 'Future research reference-data adapter.']];
        for (const [id, name, status, description] of integrations)
            s.integrations[id] = { id, name, status, description, lastRun: null };
        syncActions(s);
        assertIntegrity(s);
        return s;
    }
    Ayu.seed = seed;
    function syncActions(s) {
        const wanted = new Set();
        function task(trigger, sourceType, r, title, reason, priority, due, owner, nextAction) { const id = 'ACT-' + trigger; wanted.add(id); const old = s.actions[id]; s.actions[id] = { ...base(id, 'Open', (old?.nextAction === nextAction ? old.owner : owner), r.trialId, r.siteId), ...(old || {}), owner: (old?.nextAction === nextAction ? old.owner : owner), status: 'Open', trialId: r.trialId, siteId: r.siteId, trigger, sourceType, sourceId: r.id, title, reason, priority, due, nextAction }; }
        for (const p of Ayu.vals(s.participants))
            if (p.status === 'Screening' || p.status === 'Eligible')
                task('enroll-' + p.id, 'participant', p, 'Complete enrollment · ' + p.code, 'Eligibility and protocol-version consent required.', 'Normal', day(2), 'u-coord', 'Review enrollment');
        for (const v of Ayu.vals(s.visits))
            if (v.status === 'Scheduled')
                task('visit-' + v.id, 'visit', v, v.label + ' · ' + s.participants[v.participantId].code, overdue(v, s.clock) ? 'Scheduled visit is overdue.' : 'Upcoming protocol-defined visit.', overdue(v, s.clock) ? 'High' : 'Normal', v.due, v.owner, 'Record visit');
        for (const c of Ayu.vals(s.safety))
            if (!['Reviewed', 'Closed'].includes(c.status))
                task('safety-' + c.id, 'safety', c, (c.serious ? 'Serious event review' : 'Safety review') + ' · ' + c.id, 'Case requires pharmacovigilance review or follow-up.', c.serious ? 'Urgent' : 'High', c.deadline, 'u-pv', 'Open safety case');
        for (const q of Ayu.vals(s.queries))
            if (q.status !== 'Closed')
                task('query-' + q.id, 'query', q, 'Data query · ' + q.id, q.question, overdue(q, s.clock) ? 'High' : 'Normal', q.due, q.status === 'Answered' ? 'u-monitor' : 'u-coord', q.status === 'Answered' ? 'Verify response' : 'Answer query');
        for (const c of Ayu.vals(s.compliance))
            if (c.status !== 'Complete')
                task('compliance-' + c.id, 'compliance', c, c.title, c.kind + ' tracking item needs evidence or review.', overdue(c, s.clock) ? 'High' : 'Normal', c.due, c.owner, 'Review tracking item');
        for (const t of Ayu.vals(s.trialSites)) {
            if (t.status !== 'Active')
                task('site-' + t.id, 'trialSite', t, 'Activate ' + s.sites[t.siteId].city + ' · ' + t.trialId, 'Readiness evidence is incomplete.', 'Normal', day(5), 'u-pi', 'Open readiness');
            else if ((t.expectedToDate || 0) > 0 && Ayu.vals(s.participants).filter(p => p.trialId === t.trialId && p.siteId === t.siteId && p.enrolledAt).length / (t.expectedToDate || 1) < 0.6)
                task('recruit-' + t.id, 'trialSite', t, 'Recruitment follow-up · ' + s.sites[t.siteId].city, 'Enrollment is below 60% of the configured expected-to-date plan.', 'High', day(1), 'u-pi', 'Inspect site risk');
        }
        for (const a of Ayu.vals(s.actions)) {
            if (a.trigger.startsWith('pattern-')) {
                const term = a.trigger.slice(('pattern-' + a.trialId + '-' + a.siteId + '-').length);
                const cases = Ayu.vals(s.safety).filter(c => c.trialId === a.trialId && c.siteId === a.siteId && c.term === term);
                a.status = cases.length && cases.every(c => ['Reviewed', 'Closed'].includes(c.status)) ? 'Complete' : 'Open';
            }
            else if (!wanted.has(a.id))
                a.status = 'Complete';
        }
    }
    Ayu.syncActions = syncActions;
    function assertIntegrity(s) {
        for (const t of Ayu.vals(s.trialSites))
            if (!s.trials[t.trialId] || !s.sites[t.siteId])
                throw new DomainError('Invalid trial/site association.');
        for (const p of Ayu.vals(s.participants))
            if (!s.trialSites[p.trialId + '-' + p.siteId])
                throw new DomainError('Participant references an unknown trial/site association.');
        for (const map of [s.consents, s.visits, s.safety, s.queries])
            for (const r of Ayu.vals(map)) {
                const p = s.participants[r.participantId];
                if (!p || p.trialId !== r.trialId || p.siteId !== r.siteId)
                    throw new DomainError('Invalid participant reference: ' + r.id);
            }
        for (const q of Ayu.vals(s.queries))
            if (!s.visits[q.visitId] || s.visits[q.visitId].participantId !== q.participantId)
                throw new DomainError('Invalid query visit reference.');
        for (const c of Ayu.vals(s.compliance))
            if (c.documentId && !s.documents[c.documentId])
                throw new DomainError('Invalid supporting document reference.');
        for (const p of Ayu.vals(s.participants))
            if (p.enrolledAt && !Ayu.vals(s.consents).some(c => c.participantId === p.id && c.status === 'Recorded'))
                throw new DomainError('Enrolled participant is missing recorded consent.');
        for (const c of Ayu.vals(s.safety))
            if (c.serious && !c.criterion)
                throw new DomainError('Serious case is missing a recorded criterion.');
        for (const a of Ayu.vals(s.assignments))
            if (!s.users[a.userId] || !s.trials[a.trialId] || a.siteIds.some(id => !s.trialSites[a.trialId + '-' + id]))
                throw new DomainError('Invalid role assignment.');
        const codes = Ayu.vals(s.participants).map(p => p.code);
        if (new Set(codes).size !== codes.length)
            throw new DomainError('Duplicate participant code.');
    }
    Ayu.assertIntegrity = assertIntegrity;
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
    class LocalRepository {
        constructor(storage) {
            this.listeners = [];
            this.warning = '';
            this.storage = storage;
            this.data = seed();
            if (storage) {
                try {
                    const raw = storage.getItem(Ayu.STORAGE_KEY);
                    if (raw) {
                        const loaded = JSON.parse(raw);
                        if (!loaded || loaded.version !== Ayu.VERSION || loaded.clock !== Ayu.CLOCK || !loaded.users || !loaded.actions || !loaded.settings)
                            throw new Error('Unsupported demo version');
                        assertIntegrity(loaded);
                        this.data = loaded;
                    }
                }
                catch {
                    this.warning = 'Saved demo data could not be loaded. The deterministic starting scenario has been restored.';
                    this.data = seed();
                }
            }
        }
        subscribe(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(f => f !== fn); }; }
        view(userId, scope = {}) { return scoped(this.data, userId, scope); }
        identities() { return Ayu.vals(this.data.users).map(Ayu.clone); }
        check(userId, op, r = {}) {
            const u = this.data.users[userId];
            if (!u || !Ayu.can(u, op))
                throw new DomainError('Permission denied: ' + (u ? Ayu.ROLE_NAMES[u.role] : 'unknown user') + ' cannot perform this action.');
            if (r.trialId && !inScope(this.data, u, r))
                throw new DomainError('Permission denied: record is outside your assigned trial/site scope.');
        }
        commit(userId, op, r, reason, fn) {
            const recordScope = { ...r, trialId: r.trialId || (this.data.trials[r.id] ? r.id : undefined) };
            this.check(userId, op, recordScope);
            const next = Ayu.clone(this.data);
            const before = Ayu.clone(r);
            const result = fn(next);
            syncActions(next);
            assertIntegrity(next);
            const id = 'AUD-' + String(++next.seq).padStart(5, '0');
            const at = new Date(Date.parse(next.clock) + next.seq * 1000).toISOString();
            const u = next.users[userId];
            next.audit[id] = { ...base(id, 'Recorded', userId, recordScope.trialId || (next.trials[r.id] ? r.id : undefined), r.siteId), createdAt: at, updatedAt: at, actor: userId, role: u.role, entity: op, entityId: r.id, operation: op, before, after: Ayu.clone(result ?? null), reason };
            if (this.storage) {
                try {
                    this.storage.setItem(Ayu.STORAGE_KEY, JSON.stringify(next));
                }
                catch {
                    throw new DomainError('Local save failed. No changes were applied. Free browser storage and retry.');
                }
            }
            this.data = next;
            this.listeners.forEach(fn => fn());
            return Ayu.clone(result);
        }
        record(map, id) {
            const r = map[id];
            if (!r)
                throw new DomainError('Record not found: ' + id);
            return r;
        }
        enroll(userId, id) {
            const p = this.record(this.data.participants, id);
            this.check(userId, 'enroll', p);
            if (p.enrolledAt)
                return Ayu.clone(p);
            const t = this.data.trials[p.trialId], ts = this.data.trialSites[p.trialId + '-' + p.siteId], fields = {};
            if (!p.eligibility || !p.reviewer)
                fields.eligibility = 'Record eligibility and the authorized reviewer before enrollment.';
            if (!Ayu.vals(this.data.consents).some(c => c.participantId === id && c.status === 'Recorded' && c.version === t.consentVersion && c.date <= this.data.clock.slice(0, 10)))
                fields.consent = 'Valid recorded consent for protocol consent version ' + t.consentVersion + ' is required.';
            if (!['Screening', 'Eligible'].includes(p.status))
                fields.status = 'Only a screening or eligible participant can enroll.';
            if (t.status !== 'Recruiting' || ts.status !== 'Active' || trialBlockers(this.data, t).length)
                fields.readiness = 'Trial and site must be recruitment-ready with valid recorded approval.';
            const ps = Ayu.vals(this.data.participants).filter(p => p.trialId === t.id && p.enrolledAt);
            if (ps.length >= t.target || ts.target === null || ps.filter(p => p.siteId === ts.siteId).length >= ts.target)
                fields.capacity = 'Configured trial/site recruitment capacity is unavailable or reached.';
            if (Object.keys(fields).length)
                throw new DomainError('Enrollment blocked. Complete the required checks below.', fields);
            return this.commit(userId, 'enroll', p, 'Eligibility and recorded consent gates passed.', s => {
                const p = s.participants[id];
                const n = Ayu.vals(s.participants).filter(x => x.trialId === p.trialId && x.siteId === p.siteId && x.enrolledAt).length + 1;
                let code = `${p.trialId}-${p.siteId}-${String(n).padStart(3, '0')}`;
                let suffix = n;
                while (Ayu.vals(s.participants).some(x => x.code === code))
                    code = `${p.trialId}-${p.siteId}-${String(++suffix).padStart(3, '0')}`;
                p.code = code;
                p.status = 'Enrolled';
                p.enrolledAt = s.clock.slice(0, 10);
                p.updatedAt = s.clock;
                p.history.push({ at: s.clock, status: 'Enrolled', note: 'Enrolled by ' + s.users[userId].name + '; screening history retained.' });
                for (const offset of s.trials[p.trialId].schedule) {
                    const vid = `VIS-${id}-D${offset}`;
                    s.visits[vid] = { ...base(vid, 'Scheduled', userId, p.trialId, p.siteId), trialId: p.trialId, siteId: p.siteId, participantId: id, label: offset === 0 ? 'Baseline' : 'Day ' + offset, due: addDays(s.clock, offset), completedAt: null, observations: '' };
                }
                return p;
            });
        }
        eligibility(userId, id, eligible, reason) {
            const p = this.record(this.data.participants, id);
            if (!reason.trim())
                throw new DomainError('Review rationale is required.', { reason: 'Enter the eligibility review rationale.' });
            if (p.enrolledAt)
                throw new DomainError('Enrollment history cannot be rewritten.');
            return this.commit(userId, 'eligibility', p, reason, s => { const p = s.participants[id]; p.eligibility = eligible; p.reviewer = userId; p.status = eligible ? 'Eligible' : 'Screen Failed'; p.history.push({ at: s.clock, status: p.status, note: reason }); return p; });
        }
        consent(userId, id, version, date) {
            const p = this.record(this.data.participants, id);
            if (!dateValid(date) || date > this.data.clock.slice(0, 10))
                throw new DomainError('Consent date must be valid and on or before the demo clock.', { date: 'Use a valid non-future date.' });
            if (version !== this.data.trials[p.trialId].consentVersion)
                throw new DomainError('Consent version does not match the configured protocol.', { version: 'Required version: ' + this.data.trials[p.trialId].consentVersion });
            return this.commit(userId, 'consent', p, 'Recorded consent metadata — not an electronic signature.', s => { const cid = 'CON-' + id + '-' + (s.seq + 1); const c = { ...base(cid, 'Recorded', userId, p.trialId, p.siteId), trialId: p.trialId, siteId: p.siteId, participantId: id, version, date, recordedBy: userId }; s.consents[cid] = c; return c; });
        }
        screen(userId, input) {
            if (!this.data.trialSites[input.trialId + '-' + input.siteId])
                throw new DomainError('Choose a valid assigned trial and site.');
            return this.commit(userId, 'screen', { id: 'NEW-SCREEN', ...input }, 'New synthetic screening candidate.', s => { const id = 'SCR-NEW-' + String(s.seq + 1).padStart(4, '0'); const p = { ...base(id, 'Screening', userId, input.trialId, input.siteId), ...input, code: id, screeningCode: id, eligibility: false, reviewer: '', enrolledAt: null, history: [{ at: s.clock, status: 'Screening', note: 'New synthetic screening candidate' }] }; s.participants[id] = p; return p; });
        }
        visit(userId, id, status, observations) {
            const v = this.record(this.data.visits, id);
            if (!['Completed', 'Missed', 'Cancelled', 'Scheduled'].includes(status))
                throw new DomainError('Invalid visit status.');
            if (status !== 'Scheduled' && !observations.trim())
                throw new DomainError('Record observations or a reason.', { observations: 'This field is required.' });
            return this.commit(userId, 'visit', v, 'Visit ' + status + ': ' + observations, s => { const v = s.visits[id]; v.status = status; v.observations = observations; v.completedAt = status === 'Completed' ? s.clock : null; return v; });
        }
        safetyCreate(userId, input) {
            const p = this.record(this.data.participants, input.participantId), f = {};
            if (!input.term.trim())
                f.term = 'An uncoded event term is required.';
            if (!input.description.trim())
                f.description = 'A preliminary event description is required.';
            if (input.serious && !input.criterion.trim())
                f.criterion = 'Select a recorded seriousness criterion; severity alone is insufficient.';
            if (!dateValid(input.awareness) || input.awareness > this.data.clock.slice(0, 10))
                f.awareness = 'Awareness date must be valid and not after the demo clock.';
            if (input.onset && (!dateValid(input.onset) || input.onset > input.awareness))
                f.onset = 'Onset must be on or before awareness, or left pending follow-up.';
            if (!['Mild', 'Moderate', 'Severe', 'Unknown/pending follow-up'].includes(input.severity))
                f.severity = 'Choose a valid severity or pending follow-up.';
            if (Object.keys(f).length)
                throw new DomainError('Review the safety reporting fields.', f);
            return this.commit(userId, 'safetyCreate', p, 'Initial ' + (input.serious ? 'serious ' : '') + 'event report; no causality inferred.', s => { const id = 'AE-' + String(Ayu.vals(s.safety).length + 1).padStart(3, '0'); const c = { ...base(id, 'Submitted', 'u-pv', p.trialId, p.siteId), ...input, trialId: p.trialId, siteId: p.siteId, reporter: userId, coding: 'Uncoded demo term', notes: [{ at: s.clock, by: userId, text: input.description, status: 'Submitted' }], deadline: new Date(Date.parse(input.awareness + 'T04:00:00Z') + (input.serious ? s.settings.seriousHours * 3600000 : s.settings.routineDays * 86400000)).toISOString().slice(0, 10), reportStatus: 'Not prepared' }; s.safety[id] = c; return c; });
        }
        pvReview(userId, id, status, reason) {
            const c = this.record(this.data.safety, id);
            if (!reason.trim())
                throw new DomainError('A review rationale is required.', { reason: 'Record your review rationale.' });
            const transitions = { Submitted: ['Under Review', 'Follow-up Required', 'Reviewed'], 'Under Review': ['Follow-up Required', 'Reviewed'], 'Follow-up Required': ['Under Review', 'Reviewed'], Reviewed: ['Closed'], Closed: [] };
            if (!transitions[c.status]?.includes(status))
                throw new DomainError('Unsupported safety transition from ' + c.status + ' to ' + status + '.');
            return this.commit(userId, 'pvReview', c, reason, s => { const c = s.safety[id]; c.status = status; c.reviewer = userId; c.notes.push({ at: s.clock, by: userId, text: reason, status }); return c; });
        }
        prepareReport(userId, id) { const c = this.record(this.data.safety, id); return this.commit(userId, 'reportPrepare', c, 'Report prepared locally; no external transmission.', s => { s.safety[id].reportStatus = 'Prepared locally'; return s.safety[id]; }); }
        answerQuery(userId, id, value, note) {
            const q = this.record(this.data.queries, id);
            if (q.status !== 'Open')
                throw new DomainError('Only an open query can be answered.');
            if (!value.trim() || !note.trim())
                throw new DomainError('A corrected value and response rationale are required.');
            return this.commit(userId, 'queryAnswer', q, note, s => { const q = s.queries[id]; q.responses.push({ at: s.clock, by: userId, previous: q.value, value, note }); q.value = value; q.status = 'Answered'; s.visits[q.visitId].observations = value; return q; });
        }
        verifyQuery(userId, id, reason) {
            const q = this.record(this.data.queries, id);
            if (q.status !== 'Answered')
                throw new DomainError('A coordinator must answer this query before monitor verification.');
            if (!reason.trim())
                throw new DomainError('Verification rationale is required.');
            return this.commit(userId, 'queryVerify', q, reason, s => { s.queries[id].status = 'Closed'; return s.queries[id]; });
        }
        deviation(userId, id, correctiveAction) {
            const d = this.record(this.data.deviations, id);
            if (!correctiveAction.trim())
                throw new DomainError('Corrective action is required.');
            return this.commit(userId, 'deviation', d, correctiveAction, s => { s.deviations[id].correctiveAction = correctiveAction; s.deviations[id].status = 'Closed'; return s.deviations[id]; });
        }
        readiness(userId, id, key, evidence) {
            const ts = this.record(this.data.trialSites, id);
            if (!(key in ts.readiness) || !evidence.trim())
                throw new DomainError('A valid readiness item and evidence reference are required.');
            return this.commit(userId, 'readiness', ts, 'Readiness evidence: ' + evidence, s => { const ts = s.trialSites[id]; ts.readiness[key] = true; ts.evidence[key] = evidence; return ts; });
        }
        activateSite(userId, id) {
            const ts = this.record(this.data.trialSites, id), t = this.data.trials[ts.trialId];
            this.check(userId, 'activateSite', ts);
            const missing = Object.entries(ts.readiness).filter(([, ok]) => !ok).map(([k]) => k);
            if (missing.length)
                throw new DomainError('Activation blocked. Missing: ' + missing.join(', ') + '.');
            if (t.iecStatus !== 'Approved' || t.iecExpiry < this.data.clock.slice(0, 10))
                throw new DomainError('Activation blocked: valid recorded ethics approval is required.');
            return this.commit(userId, 'activateSite', ts, 'Configured demo readiness checklist passed. Recruitment target unchanged.', s => { s.trialSites[id].status = 'Active'; return s.trialSites[id]; });
        }
        document(userId, input) {
            if (!this.data.trials[input.trialId])
                throw new DomainError('Choose an assigned trial.');
            if (!input.title.trim() || !input.content.trim())
                throw new DomainError('Document title and synthetic text content are required.');
            if ((input.size || 0) > 100000)
                throw new DomainError('Demo uploads are limited to 100 KB.');
            if (input.fileName && !/\.txt$/i.test(input.fileName))
                throw new DomainError('Only synthetic .txt documents are supported in this local demo.');
            return this.commit(userId, 'document', { id: 'NEW-DOCUMENT', trialId: input.trialId }, 'Synthetic document version submitted locally.', s => { const version = Math.max(0, ...Ayu.vals(s.documents).filter(d => d.trialId === input.trialId && d.family === input.family).map(d => d.version)) + 1; const id = 'DOC-NEW-' + (s.seq + 1); const d = { ...base(id, 'Submitted', userId, input.trialId), ...input, version, comments: [] }; s.documents[id] = d; return d; });
        }
        ethicsDecision(userId, id, decision, reason, expiry) {
            const d = this.record(this.data.documents, id);
            if (!['Approved', 'Changes requested'].includes(decision))
                throw new DomainError('Select a valid demo committee decision.');
            if (d.status !== 'Submitted')
                throw new DomainError('Only submitted documents can receive a new decision.');
            if (!reason.trim())
                throw new DomainError('Committee rationale is required.');
            if (decision === 'Approved' && (!dateValid(expiry) || expiry <= this.data.clock.slice(0, 10)))
                throw new DomainError('A future approval expiry is required.');
            return this.commit(userId, 'ethicsDecision', d, reason, s => {
                const d = s.documents[id];
                d.status = decision;
                d.comments.push({ at: s.clock, by: userId, text: reason, decision });
                if (decision === 'Approved' && ['Protocol', 'IEC renewal'].includes(d.family)) {
                    const t = s.trials[d.trialId];
                    t.iecStatus = 'Approved';
                    t.iecExpiry = expiry;
                    for (const c of Ayu.vals(s.compliance))
                        if (c.trialId === d.trialId && c.kind === 'IEC') {
                            c.status = 'Complete';
                            c.documentId = id;
                        }
                }
                return d;
            });
        }
        completeCompliance(userId, id, evidence) {
            const c = this.record(this.data.compliance, id);
            if (c.kind === 'IEC')
                throw new DomainError('IEC items require an Ethics Committee decision, not a checklist completion.');
            if (!evidence.trim())
                throw new DomainError('Evidence rationale is required.');
            return this.commit(userId, 'compliance', c, evidence, s => { s.compliance[id].status = 'Complete'; return s.compliance[id]; });
        }
        createTrial(userId, input, intervention, siteId) {
            const f = {};
            if (!/^AYU-[A-Z0-9-]+$/.test(input.code))
                f.code = 'Use a unique AYU- prefixed short code.';
            if (this.data.trials[input.code])
                f.code = 'That trial code already exists.';
            if (!input.title.trim())
                f.title = 'A study title is required.';
            if (!Number.isInteger(input.target) || input.target <= 0)
                f.target = 'Target must be a positive whole number.';
            if (!this.data.sites[siteId])
                f.siteId = 'Choose an existing site.';
            if (Object.keys(f).length)
                throw new DomainError('Review the new trial fields.', f);
            return this.commit(userId, 'createTrial', { id: input.code }, 'New fictional study saved as a draft.', s => {
                const id = input.code;
                const t = { ...base(id, 'Draft', userId), code: id, title: input.title, target: input.target, piId: userId, design: input.design || 'Prospective observational', startDate: input.startDate || day(), endDate: input.endDate || day(180), protocol: input.protocol || '', protocolVersion: input.protocolVersion || '1.0', consentVersion: '1.0', eligibility: input.eligibility || '', endpoints: input.endpoints || '', schedule: [0, 14, 28], iecStatus: 'Pending', iecExpiry: '', registration: input.registration || 'Not recorded', staffTrained: false };
                s.trials[id] = t;
                const tsid = id + '-' + siteId;
                s.trialSites[tsid] = { ...base(tsid, 'Pending', userId, id, siteId), trialId: id, siteId, target: input.target, expectedToDate: 0, readiness: { protocol: false, ethics: false, training: false, facilities: false }, evidence: { protocol: '', ethics: '', training: '', facilities: '' } };
                s.interventions['INT-' + id] = { ...base('INT-' + id, 'Draft', userId, id), trialId: id, type: intervention.type || 'Fictional formulation', name: intervention.name || 'Fictional intervention', ingredients: intervention.ingredients || '', doseText: intervention.doseText || 'Protocol-defined only', schedule: intervention.schedule || '', duration: intervention.duration || '', comparator: intervention.comparator || '', batch: intervention.batch || '', assessment: intervention.assessment || '' };
                for (const u of Ayu.vals(s.users))
                    if ([userId, 'u-admin', 'u-ethics'].includes(u.id)) {
                        const aid = u.id + '-' + id;
                        s.assignments[aid] = { id: aid, userId: u.id, trialId: id, siteIds: [siteId] };
                    }
                return t;
            });
        }
        configureTrial(userId, id, input) {
            const t = this.record(this.data.trials, id);
            if (t.status === 'Closed')
                throw new DomainError('A closed trial cannot be configured.');
            if (!input.protocol.trim() || !input.protocolVersion.trim())
                throw new DomainError('Protocol identifier and version are required.');
            return this.commit(userId, 'readiness', t, 'Protocol, registration tracking, and staff training configuration updated. No ethics approval granted.', s => { Object.assign(s.trials[id], input); return s.trials[id]; });
        }
        lifecycle(userId, id, status, reason) {
            const t = this.record(this.data.trials, id);
            if (!reason.trim())
                throw new DomainError('A lifecycle decision rationale is required.');
            const transitions = { Draft: ['Setup'], Setup: ['Recruiting'], Recruiting: ['Active Follow-up'], 'Active Follow-up': ['Close-out Review'], 'Close-out Review': ['Closed'] };
            if (!transitions[t.status]?.includes(status))
                throw new DomainError('Unsupported lifecycle transition.');
            const blockers = status === 'Recruiting' ? trialBlockers(this.data, t) : status === 'Closed' ? closeoutBlockers(this.data, id) : [];
            if (blockers.length)
                throw new DomainError('Transition blocked: ' + blockers.join('; '));
            return this.commit(userId, 'lifecycle', t, reason, s => { s.trials[id].status = status; return s.trials[id]; });
        }
        assign(userId, id, owner, reason) {
            const a = this.record(this.data.actions, id);
            const u = this.data.users[owner];
            if (!u || !inScope(this.data, u, a))
                throw new DomainError('Assignee must have the trial/site in scope.');
            if (!reason.trim())
                throw new DomainError('An assignment reason is required.');
            const required = { safety: ['PV'], query: a.nextAction === 'Verify response' ? ['Monitor'] : ['Coordinator'], visit: ['Coordinator'], participant: ['Coordinator'], trialSite: ['PI', 'Admin'], compliance: this.data.compliance[a.sourceId]?.kind === 'IEC' ? ['Ethics'] : ['Coordinator', 'PI', 'Admin'] };
            if (!required[a.sourceType]?.includes(u.role))
                throw new DomainError('Assignee role cannot perform the underlying workflow.');
            return this.commit(userId, 'assign', a, reason, s => { s.actions[id].owner = owner; return s.actions[id]; });
        }
        updateAssignment(userId, targetUser, trialId, siteIds) {
            this.check(userId, 'settings');
            if (!this.data.users[targetUser] || !this.data.trials[trialId] || siteIds.some(id => !this.data.trialSites[trialId + '-' + id]))
                throw new DomainError('Select a valid identity, trial, and trial-site associations.');
            return this.commit(userId, 'settings', { id: targetUser, trialId }, 'Explicit demo assignment update.', s => { const id = targetUser + '-' + trialId; const a = { id, userId: targetUser, trialId, siteIds }; s.assignments[id] = a; return a; });
        }
        settings(userId, hours, days) {
            if (!Number.isInteger(hours) || hours < 1 || hours > 720 || !Number.isInteger(days) || days < 1 || days > 90)
                throw new DomainError('Sample deadlines must be whole numbers: 1–720 hours and 1–90 days.');
            return this.commit(userId, 'settings', { id: 'DEMO-SETTINGS' }, 'Sample deadlines apply to new reports only; not legal time limits.', s => { s.settings = { seriousHours: hours, routineDays: days }; return s.settings; });
        }
        patternReview(userId, trialId, siteId, term) {
            const related = Ayu.vals(this.data.safety).filter(c => c.trialId === trialId && c.siteId === siteId && c.term === term);
            if (!related.length)
                throw new DomainError('No matching safety cases.');
            return this.commit(userId, 'patternReview', { id: 'PATTERN-' + trialId + '-' + siteId, trialId, siteId }, 'PV requested a descriptive-pattern review; no causality inferred.', s => {
                const trigger = 'pattern-' + trialId + '-' + siteId + '-' + term;
                const id = 'ACT-' + trigger;
                if (s.actions[id])
                    return s.actions[id];
                const a = { ...base(id, 'Open', userId, trialId, siteId), trialId, siteId, title: 'Potential pattern · ' + term, reason: related.length + ' event episodes; review source cases.', priority: 'High', due: day(2), sourceId: related[0].id, sourceType: 'safety', nextAction: 'Review source cases', trigger };
                s.actions[id] = a;
                return a;
            });
        }
        reset(userId) {
            this.check(userId, 'reset');
            const next = seed();
            if (this.storage) {
                try {
                    this.storage.setItem(Ayu.STORAGE_KEY, JSON.stringify(next));
                }
                catch {
                    throw new DomainError('Reset could not be persisted. No changes were applied.');
                }
            }
            this.data = next;
            this.warning = '';
            this.listeners.forEach(fn => fn());
        }
        validateImport(userId, rows) {
            this.check(userId, 'import');
            const seen = new Set();
            return rows.map((r, index) => {
                const errors = [];
                if (!r.id || !/^EDC-[A-Za-z0-9-]+$/.test(r.id))
                    errors.push('Participant ID must start EDC-.');
                if (seen.has(r.id) || this.data.participants[r.id] || Ayu.vals(this.data.participants).some(p => p.code === r.id))
                    errors.push('Duplicate participant ID: rejected.');
                seen.add(r.id);
                if (!this.data.trialSites[r.trialId + '-' + r.siteId])
                    errors.push('Unknown trial/site reference.');
                if (!['Screening', 'Screen Failed'].includes(r.status))
                    errors.push('Import supports screening states only; enrollment gates cannot be bypassed.');
                if (this.data.trials[r.trialId] && !inScope(this.data, this.data.users[userId], r))
                    errors.push('Outside assigned scope.');
                return { row: index + 1, input: r, valid: errors.length === 0, errors };
            });
        }
        commitImport(userId, rows) {
            const results = this.validateImport(userId, rows);
            if (results.some(r => !r.valid))
                throw new DomainError('Import blocked: resolve every invalid row, or explicitly remove rejected rows before committing.');
            if (!rows.length)
                throw new DomainError('No valid rows to import.');
            return this.commit(userId, 'import', { id: 'EDC-IMPORT' }, 'Validated synthetic EDC rows committed atomically; no overwrite.', s => {
                for (const r of rows) {
                    s.participants[r.id] = { ...base(r.id, r.status, userId, r.trialId, r.siteId), ...r, code: r.id, screeningCode: r.id, eligibility: false, reviewer: '', enrolledAt: null, history: [{ at: s.clock, status: r.status, note: 'Validated local EDC-style import' }] };
                }
                s.integrations.edc.status = 'Mock connector';
                s.integrations.edc.lastRun = s.clock;
                return rows.length;
            });
        }
    }
    Ayu.LocalRepository = LocalRepository;
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

module.exports=Ayu;
