"""Authoritative clinical repository and scope boundary.
The server runs the original TypeScript domain state machine as a local Node subprocess.
The SQLite transaction encloses validation, mutation, related records and clinical audit.
"""
from __future__ import annotations
import json, subprocess, datetime, csv, io, re
from .config import ROOT
from .security import AppError, ROLES

OPERATIONS = {
 'screen':(['Coordinator'],'screen',None), 'eligibility':(['PI','Coordinator'],'eligibility','participants'),
 'consent':(['Coordinator'],'consent','participants'), 'enroll':(['Coordinator'],'enroll','participants'),
 'visit':(['Coordinator'],'visit','visits'), 'safetyCreate':(['Coordinator','PI','PV'],'safetyCreate',None),
 'pvReview':(['PV'],'pvReview','safety'), 'prepareReport':(['PV'],'reportPrepare','safety'),
 'answerQuery':(['Coordinator'],'queryAnswer','queries'), 'verifyQuery':(['Monitor'],'queryVerify','queries'),
 'deviation':(['Monitor'],'deviation','deviations'), 'document':(['PI','Coordinator','Admin'],'document',None),
 'ethicsDecision':(['Ethics'],'ethicsDecision','documents'), 'completeCompliance':(['PI','Coordinator','Admin'],'compliance','compliance'),
 'readiness':(['PI','Admin'],'readiness','trialSites'), 'activateSite':(['PI','Admin'],'activateSite','trialSites'),
 'createTrial':(['PI','Admin'],'createTrial',None), 'configureTrial':(['PI','Admin'],'readiness','trials'),
 'lifecycle':(['PI'],'lifecycle','trials'), 'assign':(['PI','Admin'],'assign','actions'),
 'settings':(['Admin'],'settings',None), 'reset':(['Admin'],'reset',None),
 'patternReview':(['PV'],'patternReview',None), 'validateImport':(['Admin'],'import',None), 'commitImport':(['Admin'],'import',None)
}
COUNTS={'screen':1,'eligibility':3,'consent':3,'enroll':1,'visit':3,'safetyCreate':1,'pvReview':3,'prepareReport':1,
        'answerQuery':3,'verifyQuery':2,'deviation':2,'document':1,'ethicsDecision':4,'completeCompliance':2,
        'readiness':3,'activateSite':1,'createTrial':3,'configureTrial':2,'lifecycle':3,'assign':3,'settings':2,
        'reset':1,'patternReview':3,'validateImport':1,'commitImport':1}
OBJECTS={
 'screen':({'trialId':str,'siteId':str},()),
 'safetyCreate':({'participantId':str,'term':str,'description':str,'onset':str,'awareness':str,'severity':str,
                  'serious':bool,'criterion':str,'outcome':str,'interventionAction':str},()),
 'document':({'trialId':str,'family':str,'title':str,'content':str,'fileName':str,'size':int},('fileName','size')),
 'configureTrial':({'protocol':str,'protocolVersion':str,'registration':str,'staffTrained':bool,'eligibility':str,'endpoints':str},()),
 'trial':({'title':str,'code':str,'target':int,'design':str,'startDate':str,'endDate':str,'protocol':str,'protocolVersion':str,
           'eligibility':str,'endpoints':str,'registration':str},('design','startDate','endDate','protocol','protocolVersion','eligibility','endpoints','registration')),
 'intervention':({x:str for x in ['type','name','ingredients','doseText','schedule','duration','comparator','batch','assessment']},
                 ('type','name','ingredients','doseText','schedule','duration','comparator','batch','assessment')),
 'importRow':({'id':str,'trialId':str,'siteId':str,'status':str},())
}

def validate_object(value, spec):
    types, optional=OBJECTS[spec]
    if not isinstance(value,dict) or set(value)-set(types) or any(k not in value for k in set(types)-set(optional)):
        raise AppError(422,'Unexpected or missing fields. Only documented fields are accepted.',code='validation_failed')
    for key,val in value.items():
        if type(val) is not types[key]:raise AppError(422,'Invalid field type: '+key,code='validation_failed')
        if isinstance(val,str) and len(val)>(100000 if key=='content' else 10000):raise AppError(422,'Field is too long: '+key)
    return value

