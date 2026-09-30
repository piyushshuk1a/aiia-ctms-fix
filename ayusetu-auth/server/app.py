"""AYUSETU same-origin FastAPI application. Run: python -m server.run"""
from __future__ import annotations
import json, secrets, os
from pathlib import Path
from urllib.parse import urlsplit, quote
from typing import Any
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, FileResponse, RedirectResponse
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.authentication import AuthenticationMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from .config import Settings, ROOT
from .database import Database
from .security import Security, SessionBackend, AppError, ROLES, PAGES, HOME, CSRF, normalize_email
from .clinical import Clinical

class StrictModel(BaseModel):
    model_config=ConfigDict(extra='forbid', strict=True)
class Login(StrictModel):
    email:str=Field(max_length=1000)
    password:str=Field(max_length=4096)
    remember:bool=False
    next:str=''
class OTP(StrictModel):code:str=Field(max_length=32)
class Email(StrictModel):email:str=Field(max_length=1000)
class ResetPassword(StrictModel):
    token:str=Field(max_length=512)
    newPassword:str=Field(max_length=1024)
    confirmPassword:str=Field(max_length=1024)
class ChangePassword(StrictModel):
    currentPassword:str=Field(max_length=4096)
    newPassword:str=Field(max_length=1024)
    confirmPassword:str=Field(max_length=1024)
class Operation(StrictModel):
    op:str=Field(max_length=40)
    args:list[Any]=Field(max_length=8)
class Scope(StrictModel):
    trialId:str|None=None
    siteId:str|None=None
class Question(StrictModel):
    question:str=Field(max_length=1000)
    scope:Scope=Field(default_factory=Scope)
class Assignment(StrictModel):
    trialId:str=Field(max_length=60)
    siteIds:list[str]=Field(max_length=20)
class AccountCreate(StrictModel):
    email:str=Field(max_length=254)
    name:str=Field(min_length=1,max_length=100)
    role:str=Field(max_length=32)
    assignments:list[Assignment]=Field(default_factory=list,max_length=100)
class AccountUpdate(StrictModel):
    name:str|None=Field(default=None,min_length=1,max_length=100)
    role:str|None=Field(default=None,max_length=32)
    active:bool|None=None
    assignments:list[Assignment]|None=Field(default=None,max_length=100)
    reason:str=Field(min_length=3,max_length=1000)

DEMO=[('u-pi','pi','PI'),('u-coord','coordinator','Coordinator'),('u-monitor','monitor','Monitor'),
      ('u-ethics','ethics','Ethics'),('u-pv','pv','PV'),('u-admin','admin','Admin'),('u-regulator','regulator','Regulator')]

def seed_demo(db,sec,clinical):
    if not sec.cfg.demo_mode:return
    with db.transaction() as conn:
        if conn.execute("SELECT 1 FROM metadata WHERE key='demo_accounts_v2'").fetchone():return
        state=json.loads(conn.execute('SELECT body FROM clinical_state WHERE id=1').fetchone()['body'])
        for uid,local,role in DEMO:
            memberships=[{'trialId':a['trialId'],'siteIds':a['siteIds']} for a in state['assignments'].values() if a['userId']==uid]
            if role=='Coordinator':memberships=[{'trialId':'AYU-001','siteIds':['S1']}]
            if role=='Monitor':memberships=[{'trialId':'AYU-001','siteIds':['S1','S2','S3']}]
            conn.execute('INSERT OR IGNORE INTO users(id,email,name,role,password_hash,assignments,created) VALUES(?,?,?,?,?,?,?)',
                         (uid,local+'@ayusetu.test',state['users'][uid]['name'],role,sec.hasher.hash('AyuSetu-Demo-2026!'),json.dumps(memberships),sec.clock()))
        conn.execute("INSERT INTO metadata VALUES('demo_accounts_v2','seeded_once')")
        sec.log(conn,None,'demo_accounts_seeded','explicit_isolated_synthetic_configuration')

