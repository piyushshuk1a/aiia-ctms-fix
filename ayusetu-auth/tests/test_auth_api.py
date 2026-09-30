"""Actual FastAPI/SQLite/Node integration tests. No mocked authentication or clinical service.
A controlled clock tests policy boundaries; Argon2id keeps its actual library defaults.
"""
import copy, json, secrets, shutil, time, re
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from server.app import create_app, DEMO
from server.config import Settings, ROOT
from server.security import ACCESS, REFRESH, CSRF, PREAUTH, OUTBOX

PASSWORD='AyuSetu-Demo-2026!'
NEW='a long replacement passphrase with spaces'
ORIGIN='http://127.0.0.1:5173'
class Clock:
    def __init__(self):self.value=time.time()
    def __call__(self):return self.value
    def advance(self,seconds):self.value+=seconds

@pytest.fixture(scope='session')
def template(tmp_path_factory):
    path=tmp_path_factory.mktemp('base')/'template.sqlite3'
    cfg=Settings(secret=secrets.token_urlsafe(48),database=str(path),origin=ORIGIN,demo_mode=True,isolated_synthetic=True,retry_delay_scale=0)
    app=create_app(cfg)
    with app.state.db.connect() as db:db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    return path

@pytest.fixture
def env(tmp_path,template):
    database=tmp_path/'test.sqlite3';shutil.copy2(template,database)
    clock=Clock();cfg=Settings(secret=secrets.token_urlsafe(48),database=str(database),origin=ORIGIN,demo_mode=True,isolated_synthetic=True,retry_delay_scale=0)
    app=create_app(cfg,clock=clock)
    return app,clock,cfg

class Browser:
    def __init__(self,env):
        self.app=env[0];self.c=TestClient(self.app,base_url=env[2].origin);self.csrf='';self.bootstrap()
    def bootstrap(self):
        r=self.c.get('/api/auth/bootstrap');assert r.status_code==200;self.csrf=r.json()['csrfToken'];return r
    def post(self,path,data=None,**kwargs):
        h={'X-CSRF-Token':self.csrf,**kwargs.pop('headers',{})}
        return self.c.post(path,json=data or {},headers=h,**kwargs)
    def login(self,email='pi@ayusetu.test',password=PASSWORD,otp=True,remember=False,next=''):
        r=self.post('/api/auth/login',{'email':email,'password':password,'remember':remember,'next':next})
        if r.status_code==200 and r.json().get('otpRequired') and otp:
            r=self.post('/api/auth/otp/verify',{'code':self.code()})
        if r.status_code==200 and 'csrfToken' in r.json():self.csrf=r.json()['csrfToken']
        return r
    def code(self):
        r=self.c.get('/api/demo/outbox');assert r.status_code==200
        return [m['code'] for m in r.json()['messages'] if m['kind']=='otp'][-1]
    def reset_token(self,email='pi@ayusetu.test'):
        r=self.post('/api/auth/forgot-password',{'email':email});assert r.status_code==200
        m=[m for m in self.c.get('/api/demo/outbox').json()['messages'] if m['kind']=='reset'][-1]
        return m['url'].split('#token=')[1]
    def op(self,name,args):return self.post('/api/operations',{'op':name,'args':args})
    def state(self):
        r=self.c.get('/api/records');assert r.status_code==200,r.text;return r.json()['state']
    def logout(self):
        r=self.post('/api/auth/logout');self.bootstrap();return r

@pytest.mark.parametrize('uid,local,role',DEMO)
def test_all_seven_accounts_session_scope_home(env,uid,local,role):
    b=Browser(env);r=b.login(local+'@ayusetu.test');assert r.status_code==200,r.text
    v=r.json();assert v['user']['id']==uid and v['user']['role']==role
    assert v['destination']=='/'+v['user']['home']
    assert b.c.get('/api/auth/session').json()['user']['id']==uid
    state=b.state()
    if role=='Coordinator':
        assert set(p['siteId'] for p in state['participants'].values())=={'S1'}
        assert set(state['trials'])=={'AYU-001'} and state['viewTarget']==70
        assert state['permittedTrialTargets']=={'AYU-001':70}
        assert state['participants']['SCR-001']['eligibility']
    elif role=='Monitor':assert set(state['trials'])=={'AYU-001'}
    else:assert len(state['trials'])==3
    assert b.c.get(v['destination']).status_code==200

@pytest.mark.parametrize('email,password,reason',[
 ('pi@ayusetu.test','incorrect-password','invalid_password'),('unknown@ayusetu.test',PASSWORD,'unknown_account'),('pi@ayusetu.test',PASSWORD+' ','invalid_password')])