def validate_args(op, args):
    if op not in COUNTS or len(args)!=COUNTS[op]:raise AppError(422,'Unsupported operation arguments.',code='validation_failed')
    if op in ('screen','safetyCreate','document'):validate_object(args[0],op)
    elif op=='createTrial':
        validate_object(args[0],'trial');validate_object(args[1],'intervention')
        if type(args[2]) is not str:raise AppError(422,'A site ID is required.')
    elif op=='configureTrial':
        if type(args[0]) is not str:raise AppError(422,'A trial ID is required.')
        validate_object(args[1],op)
    elif op in ('validateImport','commitImport'):
        if not isinstance(args[0],list) or len(args[0])>500:raise AppError(422,'Import at most 500 screening rows at once.')
        for row in args[0]:validate_object(row,'importRow')
    elif op=='settings':
        if any(type(v) is not int for v in args):raise AppError(422,'Settings must be whole numbers.')
    elif op=='eligibility':
        if type(args[0]) is not str or type(args[1]) is not bool or type(args[2]) is not str:raise AppError(422,'Invalid eligibility arguments.')
    else:
        if any(type(v) is not str or len(v)>10000 for v in args):raise AppError(422,'Arguments must be bounded text fields.')
    if op=='document' and len(args[0]['content'].encode('utf-8'))>100000:raise AppError(422,'Synthetic documents are limited to 100 KB.')
    if op=='reset' and args[0]!='RESET':raise AppError(422,'Type RESET to confirm the clinical demo reset.')
    return [] if op=='reset' else args