def create_app(settings: Settings|None=None, clock=None):
    cfg=(settings or Settings()).validate();db=Database(cfg.database);sec=Security(cfg,db,clock);clinical=Clinical(db,sec)
    with db.connect() as conn:
        if not cfg.demo_mode and conn.execute("SELECT 1 FROM metadata WHERE key='demo_accounts_v2'").fetchone():
            raise RuntimeError('A seeded demo database may run only with DEMO_MODE and ISOLATED_SYNTHETIC enabled. Use a separate empty database for non-demo configuration.')
    clinical.ensure_seed();seed_demo(db,sec,clinical)
    app=FastAPI(title='AYUSETU synthetic research prototype',docs_url=None,redoc_url=None,openapi_url=None)
    app.state.security=sec;app.state.db=db;app.state.clinical=clinical;app.state.settings=cfg
    app.add_middleware(AuthenticationMiddleware,backend=SessionBackend(sec))
    app.add_middleware(TrustedHostMiddleware,allowed_hosts=[urlsplit(cfg.origin).hostname])

    @app.middleware('http')
    async def headers_and_limits(request:Request,call_next):
        if request.method in ('POST','PUT','PATCH'):
            size=0;chunks=[]
            async for chunk in request.stream():
                size+=len(chunk)
                if size>1048576:return JSONResponse({'message':'Request exceeds the 1 MB prototype limit.'},status_code=413,headers={'Cache-Control':'no-store'})
                chunks.append(chunk)
            request._body=b''.join(chunks)
        response=await call_next(request)
        if hasattr(request.state, 'idle_expires'):response.headers['X-Ayu-Idle-Expires']=str(request.state.idle_expires)
        response.headers['Cache-Control']='no-store, max-age=0'
        response.headers['Pragma']='no-cache'
        response.headers['X-Content-Type-Options']='nosniff'
        response.headers['Referrer-Policy']='no-referrer'
        response.headers['X-Frame-Options']='DENY'
        response.headers['Permissions-Policy']='camera=(), microphone=(), geolocation=()'
        response.headers['Content-Security-Policy']="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        if cfg.cookie_secure:response.headers['Strict-Transport-Security']='max-age=31536000'
        return response

    @app.exception_handler(AppError)
    async def application_error(request:Request,exc:AppError):
        if exc.code=='csrf_failed':
            with db.transaction() as conn:sec.log(conn,request,'access_denied','csrf_verification_failed')
        return JSONResponse({'message':exc.message,'code':exc.code,'fields':exc.fields},status_code=exc.status,headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request:Request,exc):
        # FastAPI's default includes offending input. Never reflect password/token values.
        fields={str(err['loc'][-1]):'Missing, unexpected, or invalid field.' for err in exc.errors()}
        return JSONResponse({'message':'Review the request fields.','code':'validation_failed','fields':fields},status_code=422)

    @app.get('/health')
    def health():return {'status':'ok','application':'AYUSETU','storage':'SQLite','authentication':'server-verified'}

    @app.get('/api/auth/bootstrap')
    def bootstrap(request:Request,response:Response):return sec.bootstrap(request,response)
    @app.post('/api/auth/login')
    def login(body:Login,request:Request,response:Response):return sec.login(request,response,body.email,body.password,body.remember,body.next)
    @app.get('/api/auth/session')
    def session(request:Request):
        with db.transaction() as conn:
            user,session=sec.requireSession(request,conn,activity=False)
            return sec.session_payload(user,session,request.cookies.get(CSRF,''))
    @app.post('/api/auth/activity')
    def activity(request:Request):
        with db.transaction() as conn:
            user,session=sec.requireSession(request,conn,write=True)
            return {'idleExpiresAt':sec.clock()+cfg.idle_seconds}
    @app.post('/api/auth/refresh')
    def refresh(request:Request,response:Response):return sec.refresh(request,response)
    @app.post('/api/auth/logout')
    def logout(request:Request,response:Response):return sec.logout(request,response)
    @app.get('/api/auth/otp')
    def otp_status(request:Request):
        with db.connect() as conn:
            challenge,_=sec.challenge(request,conn)
            return {'expiresAt':challenge['expires'],'resendAt':challenge['last_sent']+cfg.otp_resend_seconds,
                    'attemptsRemaining':cfg.otp_attempts-challenge['attempts']}
    @app.post('/api/auth/otp/verify')
    def verify_otp(body:OTP,request:Request,response:Response):return sec.verify_otp(request,response,body.code)
    @app.post('/api/auth/otp/resend')
    def resend_otp(request:Request):return sec.resend_otp(request)
    @app.post('/api/auth/forgot-password')
    def forgot_password(body:Email,request:Request):return sec.forgot(request,body.email)
    @app.post('/api/auth/reset-password')
    def reset_password(body:ResetPassword,request:Request,response:Response):return sec.reset_password(request,response,body.token,body.newPassword,body.confirmPassword)
    @app.post('/api/auth/change-password')
    def change_password(body:ChangePassword,request:Request,response:Response):return sec.change_password(request,response,body.currentPassword,body.newPassword,body.confirmPassword)
    @app.get('/api/auth/security')
    def own_security(request:Request):
        with db.transaction() as conn:
            user,_=sec.requireSession(request,conn)
            rows=conn.execute('SELECT at,event,reason FROM security_log WHERE actor_id=? ORDER BY id DESC LIMIT 10',(user['id'],)).fetchall()
            return {'events':[dict(row) for row in rows]}

    @app.get('/api/demo/accounts')
    def demo_accounts():
        if not cfg.demo_mode or not cfg.isolated_synthetic:raise AppError(404,'Not found.',code='not_found')
        return {'accounts':[{'email':local+'@ayusetu.test','role':role,'otpRequired':role in cfg.otp_roles} for _,local,role in DEMO],
                'password':'AyuSetu-Demo-2026!','label':'Public credentials · isolated synthetic demo only'}
    @app.get('/api/demo/outbox')
    def demo_outbox(request:Request):return sec.outbox(request)

    @app.get('/api/records')
    def records(request:Request,trialId:str|None=None,siteId:str|None=None):
        return clinical.read(request,{k:v for k,v in {'trialId':trialId,'siteId':siteId}.items() if v})
    @app.get('/api/records/{kind}/{record_id}')
    def record(kind:str,record_id:str,request:Request):return clinical.specific(request,kind,record_id)
    @app.post('/api/operations')
    def operation(body:Operation,request:Request):return clinical.mutate(request,body.op,body.args)
    @app.post('/api/assistant')
    def assistant(body:Question,request:Request):return clinical.assistant(request,body.question,body.scope.model_dump(exclude_none=True))
    @app.get('/api/search')
    def search(request:Request,q:str='',trialId:str|None=None,siteId:str|None=None):
        state=clinical.read(request,{k:v for k,v in {'trialId':trialId,'siteId':siteId}.items() if v})['state']
        if len(q)>200:raise AppError(422,'Search queries are limited to 200 characters.')
        needle=q.casefold();items=[]
        for kind,label_key in [('trials','title'),('participants','code'),('safety','term'),('trialSites','id'),('queries','question')]:
            for r in state[kind].values():
                label=(state['sites'][r['siteId']]['city']+' · '+r['trialId']) if kind=='trialSites' else r[label_key]
                if needle in (r['id']+' '+label).casefold():
                    items.append({'type':{'trials':'trial','participants':'participant','safety':'safety','trialSites':'trialSite','queries':'query'}[kind],
                                  'id':r['id'],'label':label,'subtitle':r['id']+' · '+r['status'],'icon':'file'})
        return {'items':items[:10]}
    @app.get('/api/exports')
    def export(request:Request,kind:str='Recruitment',format:str='json',trialId:str|None=None,siteId:str|None=None):
        if format not in ('json','csv'):raise AppError(422,'Choose CSV or JSON.')
        payload=clinical.report(request,kind,{k:v for k,v in {'trialId':trialId,'siteId':siteId}.items() if v})
        filename='AYUSETU-demo-'+kind.replace(' ','-')+'.'+format
        return Response(clinical.csv(payload) if format=='csv' else json.dumps(payload,indent=2),
                        media_type='text/csv; charset=utf-8' if format=='csv' else 'application/json',
                        headers={'Content-Disposition':'attachment; filename="'+filename+'"'})
    @app.get('/api/documents/{document_id}/download')
    def download_document(document_id:str,request:Request):
        record=clinical.specific(request,'documents',document_id)
        filename='AYUSETU-'+''.join(c for c in document_id if c.isalnum() or c=='-')+'.txt'
        return Response(record['content'],media_type='text/plain',headers={'Content-Disposition':'attachment; filename="'+filename+'"'})

    def admin(conn,request,write=False):
        account,session=sec.requireSession(request,conn,write=write)
        sec.requirePermission(request,conn,account,['Admin'])
        return account
    def checked_assignments(conn,memberships):
        state,_=clinical.load(conn)
        values=[a.model_dump() if isinstance(a,BaseModel) else a for a in memberships]
        seen=set()
        for a in values:
            if a['trialId'] in seen or a['trialId'] not in state['trials'] or not a['siteIds'] or len(a['siteIds'])!=len(set(a['siteIds'])) or any(a['trialId']+'-'+s not in state['trialSites'] for s in a['siteIds']):
                raise AppError(422,'Choose unique existing trials with at least one valid assigned site each.')
            seen.add(a['trialId'])
        return values
    def account_view(row):
        return {**sec.safe_user(row),'active':bool(row['active']),'passwordSet':bool(row['password_hash'])}

    @app.get('/api/admin/accounts')
    def accounts(request:Request):
        with db.transaction() as conn:
            admin(conn,request)
            return {'accounts':[account_view(row) for row in conn.execute('SELECT * FROM users ORDER BY created,id').fetchall()]}
    @app.post('/api/admin/accounts')
    def create_account(body:AccountCreate,request:Request):
        with db.transaction() as conn:
            actor=admin(conn,request,True);email=normalize_email(body.email)
            if body.role not in ROLES:raise AppError(422,'Select a supported staff role.')
            if not body.name.strip():raise AppError(422,'A staff name is required.')
            if conn.execute('SELECT 1 FROM users WHERE email=?',(email,)).fetchone():raise AppError(409,'An account with that email already exists.')
            memberships=checked_assignments(conn,body.assignments)
            uid='u-'+secrets.token_hex(12)
            conn.execute('INSERT INTO users(id,email,name,role,assignments,created) VALUES(?,?,?,?,?,?)',(uid,email,body.name.strip(),body.role,json.dumps(memberships),sec.clock()))
            account=conn.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone()
            sec.issue_recovery(conn,request,account,'setup')
            sec.log(conn,request,'account_created','one_time_password_setup',actor['id'],uid)
            return {'account':account_view(account),'message':'Account created. A one-time setup link was requested through the configured channel.'}
    @app.patch('/api/admin/accounts/{user_id}')
    def update_account(user_id:str,body:AccountUpdate,request:Request):
        with db.transaction() as conn:
            actor=admin(conn,request,True)
            account=conn.execute('SELECT * FROM users WHERE id=?',(user_id,)).fetchone()
            if not account:raise AppError(404,'Account not found.')
            changes=body.model_dump(exclude_unset=True);changes.pop('reason',None)
            if not changes:raise AppError(422,'Choose an account change.')
            if 'role' in changes and changes['role'] not in ROLES:raise AppError(422,'Select a supported staff role.')
            if 'active' in changes and changes['active'] is None:raise AppError(422,'Account status must be true or false.')
            if 'name' in changes and (not changes['name'] or not changes['name'].strip()):raise AppError(422,'A staff name is required.')
            if 'assignments' in changes:
                if changes['assignments'] is None:raise AppError(422,'Assignments must be an array.')
                changes['assignments']=json.dumps(checked_assignments(conn,body.assignments))
            if account['role']=='Admin' and (changes.get('role','Admin')!='Admin' or changes.get('active',True) is False):
                count=conn.execute("SELECT COUNT(*) FROM users WHERE role='Admin' AND active=1").fetchone()[0]
                if count<=1:raise AppError(409,'Keep at least one active Administrator account.')
            allowed=('name','role','active','assignments')
            columns=[k for k in changes if k in allowed]
            conn.execute('UPDATE users SET '+','.join(k+'=?' for k in columns)+',version=version+1 WHERE id=?',tuple(changes[k] for k in columns)+(user_id,))
            sec.invalidate_user(conn,user_id)
            # Restrict audit reason to a bounded operator-entered note; never include request payloads/secrets.
            sec.log(conn,request,'account_access_changed',body.reason.strip(),actor['id'],user_id)
            account=conn.execute('SELECT * FROM users WHERE id=?',(user_id,)).fetchone()
            return {'account':account_view(account),'message':'Account updated. Existing sessions and pending challenges were revoked.'}
    @app.post('/api/admin/accounts/{user_id}/setup-link')
    def setup_link(user_id:str,request:Request):
        with db.transaction() as conn:
            actor=admin(conn,request,True);account=conn.execute('SELECT * FROM users WHERE id=?',(user_id,)).fetchone()
            if not account or not account['active']:raise AppError(404,'Active account not found.')
            sec.throttle(conn,request,'admin_recovery',user_id)
            sec.issue_recovery(conn,request,account,'reset' if account['password_hash'] else 'setup')
            sec.log(conn,request,'account_link_requested','setup_or_recovery',actor['id'],user_id)
            return {'message':'A one-time link was requested through the configured delivery channel.'}
    @app.get('/api/admin/security-log')
    def security_log(request:Request):
        with db.transaction() as conn:
            admin(conn,request)
            return {'events':[dict(row) for row in conn.execute('SELECT id,at,actor_id,event,reason,subject FROM security_log ORDER BY id DESC LIMIT 200').fetchall()]}

    # Explicit public asset allowlist: NEVER mount project root, server source, database, or .env.
    assets={'app.js':ROOT/'build/app.js','styles.css':ROOT/'src/styles.css','react.min.js':ROOT/'vendor/react.min.js','react-dom.min.js':ROOT/'vendor/react-dom.min.js','bootstrap.js':ROOT/'src/bootstrap.js'}
    @app.get('/assets/{name}')
    def asset(name:str):
        if name not in assets:raise AppError(404,'Not found.')
        return FileResponse(assets[name],media_type='text/css' if name.endswith('.css') else 'application/javascript')

    @app.get('/{path:path}')
    def page(path:str,request:Request):
        if path.startswith('api/') or path.startswith('assets/'):raise AppError(404,'Not found.')
        public=('login','verify-otp','forgot-password','reset-password')
        if path not in public and path and path not in PAGES:raise AppError(404,'Page not found.')
        if path not in public:
            if not request.user.is_authenticated:
                return RedirectResponse('/login'+('?next='+quote('/'+path,safe='') if path else ''),status_code=303)
            if path=='admin' and request.user.account['role']!='Admin':
                return FileResponse(ROOT/'dist/access-denied.html',status_code=403,media_type='text/html')
        return FileResponse(ROOT/'dist/index.html',media_type='text/html')
    return app