def test_generic_login_failures_and_restricted_reason(env,email,password,reason):
    b=Browser(env);r=b.login(email,password);assert r.status_code==401
    assert r.json()['message']=='Sign-in failed. Check your email and password or try again later.'
    with env[0].state.db.connect() as db:
        row=db.execute("SELECT * FROM security_log WHERE event='login_failed' ORDER BY id DESC LIMIT 1").fetchone();assert row['reason']==reason
    assert b.c.get('/api/records').status_code==401

def test_disabled_account_is_generic(env):
    with env[0].state.db.transaction() as db:db.execute("UPDATE users SET active=0 WHERE id='u-pi'")
    b=Browser(env);r=b.login();assert r.status_code==401
    assert r.json()['code']=='invalid_credentials'

def test_email_normalization_only(env):
    b=Browser(env);assert b.login('  PI@AYUSETU.TEST  ').status_code==200
    assert b.c.get('/api/auth/session').json()['user']['email']=='pi@ayusetu.test'

def test_demo_picker_does_not_authenticate(env):
    b=Browser(env);d=b.c.get('/api/demo/accounts').json();assert len(d['accounts'])==7 and d['password']==PASSWORD
    assert b.c.get('/api/auth/session').status_code==401
    assert b.c.get('/api/records').status_code==401

def test_argon2id_seed_and_server_only_client_bundle(env):
    with env[0].state.db.connect() as db:
        rows=db.execute('SELECT password_hash FROM users').fetchall();assert len(rows)==7
        assert all(r[0].startswith('$argon2id$') for r in rows)
        assert all(PASSWORD not in r[0] for r in rows)
        assert len(set(r[0] for r in rows))==7
    bundle=(ROOT/'build/app.js').read_text()
    assert 'function seed(' not in bundle and 'class LocalRepository' not in bundle and PASSWORD not in bundle

@pytest.mark.parametrize('url',['/api/records','/api/records/participants/AYU-001-S1-001','/api/search?q=Delhi','/api/exports','/api/documents/DOC-AYU-001-2/download','/api/admin/accounts','/api/admin/security-log'])
def test_protected_read_endpoints_require_session(env,url):
    assert Browser(env).c.get(url).status_code==401

@pytest.mark.parametrize('url',['/overview','/participants','/monitoring','/reports','/profile','/admin'])
def test_protected_urls_redirect_to_login_without_records(env,url):
    r=Browser(env).c.get(url,follow_redirects=False);assert r.status_code==303 and r.headers['location'].startswith('/login')
    assert 'SCR-001' not in r.text

def test_assistant_and_operations_require_session(env):
    b=Browser(env);assert b.post('/api/assistant',{'question':'Prepare a recruitment summary.'}).status_code==401
    assert b.op('enroll',['SCR-001']).status_code==401

def test_no_public_signup_or_self_selected_role(env):
    b=Browser(env);assert b.post('/api/auth/signup',{'role':'Admin'}).status_code in (404,405)
    assert b.post('/api/auth/login',{'email':'pi@ayusetu.test','password':PASSWORD,'role':'Admin'}).status_code==422

def test_login_throttling_persists_and_retry_is_bounded(env):
    b=Browser(env)
    for _ in range(5):assert b.login(password='wrong').status_code==401
    r=b.login(password='wrong');assert r.status_code==429 and 1<=int(r.headers['Retry-After'])<=900
    c=Browser(env);assert c.login().status_code==429
    env[1].advance(901);assert c.login().status_code==200

@pytest.mark.parametrize('mode',['missing','wrong','origin','cross-site'])
def test_csrf_rejects_writes(env,mode):
    b=Browser(env);assert b.login('coordinator@ayusetu.test').status_code==200
    headers={} if mode=='missing' else {'X-CSRF-Token':'wrong' if mode=='wrong' else b.csrf}
    if mode=='origin':headers['Origin']='https://attacker.invalid'
    if mode=='cross-site':headers['Sec-Fetch-Site']='cross-site'
    r=b.c.post('/api/operations',json={'op':'consent','args':['SCR-001','2.0','2026-09-28']},headers=headers)
    assert r.status_code==403 and r.json()['code']=='csrf_failed'
    assert not b.state()['participants']['SCR-001']['enrolledAt']

def test_login_csrf_rejected(env):
    b=Browser(env);r=b.c.post('/api/auth/login',json={'email':'pi@ayusetu.test','password':PASSWORD});assert r.status_code==403

def test_cookie_attributes_normal_and_remembered(env):
    b=Browser(env);r=b.login();cookies=r.headers.get_list('set-cookie')
    auth=[x for x in cookies if x.startswith((ACCESS+'=',REFRESH+'=',CSRF+'='))]
    assert len(auth)==3 and all('HttpOnly' in c and 'SameSite=lax' in c for c in auth)
    assert all('Max-Age=' not in c for c in auth)
    assert r.json()['session']['absoluteExpiresAt']-env[1]()==28800
    b.logout();r=b.login(remember=True);assert r.json()['session']['absoluteExpiresAt']-env[1]()==604800
    assert any('Max-Age=604800' in c for c in r.headers.get_list('set-cookie') if c.startswith(REFRESH+'='))