class Clinical:
    def __init__(self, db, security):self.db,self.sec=db,security
    def worker(self, payload):
        try:
            output=subprocess.run(['node',str(ROOT/'server/domain_worker.cjs')],input=json.dumps(payload),
                                  text=True,capture_output=True,timeout=15,check=True)
            answer=json.loads(output.stdout)
        except (OSError,subprocess.SubprocessError,json.JSONDecodeError) as exc:
            raise AppError(503,'The clinical service is unavailable. No success was recorded.',code='clinical_unavailable',persist=False) from exc
        if not answer.get('ok'):
            message=answer.get('error','Clinical validation failed.')
            raise AppError(403 if message.startswith('Permission denied') else 422,message,fields=answer.get('fields'),code='clinical_validation')
        return answer

    def ensure_seed(self):
        with self.db.transaction() as db:
            if not db.execute('SELECT 1 FROM clinical_state WHERE id=1').fetchone():
                state=self.worker({'action':'seed'})['state']
                db.execute('INSERT INTO clinical_state(id,body) VALUES(1,?)',(json.dumps(state),))

    def load(self, db):
        row=db.execute('SELECT body,revision FROM clinical_state WHERE id=1').fetchone()
        state=json.loads(row['body'])
        # Account registry is the only authority for identity/role/scope; state cannot grant a role.
        known={r['id']:r for r in db.execute('SELECT * FROM users').fetchall()}
        for uid,account in known.items():
            safe=self.sec.safe_user(account)
            state['users'][uid]={k:safe[k] for k in ('id','name','role','initials','subtitle')}
        state['assignments']={k:v for k,v in state['assignments'].items() if v['userId'] not in known}
        for uid,account in known.items():
            for a in json.loads(account['assignments']):
                aid=uid+'-'+a['trialId']
                state['assignments'][aid]={'id':aid,'userId':uid,**a}
        return state,row['revision']

    def project(self, db, account, scope=None):
        state,revision=self.load(db)
        view=self.worker({'action':'view','state':state,'actor':account['id'],'scope':scope or {}})['result']
        view['permittedTrialTargets']={}
        for tid,t in view['trials'].items():
            permitted=[ts for ts in view['trialSites'].values() if ts['trialId']==tid]
            full=[ts for ts in state['trialSites'].values() if ts['trialId']==tid]
            view['permittedTrialTargets'][tid]=t['target'] if len(permitted)==len(full) and not (scope or {}).get('siteId') else sum(ts['target'] or 0 for ts in permitted)
        # Staff display labels support ownership/read-only audit; no password hashes/emails/session records here.
        view['users']={uid:{k:u[k] for k in ('id','name','role','initials','subtitle')} for uid,u in view['users'].items()}
        # Prevent a site-restricted reader seeing other-site records nested inside trial-scoped audit snapshots.
        for audit in view['audit'].values():
            audit['before']=self.sanitize_nested(audit.get('before'),account)
            audit['after']=self.sanitize_nested(audit.get('after'),account)
        if account['role']=='Regulator':view=self.deidentified(view)
        return view,revision

    def sanitize_nested(self,value,account):
        if isinstance(value,list):return [self.sanitize_nested(x,account) for x in value if self.nested_allowed(x,account)]
        if isinstance(value,dict):
            if not self.nested_allowed(value,account):return None
            return {k:self.sanitize_nested(v,account) for k,v in value.items() if k not in ('password_hash','email','assignments','users')}
        return value
    @staticmethod
    def nested_allowed(value,account):
        if not isinstance(value,dict) or not value.get('trialId'):return True
        return any(a['trialId']==value['trialId'] and (not value.get('siteId') or value['siteId'] in a['siteIds']) for a in json.loads(account['assignments']))

    @staticmethod
    def deidentified(view):
        # No automated de-identification claim: unstructured clinical narrative is withheld entirely.
        redacted='Withheld in de-identified regulator view.'
        for p in view['participants'].values():
            p['history']=[{**h,'note':redacted} for h in p['history']]
        for v in view['visits'].values():v['observations']=redacted
        for c in view['safety'].values():
            for key in ('description','interventionAction'):c[key]=redacted
            c['notes']=[{**n,'text':redacted} for n in c['notes']]
            # Only seeded descriptive terms are safe; newly captured uncoded free text is withheld.
            if not re.fullmatch(r'AE-00[1-9]|AE-010',c['id']):
                c['term']='Uncoded event — narrative withheld';c['outcome']=redacted;c['criterion']='Recorded criterion' if c['serious'] else 'Not serious'
        for q in view['queries'].values():
            q['value']=redacted;q['responses']=[{**r,'value':redacted,'previous':redacted,'note':redacted} for r in q['responses']]
        for d in view['deviations'].values():d['description']=redacted;d['correctiveAction']=redacted
        for d in view['documents'].values():
            if d['id'].startswith('DOC-NEW'):
                d['content']='Synthetic uploaded narrative withheld. Review document metadata and recorded decisions.'
                d['title']='Submitted document';d['fileName']='withheld.txt'
            d['comments']=[{**c,'text':redacted} for c in d['comments']]
        for a in view['audit'].values():
            a['before']=None;a['after']=None;a['reason']='Authenticated '+a['operation']+' action recorded; free-text values withheld.'
        for a in view['actions'].values():
            if a.get('sourceType')=='safety' and not re.fullmatch(r'AE-00[1-9]|AE-010',a.get('sourceId','')):
                a['title']='Safety review';a['reason']='Recorded safety case requires review.'
        return view

    def check_scope(self,request,db,account,scope):
        self.sec.requireTrialSiteAccess(request,db,account,scope.get('trialId'),scope.get('siteId'))

    def read(self,request,scope=None):
        with self.db.transaction() as db:
            account,_=self.sec.requireSession(request,db)
            self.check_scope(request,db,account,scope or {})
            view,revision=self.project(db,account,scope)
            return {'state':view,'revision':revision,'user':self.sec.safe_user(account)}

    def mutate(self,request,op,args):
        with self.db.transaction() as db:
            account,session=self.sec.requireSession(request,db,write=True)
            if op not in OPERATIONS:raise AppError(404,'Unknown operation.',code='not_found')
            roles,_,mapping=OPERATIONS[op]
            self.sec.requirePermission(request,db,account,roles)
            args=validate_args(op,args)
            state,revision=self.load(db)
            if mapping:
                record=state[mapping].get(args[0])
                if not record:raise AppError(404,'This record is not available to your account.',code='not_found')
                self.sec.requireTrialSiteAccess(request,db,account,record['id'] if mapping=='trials' else record.get('trialId'),record.get('siteId'))
            elif op=='screen':
                self.check_scope(request,db,account,args[0])
            elif op=='safetyCreate':
                p=state['participants'].get(args[0]['participantId'])
                if not p:raise AppError(404,'This participant is not available to your account.',code='not_found')
                self.check_scope(request,db,account,p)
            elif op=='document':self.check_scope(request,db,account,args[0])
            elif op=='patternReview':self.sec.requireTrialSiteAccess(request,db,account,args[0],args[1])
            elif op=='createTrial':self.sec.requireTrialSiteAccess(request,db,account,None,args[2])
            elif op=='reset' and not self.sec.cfg.demo_mode:raise AppError(403,'Clinical reset is enabled only in the isolated synthetic demo.')
            answer=self.worker({'action':'mutate','state':state,'actor':account['id'],'op':op,'args':args,
                                'stateUsers':state['users'],'stateAssignments':state['assignments'],
                                'now':datetime.datetime.fromtimestamp(self.sec.clock(),datetime.timezone.utc).isoformat()})
            next_state=answer['state']
            if op!='validateImport':
                # Trial creation can add valid new scopes; transfer them to authoritative account rows.
                if op=='createTrial':
                    for row in db.execute('SELECT * FROM users').fetchall():
                        memberships=[{'trialId':a['trialId'],'siteIds':a['siteIds']} for a in next_state['assignments'].values() if a['userId']==row['id']]
                        db.execute('UPDATE users SET assignments=? WHERE id=?',(json.dumps(memberships),row['id']))
                db.execute('UPDATE clinical_state SET body=?,revision=revision+1 WHERE id=1',(json.dumps(next_state),))
                self.sec.log(db,request,'clinical_write',op,account['id'])
            view,new_revision=self.project(db,account)
            return {'result':answer.get('result'),'state':view,'revision':new_revision}

    def specific(self,request,kind,record_id):
        allowed={'participants','visits','safety','documents','trials','trialSites','queries','actions','compliance','audit'}
        if kind not in allowed:raise AppError(404,'Not found.',code='not_found')
        result=self.read(request)['state'][kind].get(record_id)
        if result is None:raise AppError(404,'This record is not available to your account.',code='not_found')
        return result

    def assistant(self,request,question,scope):
        if len(question)>1000:raise AppError(422,'Use a question of at most 1,000 characters.')
        with self.db.transaction() as db:
            account,_=self.sec.requireSession(request,db,write=True)
            self.check_scope(request,db,account,scope)
            state,_=self.project(db,account,scope)
            label=(scope.get('trialId') or 'All permitted trials')+' / '+(scope.get('siteId') or 'All assigned sites')
            return self.worker({'action':'assistant','state':state,'actor':account['id'],'scope':scope,'question':question,'scopeLabel':label})['result']

    def report(self,request,kind,scope):
        if kind not in ('Recruitment','Site performance','Safety','Compliance','Audit'):raise AppError(422,'Choose a supported report.')
        with self.db.transaction() as db:
            account,_=self.sec.requireSession(request,db)
            self.check_scope(request,db,account,scope)
            state,_=self.project(db,account,scope)
            rows=self.worker({'action':'report','state':state,'actor':account['id'],'scope':scope,'kind':kind})['result']
            self.sec.log(db,request,'report_export',kind,account['id'])
            return {'product':'AYUSETU','label':'Synthetic demo data · unvalidated export','scope':scope,
                    'generatedAt':datetime.datetime.fromtimestamp(self.sec.clock(),datetime.timezone.utc).isoformat(),
                    'clinicalClock':state['clock'],'recordCount':len(rows),'rows':rows}

    @staticmethod
    def csv(payload):
        rows=payload['rows'];buf=io.StringIO()
        if not rows:return ''
        writer=csv.DictWriter(buf,fieldnames=list(rows[0]));writer.writeheader()
        # Neutralize spreadsheet-formula execution from arbitrary free-text fields.
        def cell(value):
            if isinstance(value,str) and value.lstrip().startswith(('=','+','-','@','\t','\r')):return "'"+value
            return value
        writer.writerows([{k:cell(v) for k,v in row.items()} for row in rows])
        return buf.getvalue()