def test_secure_cookie_configuration(env):
    cfg=copy.copy(env[2]);cfg.origin='https://example.test';cfg.cookie_secure=True
    app=create_app(cfg,clock=env[1]);b=Browser((app,env[1],cfg));r=b.login()
    assert r.status_code==200 and 'Secure' in r.headers.get_list('set-cookie')[0]
    assert r.headers['Strict-Transport-Security']=='max-age=31536000'

def test_html_security_headers_and_no_protected_cache(env):
    b=Browser(env);r=b.c.get('/login');assert 'no-store' in r.headers['cache-control']
    assert "script-src 'self'" in r.headers['content-security-policy'] and 'unsafe-eval' not in r.headers['content-security-policy']
    b.login();r=b.c.get('/api/records');assert 'no-store' in r.headers['cache-control']
    assert 'password_hash' not in r.text and 'refresh_digest' not in r.text

def test_only_allowlisted_assets_are_served(env):
    b=Browser(env)
    for path in ['/.env','/runtime/ayusetu.sqlite3','/server/security.py','/assets/domain.cjs','/src/domain.ts','/build/domain.cjs']:
        assert b.c.get(path).status_code==404
    assert b.c.get('/assets/app.js').status_code==200

@pytest.mark.parametrize('role',['admin','pv'])
def test_otp_cannot_be_skipped(env,role):
    b=Browser(env);r=b.login(role+'@ayusetu.test',otp=False);assert r.status_code==200 and r.json()['otpRequired']
    assert 'user' not in r.json() and 'code' not in r.text
    assert b.c.get('/api/records').status_code==401 and b.post('/api/auth/refresh').status_code==401
    assert b.c.get('/api/auth/otp').status_code==200
    r=b.post('/api/auth/otp/verify',{'code':b.code()});assert r.status_code==200

def test_otp_invalid_maximum_attempts_consumption(env):
    b=Browser(env);b.login('pv@ayusetu.test',otp=False);code=b.code();wrong='000000' if code!='000000' else '111111'
    for _ in range(5):assert b.post('/api/auth/otp/verify',{'code':wrong}).status_code==401
    assert b.post('/api/auth/otp/verify',{'code':code}).status_code==401
    assert b.c.get('/api/records').status_code==401

def test_otp_resend_cooldown_invalidation_and_single_use(env):
    b=Browser(env);b.login('admin@ayusetu.test',otp=False);old=b.code()
    assert b.post('/api/auth/otp/resend').status_code==429
    env[1].advance(31);assert b.post('/api/auth/otp/resend').status_code==200
    new=b.code();assert new!=old
    assert b.post('/api/auth/otp/verify',{'code':old}).status_code==401
    challenge_cookie=b.c.cookies.get(PREAUTH)
    r=b.post('/api/auth/otp/verify',{'code':new});assert r.status_code==200
    b.csrf=r.json()['csrfToken'];b.c.cookies.set(PREAUTH,challenge_cookie,domain='127.0.0.1',path='/')
    assert b.post('/api/auth/otp/verify',{'code':new}).status_code==401

def test_otp_expiry_is_server_clock_not_clinical_clock(env):
    b=Browser(env);b.login('pv@ayusetu.test',otp=False);code=b.code();env[1].advance(301)
    assert b.post('/api/auth/otp/verify',{'code':code}).status_code==401

def test_otp_outbox_is_challenge_and_browser_scoped(env):
    b=Browser(env);b.login('pv@ayusetu.test',otp=False);assert b.code()
    other=Browser(env);assert other.c.get('/api/demo/outbox').json()['messages']==[]
    b.c.cookies.delete(PREAUTH,domain='127.0.0.1',path='/');assert not b.c.get('/api/demo/outbox').json()['messages']

def test_session_lookup_restore_and_access_rotation(env):
    b=Browser(env);r=b.login();sid=r.json()['session']['id'];absolute=r.json()['session']['absoluteExpiresAt']
    clone=TestClient(env[0],base_url=ORIGIN);clone.cookies.update(b.c.cookies)
    assert clone.get('/api/auth/session').json()['session']['id']==sid
    env[1].advance(901);assert b.c.get('/api/auth/session').status_code==401
    r=b.post('/api/auth/refresh');assert r.status_code==200
    assert r.json()['session']['id']==sid and r.json()['session']['absoluteExpiresAt']==absolute
    assert r.json()['session']['idleExpiresAt'] < env[1]()+1800
    assert b.c.get('/api/records').status_code==200

def test_refresh_replay_revokes_new_session(env):
    b=Browser(env);b.login();old=b.c.cookies.get(REFRESH)
    env[1].advance(901);assert b.post('/api/auth/refresh').status_code==200
    assert b.c.cookies.get(REFRESH)!=old
    c=TestClient(env[0],base_url=ORIGIN);c.cookies.update(b.c.cookies);c.cookies.set(REFRESH,old,domain='127.0.0.1',path='/api/auth')
    assert c.post('/api/auth/refresh',json={},headers={'X-CSRF-Token':b.csrf}).status_code==401
    assert b.c.get('/api/records').status_code==401

@pytest.mark.parametrize('remember',[False,True])
def test_inactivity_timeout_applies_to_all_sessions(env,remember):
    b=Browser(env);b.login(remember=remember);env[1].advance(1801)
    assert b.post('/api/auth/refresh').status_code==401
    assert b.c.get('/api/records').status_code==401

def test_background_session_checks_do_not_extend_idle(env):
    b=Browser(env);b.login();env[1].advance(890);assert b.c.get('/api/auth/session').status_code==200
    env[1].advance(900);assert b.post('/api/auth/refresh').status_code==200
    env[1].advance(11);assert b.c.get('/api/auth/session').status_code==401

def test_explicit_user_activity_extends_inactivity_not_absolute(env):
    b=Browser(env);r=b.login();absolute=r.json()['session']['absoluteExpiresAt'];env[1].advance(800)
    assert b.post('/api/auth/activity').status_code==200
    env[1].advance(801);r=b.post('/api/auth/refresh');assert r.status_code==200 and r.json()['session']['absoluteExpiresAt']==absolute
    assert r.json()['session']['idleExpiresAt']>env[1]()

@pytest.mark.parametrize('remember,limit',[(False,28800),(True,604800)])
def test_absolute_timeout_cannot_be_extended(env,remember,limit):
    b=Browser(env);b.login(remember=remember);env[1].advance(limit+1)
    with env[0].state.db.transaction() as db:db.execute('UPDATE sessions SET last_activity=?',(env[1](),))
    assert b.post('/api/auth/refresh').status_code==401

def test_tampered_access_signature_is_rejected(env):
    b=Browser(env);b.login();token=b.c.cookies.get(ACCESS)
    b.c.cookies.set(ACCESS,token[:-5]+'aaaaa',domain='127.0.0.1',path='/')
    assert b.c.get('/api/records').status_code==401

def test_logout_revokes_and_clears_without_deleting_records(env):
    b=Browser(env);b.login('coordinator@ayusetu.test');assert b.op('consent',['SCR-001','2.0','2026-09-28']).status_code==200
    old=TestClient(env[0],base_url=ORIGIN);old.cookies.update(b.c.cookies);csrf=b.csrf
    r=b.logout();assert r.status_code==200 and r.json()['signedOut']
    assert any('Max-Age=0' in c for c in r.headers.get_list('set-cookie'))
    assert old.get('/api/records').status_code==401
    assert old.post('/api/auth/refresh',json={},headers={'X-CSRF-Token':csrf}).status_code==401
    b.login('coordinator@ayusetu.test');assert any(c['participantId']=='SCR-001' for c in b.state()['consents'].values())

def test_coordinator_direct_id_and_scope_tampering(env):
    b=Browser(env);b.login('coordinator@ayusetu.test')
    assert b.c.get('/api/records/participants/AYU-001-S3-001').status_code==404
    assert b.c.get('/api/records?trialId=AYU-002').status_code==404
    assert b.c.get('/api/exports?trialId=AYU-001&siteId=S3').status_code==404
    assert b.c.get('/api/search?q=AYU-001-S3-001').json()['items']==[]
    assert b.op('consent',['AYU-001-S3-001','2.0','2026-09-28']).status_code==404
    assert b.post('/api/assistant',{'question':'Prepare a recruitment summary.','scope':{'siteId':'S3'}}).status_code==404

def test_browser_actor_fields_cannot_escalate(env):
    b=Browser(env);b.login('regulator@ayusetu.test')
    assert b.post('/api/operations',{'op':'settings','args':[24,7],'actor':'u-admin'}).status_code==422
    assert b.op('settings',[24,7]).status_code==403
    assert b.c.patch('/api/admin/accounts/u-regulator',json={'role':'Admin','reason':'impersonation'},headers={'X-CSRF-Token':b.csrf}).status_code==403
    assert b.c.get('/admin').status_code==403

@pytest.mark.parametrize('op,args',[('lifecycle',['AYU-001','Active Follow-up','reason']),('ethicsDecision',['DOC-AYU-001-2','Approved','reason','2027-01-01']),('pvReview',['AE-001','Reviewed','reason'])])
def test_administrator_cannot_make_clinical_decisions(env,op,args):
    b=Browser(env);b.login('admin@ayusetu.test');assert b.op(op,args).status_code==403

@pytest.mark.parametrize('op,args',[('screen',[{'trialId':'AYU-001','siteId':'S1'}]),('enroll',['SCR-001']),('visit',['VIS-AYU-001-S1-001-0','Completed','reason']),('pvReview',['AE-001','Reviewed','reason']),('document',[{'trialId':'AYU-001','family':'Protocol','title':'x','content':'x'}]),('reset',['RESET'])])
def test_regulator_rejects_clinical_writes(env,op,args):
    b=Browser(env);b.login('regulator@ayusetu.test');assert b.op(op,args).status_code==403

def test_extra_object_fields_cannot_bypass_clinical_gates(env):
    b=Browser(env);b.login()
    fields={'protocol':'AYU','protocolVersion':'2.0','registration':'Recorded (demo)','staffTrained':True,'eligibility':'text','endpoints':'text','iecStatus':'Approved'}
    assert b.op('configureTrial',['AYU-001',fields]).status_code==422
    assert b.post('/api/operations',{'op':'lifecycle','args':[],'state':{'users':{'role':'Admin'}}}).status_code==422

def test_enrollment_idempotency_linked_visits_audit_and_metrics(env):
    b=Browser(env);b.login('coordinator@ayusetu.test')
    r=b.op('enroll',['SCR-001']);assert r.status_code==422 and 'consent' in r.json()['fields']
    assert b.op('consent',['SCR-001','2.0','2026-09-28']).status_code==200
    r=b.op('enroll',['SCR-001']);assert r.status_code==200,r.text
    code=r.json()['result']['code'];assert b.op('enroll',['SCR-001']).json()['result']['code']==code
    state=b.state();assert len([v for v in state['visits'].values() if v['participantId']=='SCR-001'])==3
    assert len([p for p in state['participants'].values() if p['enrolledAt']])==49
    assert len([a for a in state['audit'].values() if a['operation']=='enroll'])==1
    assert all(a['actor']=='u-coord' and a['role']=='Coordinator' for a in state['audit'].values())
    pi=Browser(env);pi.login();state=pi.state();assert len([p for p in state['participants'].values() if p['enrolledAt']])==191
    answer=pi.post('/api/assistant',{'question':'Prepare a recruitment summary.'}).json();assert '191/400' in answer['summary']
    answer=b.post('/api/assistant',{'question':'Prepare a recruitment summary.'}).json();assert '49/70' in answer['summary']

SAFETY={'participantId':'AYU-001-S1-001','term':'Test event','description':'Synthetic preliminary safety report','onset':'2026-09-27','awareness':'2026-09-28','severity':'Moderate','serious':True,'criterion':'Hospitalization','outcome':'Unknown/pending follow-up','interventionAction':'Unknown/pending follow-up'}
def test_safety_capture_review_and_role_owned_task(env):
    b=Browser(env);b.login('coordinator@ayusetu.test')
    bad={**SAFETY,'criterion':''};assert b.op('safetyCreate',[bad]).status_code==422
    r=b.op('safetyCreate',[SAFETY]);assert r.status_code==200,r.text;cid=r.json()['result']['id'];assert cid=='AE-011'
    assert any(a['sourceId']==cid and a['priority']=='Urgent' and a['owner']=='u-pv' for a in b.state()['actions'].values())
    assert b.op('pvReview',[cid,'Reviewed','reporter cannot review']).status_code==403
    pv=Browser(env);pv.login('pv@ayusetu.test');r=pv.op('pvReview',[cid,'Follow-up Required','Please collect the outstanding outcome.']);assert r.status_code==200
    assert r.json()['result']['reviewer']=='u-pv'
    assert pv.op('prepareReport',[cid]).json()['result']['reportStatus']=='Prepared locally'

def test_regulator_narrative_redaction_and_audit_scope(env):
    b=Browser(env);b.login('coordinator@ayusetu.test');data={**SAFETY,'description':'PERSON-IDENTIFIER-NOT-FOR-REGULATOR','term':'PRIVATE-TERM'};assert b.op('safetyCreate',[data]).status_code==200
    r=Browser(env);r.login('regulator@ayusetu.test');response=r.c.get('/api/records');assert 'PERSON-IDENTIFIER-NOT-FOR-REGULATOR' not in response.text and 'PRIVATE-TERM' not in response.text
    exported=r.c.get('/api/exports?kind=Audit');assert 'PERSON-IDENTIFIER-NOT-FOR-REGULATOR' not in exported.text

def test_monitor_query_handoff(env):
    c=Browser(env);c.login('coordinator@ayusetu.test');q=next(iter(c.state()['queries'].values()))
    assert c.op('answerQuery',[q['id'],'Synthetic corrected observation','Source reviewed']).status_code==200
    assert c.op('verifyQuery',[q['id'],'reason']).status_code==403
    m=Browser(env);m.login('monitor@ayusetu.test');r=m.op('verifyQuery',[q['id'],'Source and response verified']);assert r.status_code==200 and r.json()['result']['status']=='Closed'

def test_site_activation_gates_and_target_unchanged(env):
    b=Browser(env);b.login();assert b.op('activateSite',['AYU-002-S2']).status_code==422
    for key in ('training','facilities'):assert b.op('readiness',['AYU-002-S2',key,'SYNTHETIC-EVIDENCE']).status_code==200
    assert b.op('activateSite',['AYU-002-S2']).status_code==200
    assert b.state()['trials']['AYU-002']['target']==120

def test_document_download_and_ethics_review(env):
    b=Browser(env);b.login();r=b.op('document',[{'trialId':'AYU-001','family':'Protocol','title':'Protocol amendment','content':'SYNTHETIC v3','fileName':'protocol.txt','size':12}]);assert r.status_code==200
    did=r.json()['result']['id'];assert b.op('ethicsDecision',[did,'Approved','reason','2027-01-01']).status_code==403
    e=Browser(env);e.login('ethics@ayusetu.test');r=e.op('ethicsDecision',[did,'Approved','Committee demo review recorded','2027-01-01']);assert r.status_code==200
    assert e.c.get('/api/documents/'+did+'/download').text=='SYNTHETIC v3'
    assert len(e.state()['documents'])>6

def test_scoped_export_content_and_actual_csv(env):
    b=Browser(env);b.login();r=b.c.get('/api/exports?kind=Recruitment&trialId=AYU-001&siteId=S1');assert r.status_code==200
    payload=r.json();assert len(payload['rows'])==60 and all(x['trial_id']=='AYU-001' and x['site_id']=='S1' for x in payload['rows'])
    r=b.c.get('/api/exports?kind=Recruitment&format=csv&trialId=AYU-001&siteId=S1');assert r.status_code==200 and 'attachment;' in r.headers['Content-Disposition'] and 'AYU-001-S1-001' in r.text and 'AYU-001-S3-001' not in r.text

def test_validated_edc_import_no_partial_commit(env):
    b=Browser(env);b.login('admin@ayusetu.test');valid={'id':'EDC-TEST-1','trialId':'AYU-001','siteId':'S1','status':'Screening'}
    bad={**valid,'id':'EDC-TEST-2','trialId':'INVALID'}
    assert b.op('validateImport',[[valid,bad]]).json()['result'][1]['valid'] is False
    assert b.op('commitImport',[[valid,bad]]).status_code==422
    assert 'EDC-TEST-1' not in b.state()['participants']
    assert b.op('commitImport',[[valid]]).status_code==200
    assert b.op('commitImport',[[valid]]).status_code==422

def test_neutral_recovery_and_outbox_only_token_delivery(env):
    b=Browser(env);known=b.post('/api/auth/forgot-password',{'email':'pi@ayusetu.test'});unknown=b.post('/api/auth/forgot-password',{'email':'nobody@ayusetu.test'})
    assert known.status_code==unknown.status_code==200 and known.json()==unknown.json()
    messages=b.c.get('/api/demo/outbox').json()['messages'];token=messages[0]['url'].split('#token=')[1]
    assert token not in known.text and 'token' not in known.json()
    assert Browser(env).c.get('/api/demo/outbox').json()['messages']==[]
    with env[0].state.db.connect() as db:
        recovery=db.execute('SELECT * FROM recovery').fetchall();assert recovery and all(row['digest']!=token for row in recovery)
        logs=json.dumps([dict(x) for x in db.execute('SELECT * FROM security_log')]);assert token not in logs

def test_reset_single_use_old_credentials_all_sessions_revoked(env):
    b=Browser(env);b.login();other=Browser(env);other.login();recovery=Browser(env);token=recovery.reset_token()
    r=recovery.post('/api/auth/reset-password',{'token':token,'newPassword':NEW,'confirmPassword':NEW});assert r.status_code==200
    assert b.c.get('/api/records').status_code==401 and other.c.get('/api/records').status_code==401
    assert Browser(env).login(password=PASSWORD).status_code==401
    assert Browser(env).login(password=NEW).status_code==200
    recovery.bootstrap();assert recovery.post('/api/auth/reset-password',{'token':token,'newPassword':NEW,'confirmPassword':NEW}).status_code==400

def test_reset_expired_token_and_mismatched_short_passwords(env):
    b=Browser(env);token=b.reset_token()
    assert b.post('/api/auth/reset-password',{'token':token,'newPassword':'short','confirmPassword':'short'}).status_code==422
    assert b.post('/api/auth/reset-password',{'token':token,'newPassword':NEW,'confirmPassword':NEW+'x'}).status_code==422
    env[1].advance(901);assert b.post('/api/auth/reset-password',{'token':token,'newPassword':NEW,'confirmPassword':NEW}).status_code==400

def test_password_passphrase_spaces_and_long_input_are_not_trimmed(env):
    b=Browser(env);token=b.reset_token();password='  '+('a meaningful passphrase ' * 5)+'  '
    assert len(password)>64
    assert b.post('/api/auth/reset-password',{'token':token,'newPassword':password,'confirmPassword':password}).status_code==200
    c=Browser(env);assert c.login(password=password.strip()).status_code==401
    assert c.login(password=password).status_code==200

def test_reset_preserves_otp_and_revokes_pending_challenges(env):
    pending=Browser(env);pending.login('pv@ayusetu.test',otp=False);code=pending.code()
    recovery=Browser(env);token=recovery.reset_token('pv@ayusetu.test');assert recovery.post('/api/auth/reset-password',{'token':token,'newPassword':NEW,'confirmPassword':NEW}).status_code==200
    assert pending.post('/api/auth/otp/verify',{'code':code}).status_code==401
    n=Browser(env);r=n.login('pv@ayusetu.test',password=NEW,otp=False);assert r.status_code==200 and r.json()['otpRequired']
    assert n.c.get('/api/records').status_code==401

def test_regulator_can_change_own_password_without_clinical_privileges(env):
    b=Browser(env);b.login('regulator@ayusetu.test')
    r=b.post('/api/auth/change-password',{'currentPassword':PASSWORD,'newPassword':NEW,'confirmPassword':NEW});assert r.status_code==200
    b.bootstrap();assert b.login('regulator@ayusetu.test',password=NEW).status_code==200
    assert b.op('enroll',['SCR-001']).status_code==403

def test_change_password_rejects_incorrect_current_and_role_field(env):
    b=Browser(env);b.login()
    assert b.post('/api/auth/change-password',{'currentPassword':'wrong','newPassword':NEW,'confirmPassword':NEW}).status_code==400
    r=b.post('/api/auth/change-password',{'currentPassword':PASSWORD,'newPassword':NEW,'confirmPassword':NEW,'role':'Admin'});assert r.status_code==422 and PASSWORD not in r.text

def test_admin_creates_account_setup_no_default_password(env):
    a=Browser(env);a.login('admin@ayusetu.test')
    r=a.post('/api/admin/accounts',{'email':'new@ayusetu.test','name':'New Staff','role':'Coordinator','assignments':[{'trialId':'AYU-001','siteIds':['S1']}]});assert r.status_code==200,r.text
    assert r.json()['account']['passwordSet'] is False
    n=Browser(env);assert n.login('new@ayusetu.test').status_code==401
    messages=a.c.get('/api/demo/outbox').json()['messages'];token=next(x['url'].split('#token=')[1] for x in messages if x['kind']=='setup')
    assert n.post('/api/auth/reset-password',{'token':token,'newPassword':NEW,'confirmPassword':NEW}).status_code==200
    n.bootstrap();assert n.login('new@ayusetu.test',password=NEW).status_code==200
    assert set(n.state()['sites'])=={'S1'}

def test_account_role_scope_and_deactivation_invalidate_existing_sessions(env):
    a=Browser(env);a.login('admin@ayusetu.test');c=Browser(env);c.login('coordinator@ayusetu.test')
    r=a.c.patch('/api/admin/accounts/u-coord',json={'assignments':[{'trialId':'AYU-001','siteIds':['S3']}],'reason':'Reassign for site monitoring'},headers={'X-CSRF-Token':a.csrf});assert r.status_code==200
    assert c.c.get('/api/records').status_code==401
    c.bootstrap();assert c.login('coordinator@ayusetu.test').status_code==200
    assert set(c.state()['sites'])=={'S3'}
    r=a.c.patch('/api/admin/accounts/u-coord',json={'active':False,'reason':'Deactivate demo account'},headers={'X-CSRF-Token':a.csrf});assert r.status_code==200
    assert c.c.get('/api/records').status_code==401 and c.login('coordinator@ayusetu.test').status_code==401

def test_cannot_remove_last_active_admin(env):
    a=Browser(env);a.login('admin@ayusetu.test');r=a.c.patch('/api/admin/accounts/u-admin',json={'active':False,'reason':'Test'},headers={'X-CSRF-Token':a.csrf});assert r.status_code==409

def test_scope_change_rejects_invalid_reference_without_partial_update(env):
    a=Browser(env);a.login('admin@ayusetu.test')
    r=a.c.patch('/api/admin/accounts/u-coord',json={'role':'PI','assignments':[{'trialId':'MISSING','siteIds':['S1']}],'reason':'invalid request'},headers={'X-CSRF-Token':a.csrf});assert r.status_code==422
    assert Browser(env).login('coordinator@ayusetu.test').json()['user']['role']=='Coordinator'

@pytest.mark.parametrize('next_value,expected',[('/monitoring','/monitoring'),('https://attacker.test','/overview'),('//attacker.test','/overview'),('/admin','/overview'),('/%2f%2fattacker.test','/overview')])
def test_requested_destination_exact_internal_allowlist(env,next_value,expected):
    assert Browser(env).login(next=next_value).json()['destination']==expected

def test_demo_reset_preserves_passwords_accounts_assignments_and_logs(env):
    a=Browser(env);a.login('admin@ayusetu.test')
    c=Browser(env);c.login('coordinator@ayusetu.test');c.op('consent',['SCR-001','2.0','2026-09-28']);c.op('enroll',['SCR-001'])
    with env[0].state.db.connect() as db:
        before_users=[dict(r) for r in db.execute('SELECT * FROM users')];before_security=db.execute('SELECT COUNT(*) FROM security_log').fetchone()[0];audit_count=len(json.loads(db.execute('SELECT body FROM clinical_state').fetchone()[0])['audit'])
    assert a.op('reset',['not confirmation']).status_code==422
    assert a.op('reset',['RESET']).status_code==200
    state=a.state();assert len([p for p in state['participants'].values() if p['enrolledAt']])==190 and len(state['audit'])>audit_count
    with env[0].state.db.connect() as db:
        assert [dict(r) for r in db.execute('SELECT * FROM users')]==before_users
        assert db.execute('SELECT COUNT(*) FROM security_log').fetchone()[0]>before_security
    assert c.c.get('/api/records').status_code==200

def test_restart_never_reseeds_changes_or_resets_password(env):
    b=Browser(env);token=b.reset_token();b.post('/api/auth/reset-password',{'token':token,'newPassword':NEW,'confirmPassword':NEW})
    c=Browser(env);c.login('coordinator@ayusetu.test');c.op('consent',['SCR-001','2.0','2026-09-28']);c.op('enroll',['SCR-001'])
    with env[0].state.db.transaction() as db:db.execute("UPDATE users SET active=0 WHERE id='u-monitor'")
    app2=create_app(env[2],clock=env[1]);b2=Browser((app2,env[1],env[2]));assert b2.login(password=NEW).status_code==200
    assert len([p for p in b2.state()['participants'].values() if p['enrolledAt']])==191
    assert Browser((app2,env[1],env[2])).login('monitor@ayusetu.test').status_code==401

def test_no_demo_accounts_or_outbox_outside_demo_config(env,tmp_path):
    cfg=copy.copy(env[2]);cfg.demo_mode=False;cfg.isolated_synthetic=False;cfg.database=str(tmp_path/'non-demo.sqlite3')
    app=create_app(cfg,clock=env[1]);b=Browser((app,env[1],cfg))
    assert b.c.get('/api/demo/accounts').status_code==404 and b.c.get('/api/demo/outbox').status_code==404
    assert not b.bootstrap().json()['demoMode']
    assert b.login().status_code==401

def test_demo_database_cannot_be_reused_in_non_demo_mode(env):
    cfg=copy.copy(env[2]);cfg.demo_mode=False;cfg.isolated_synthetic=False
    with pytest.raises(RuntimeError,match='seeded demo database'):create_app(cfg,clock=env[1])

def test_demo_config_requires_explicit_isolation(env):
    cfg=copy.copy(env[2]);cfg.isolated_synthetic=False
    with pytest.raises(RuntimeError):create_app(cfg)

def test_security_log_is_restricted_append_only_and_secret_free(env):
    b=Browser(env);b.login('pv@ayusetu.test',otp=False);code=b.code();b.post('/api/auth/otp/verify',{'code':code})
    assert b.c.get('/api/admin/security-log').status_code==403
    with env[0].state.db.connect() as db:
        logs=json.dumps([dict(r) for r in db.execute('SELECT * FROM security_log')]);assert PASSWORD not in logs and code not in logs
        for row in db.execute('SELECT * FROM sessions'):
            assert row['access_digest']!=b.c.cookies.get(ACCESS) and row['refresh_digest']!=b.c.cookies.get(REFRESH)
        with pytest.raises(Exception):db.execute('DELETE FROM security_log')


@pytest.mark.parametrize('origin', ['http://127.0.0.1:5173@evil.example','http://example.com:5173','http://localhost:5173/path','https://example.com/?x=1','https://user:secret@example.com','http://localhost:no-port'])
def test_origin_configuration_rejects_ambiguous_or_insecure_values(origin):
    from server.config import Settings
    with pytest.raises(RuntimeError):
        Settings(secret='test-only-key-'*4, origin=origin, cookie_secure=True).validate()


def test_password_upper_boundary_rejects_without_truncation(env):
    b=Browser(env);b.login()
    too_long='P'*1025
    response=b.post('/api/auth/change-password',{'currentPassword':PASSWORD,'newPassword':too_long,'confirmPassword':too_long})
    assert response.status_code==422
    with env[0].state.db.connect() as db:
        assert env[0].state.security.hasher.verify(db.execute("SELECT password_hash FROM users WHERE id='u-pi'").fetchone()[0],PASSWORD)
    valid='P'*1024
    response=b.post('/api/auth/change-password',{'currentPassword':PASSWORD,'newPassword':valid,'confirmPassword':valid})
    assert response.status_code==200
    c=Browser(env);assert c.login(password=valid).status_code==200
