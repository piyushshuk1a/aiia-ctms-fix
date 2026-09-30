"""Browser rendering and interaction against the real HTTP backend.

The supplied Chromium has managed URLBlocklist=['*']; even localhost/navigation
interception fails before any request fires. This harness therefore mounts the
compiled UI into about:blank. A test-only fetch bridge forwards requests to a
real uvicorn/FastAPI server through httpx, with one server-cookie jar per context.
Only browser transport and location/history are adapted, not authentication,
permissions, data, or domain operations. This does not test native browser cookie
handling, CSP enforcement, origin navigation, or true back/forward cache behavior.
"""
import csv, json, os, re, secrets, shutil, subprocess, sys, tempfile, time, traceback
from pathlib import Path
import httpx
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'test-results';OUT.mkdir(exist_ok=True)
ORIGIN='http://127.0.0.1:5178'
PASSWORD='AyuSetu-Demo-2026!'
NATIVE='--native' in sys.argv
checks=[];errors=[];api_calls=[];network_fault={'enabled':False};result={'mode':'native_browser' if NATIVE else 'real_http_backend_with_browser_transport_and_router_adapter'}
def checked(name):checks.append(name);print('PASS',name,flush=True)

SHIM=r'''
window.__router = {pathname:'/login',search:'',hash:''};
function setRoute(url){const u=new URL(url,'http://127.0.0.1:5178');window.__router={pathname:u.pathname,search:u.search,hash:u.hash};}
history.pushState = function(_a,_b,url){if(url)setRoute(url);};
history.replaceState = function(_a,_b,url){if(url)setRoute(url);};
window.fetch=async function(input,opts={}){
 if(opts.signal?.aborted)throw new DOMException('Aborted','AbortError');
 const r=await window.__backend({path:String(input),method:opts.method||'GET',headers:opts.headers||{},body:opts.body||null});
 if(opts.signal?.aborted)throw new DOMException('Aborted','AbortError');
 return new Response(r.body,{status:r.status,headers:r.headers});
};
document.addEventListener('click',e=>{const a=e.target.closest('a');if(a?.href?.startsWith('http://127.0.0.1:5178/')){e.preventDefault();setRoute(a.href);window.dispatchEvent(new PopStateEvent('popstate'));}});
'''

def html(route='/login'):
    code=(ROOT/'build/app.js').read_text()
    for piece in ('pathname','search','hash'):code=code.replace('location.'+piece,'window.__router.'+piece)
    shim=SHIM+f'\nsetRoute({json.dumps(route)});'
    parts=['<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>',(ROOT/'src/styles.css').read_text(),'</style></head><body><div id="root"></div>']
    for data in [(ROOT/'vendor/react.min.js').read_text(),(ROOT/'vendor/react-dom.min.js').read_text(),(ROOT/'src/bootstrap.js').read_text(),shim,code]:parts.extend(['<script>',data.replace('</script','<\\/script'),'</script>'])
    parts.append('</body></html>');return ''.join(parts)

with tempfile.TemporaryDirectory(prefix='ayusetu-browser-') as runtime:
 env=os.environ.copy();env.update({'APP_ORIGIN':ORIGIN,'DATABASE_PATH':str(Path(runtime)/'browser.sqlite3'),'AUTH_SECRET':secrets.token_urlsafe(48),'DEMO_MODE':'true','ISOLATED_SYNTHETIC':'true','COOKIE_SECURE':'false','BIND_HOST':'127.0.0.1'})
 logfile=open(OUT/'browser-server.log','w');proc=subprocess.Popen(['python','-m','server.run'],cwd=ROOT,env=env,stdout=logfile,stderr=logfile)
 try:
  for _ in range(70):
   try:
    if httpx.get(ORIGIN+'/health',timeout=.5).status_code==200:break
   except Exception:pass
   time.sleep(.1)
  else:raise RuntimeError('Test HTTP server did not start.')
  backend=httpx.Client(base_url=ORIGIN,timeout=20,follow_redirects=False)
  with sync_playwright() as pw:
   browser=pw.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH') or shutil.which('chromium') or None,headless=True,args=['--no-sandbox'])
   context=browser.new_context(viewport={'width':1440,'height':1080},accept_downloads=True)
   def bridge(source,payload):
    path=payload['path']
    if path.startswith(ORIGIN):path=path[len(ORIGIN):]
    assert path.startswith('/api/'),path
    if network_fault['enabled'] and path=='/api/auth/login':raise RuntimeError('Test-injected transport failure')
    headers=payload.get('headers') or {};headers['Origin']=ORIGIN
    response=backend.request(payload['method'],path,headers=headers,content=payload.get('body'))
    api_calls.append({'path':path,'method':payload['method'],'status':response.status_code})
    return {'status':response.status_code,'body':response.text,'headers':dict(response.headers)}
   if not NATIVE:context.expose_binding('__backend',bridge)
   def direct(method,path,**kwargs):
    if NATIVE:
     backend.cookies.clear()
     for cookie in context.cookies():backend.cookies.set(cookie['name'],cookie['value'],domain=cookie['domain'],path=cookie['path'])
    return backend.request(method,path,**kwargs)
   def server_get(path,**kwargs):return direct('GET',path,**kwargs)
   def server_post(path,**kwargs):return direct('POST',path,**kwargs)
   page=context.new_page();page.set_default_timeout(6000);page.on('pageerror',lambda e:errors.append(str(e)))
   def mount(route='/login'):
    if NATIVE:page.goto(ORIGIN+route,wait_until='load')
    else:page.set_content(html(route),wait_until='load')
    page.wait_for_function('!!AyuAuth.authService.config')
   def login(local,otp=True,password=PASSWORD):
    page.get_by_label('Email address',exact=True).fill(local+'@ayusetu.test');page.get_by_label('Password',exact=True).fill(password)
    page.get_by_role('button',name='Sign in',exact=True).click()
    if local in ('admin','pv') and otp:
     expect(page.get_by_role('heading',name='Verify your sign-in',exact=True)).to_be_visible()
     page.get_by_role('button',name='Open isolated demo outbox',exact=True).click()
     code=page.locator('.outbox-code').inner_text().strip();page.get_by_label('Six-digit verification code',exact=True).fill(code)
     page.get_by_role('button',name='Verify & continue',exact=True).click()
    if otp or local not in ('admin','pv'):expect(page.locator('.signed-profile')).to_be_visible()
   def logout():
    page.get_by_label('Signed-in profile',exact=True).click();page.get_by_role('button',name='Sign out',exact=True).click()
    expect(page.get_by_role('heading',name='Welcome back',exact=True)).to_be_visible();page.wait_for_function('!!AyuAuth.authService.config && !!AyuAuth.authService.csrf')
   def nav(name):
    if page.viewport_size['width']<981:page.get_by_role('button',name='Open navigation',exact=True).click()
    page.locator('.sidebar').get_by_role('button',name=name,exact=True).click()
   def open_record(q):
    page.get_by_label('Search permitted records',exact=True).fill(q);page.locator('.search-results button').first.click()
   def close():page.get_by_role('button',name='Close dialog',exact=True).click()
   def state():return server_get('/api/records').json()['state']
   try:
    mount();expect(page.get_by_role('heading',name='Welcome back',exact=True)).to_be_visible()
    assert page.locator('.sidebar').count()==0
    assert server_get('/api/records').status_code==401
    page.screenshot(path=str(OUT/'login-desktop.png'),full_page=True)
    checked('Login-first desktop renders with no protected data before verification')
    if not NATIVE:
     network_fault['enabled']=True
     page.get_by_label('Email address',exact=True).fill('pi@ayusetu.test');page.get_by_label('Password',exact=True).fill(PASSWORD)
     page.get_by_role('button',name='Sign in',exact=True).click();expect(page.get_by_role('alert')).to_contain_text('Connection unavailable')
     assert page.locator('.sidebar').count()==0 and server_get('/api/records').status_code==401
     network_fault['enabled']=False
     checked('Injected network failure is distinct from invalid credentials and never reports successful login')

    page.get_by_label('Email address',exact=True).fill('pi@ayusetu.test');page.get_by_label('Password',exact=True).fill('incorrect-password')
    page.get_by_role('button',name='Show password',exact=True).click();assert page.get_by_label('Password',exact=True).get_attribute('type')=='text'
    page.get_by_role('button',name='Sign in',exact=True).click();expect(page.get_by_role('alert')).to_contain_text('Sign-in failed')
    assert page.locator('.sidebar').count()==0
    checked('Show-password control and generic failed login do not grant access')
    page.get_by_role('button',name='Hide password',exact=True).click();login('pi')
    expect(page.get_by_role('heading',name='Portfolio overview',exact=True)).to_be_visible()
    assert page.get_by_label('Demo role switching',exact=True).count()==0
    assert len([p for p in state()['participants'].values() if p['enrolledAt']])==190
    page.screenshot(path=str(OUT/'pi-authenticated.png'),full_page=True)
    checked('PI login opens Overview and preserves the 190/400 baseline without a role selector')
    open_record('Varanasi');expect(page.get_by_role('dialog')).to_contain_text('60.3');close()
    checked('Existing source-linked Varanasi operational-risk drawer remains functional')
    logout();login('coordinator');expect(page.get_by_role('heading',name='Participants & Visits',exact=True)).to_be_visible()
    assert set(x['siteId'] for x in state()['participants'].values())=={'S1'}
    checked('Coordinator lands on Participants & Visits with AYU-001 Delhi-only records')
    open_record('SCR-001');page.get_by_role('button',name='Enroll participant',exact=True).click()
    expect(page.get_by_test_id('consent-gate')).to_be_visible()
    page.get_by_role('button',name='Record consent',exact=True).click();page.get_by_role('checkbox').check();page.get_by_role('button',name='Save consent record',exact=True).click()
    expect(page.get_by_role('button',name='Enroll participant',exact=True)).to_be_visible();page.get_by_role('button',name='Enroll participant',exact=True).click()
    expect(page.get_by_role('dialog')).to_contain_text('3 linked protocol visits');assert state()['participants']['SCR-001']['enrolledAt']
    checked('Consent gate, recorded consent, enrollment, three visits and server audit work through UI')
    close();nav('Overview');expect(page.locator('.stat-number').first).to_contain_text('49');expect(page.locator('.stat-number').first).to_contain_text('70')
    page.screenshot(path=str(OUT/'coordinator-scoped.png'),full_page=True)
    # Remount compiled UI, preserving the real HTTP client's session-cookie jar.
    page.reload(wait_until='load');mount('/overview');expect(page.get_by_role('heading',name='Your site workspace',exact=True)).to_be_visible()
    expect(page.locator('.stat-number').first).to_contain_text('49')
    checked('UI remount restores server identity and the persisted enrollment through the session endpoint')
    open_record('AYU-001-S1-001');page.get_by_role('button',name='Report an adverse event',exact=True).click()
    page.get_by_label('Uncoded demo event term',exact=False).fill('Synthetic dizziness')
    page.get_by_label('Event description',exact=False).fill('Synthetic event for testing. Details pending follow-up; no causality inferred.')
    page.locator('select[name=severity]').select_option('Mild');page.locator('select[name=serious]').select_option('yes')
    page.get_by_role('button',name='Submit safety report',exact=True).click();expect(page.get_by_role('alert')).to_contain_text('criterion')
    page.get_by_label('Recorded seriousness criterion',exact=False).select_option('Hospitalization (recorded demo criterion)')
    page.get_by_role('button',name='Submit safety report',exact=True).click()
    expect(page.get_by_role('heading',name='AE-011 · Synthetic dizziness',exact=True)).to_be_visible()
    assert state()['actions']['ACT-safety-AE-011']['priority']=='Urgent'
    close();checked('Seriousness criterion is mandatory; UI safety capture creates the urgent PV action')
    q=next(q for q in state()['queries'].values() if q['status']=='Open')
    nav('Monitoring');page.get_by_role('button',name=q['id'],exact=True).click()
    page.get_by_label('Corrected source observation',exact=False).fill('Synthetic source observation reconciled.')
    page.get_by_label('Response rationale',exact=False).fill('Reviewed the original synthetic visit record.')
    page.get_by_role('button',name='Submit query response',exact=True).click();expect(page.get_by_role('dialog')).to_contain_text('Answered');close()
    logout();login('monitor');expect(page.get_by_role('heading',name='Monitoring',exact=True)).to_be_visible()
    page.get_by_role('button',name=q['id'],exact=True).click();page.get_by_label('Verification rationale',exact=False).fill('Verified response against synthetic source.')
    page.get_by_role('button',name='Verify & close query',exact=True).click();expect(page.get_by_role('dialog')).to_have_count(0)
    assert state()['queries'][q['id']]['status']=='Closed'
    checked('Monitor landing and coordinator-to-monitor query handoff preserve independent review')
    logout();login('pv',otp=False)
    expect(page.get_by_role('heading',name='Verify your sign-in',exact=True)).to_be_visible()
    assert server_get('/api/records').status_code==401 and page.locator('.sidebar').count()==0
    page.get_by_role('button',name='Open isolated demo outbox',exact=True).click()
    code=page.locator('.outbox-code').inner_text().strip();bad='000000' if code!='000000' else '000001'
    page.get_by_label('Six-digit verification code',exact=True).fill(bad);page.get_by_role('button',name='Verify & continue',exact=True).click()
    expect(page.get_by_role('alert')).to_be_visible();assert server_get('/api/records').status_code==401
    page.screenshot(path=str(OUT/'otp-challenge.png'),full_page=True)
    page.get_by_label('Six-digit verification code',exact=True).fill(code);page.get_by_role('button',name='Verify & continue',exact=True).click()
    expect(page.get_by_role('heading',name='Safety',exact=True)).to_be_visible()
    checked('PV password verification creates only a limited challenge; wrong OTP cannot load clinical records')
    open_record('AE-011');page.get_by_label('Review transition',exact=True).select_option('Follow-up Required')
    page.get_by_label('Review rationale / follow-up request',exact=False).fill('Please provide a synthetic de-identified discharge summary and clarify outcome.')
    page.get_by_role('button',name='Record PV decision',exact=True).click();expect(page.get_by_role('dialog')).to_contain_text('Follow-up Required')
    assert state()['safety']['AE-011']['reviewer']=='u-pv';close()
    checked('OTP-verified PV account completes its authorized clinical review with authenticated audit identity')
    logout();login('ethics');expect(page.get_by_role('heading',name='Compliance tracking',exact=True)).to_be_visible()
    page.get_by_role('tab',name=re.compile('^Document versions')).click()
    page.locator('tbody tr').filter(has_text='DOC-RENEWAL').get_by_role('button',name='Open version',exact=True).click()
    page.get_by_label('Committee rationale',exact=True).fill('Synthetic committee review; approval evidence and prior versions retained.')
    page.get_by_role('button',name='Record committee decision',exact=True).click();expect(page.get_by_role('dialog')).to_contain_text('Approved')
    with page.expect_download() as d:page.get_by_role('button',name='Download synthetic text',exact=True).click()
    assert d.value.suggested_filename.endswith('.txt');d.value.save_as(str(OUT/'browser-document.txt'))
    assert state()['documents']['DOC-RENEWAL']['comments'];close()
    checked('Ethics landing, committee decision history, and server-authorized document download work in UI')
    logout();login('pi');nav('Sites');page.get_by_role('tab',name=re.compile('^Trial-site associations')).click()
    page.locator('tbody tr').filter(has_text='AYU-002').filter(has_text='Jaipur').get_by_role('button').first.click()
    page.get_by_role('button',name='Activate site',exact=True).click();expect(page.get_by_role('alert')).to_contain_text('training')
    for key in ['training','facilities']:
     page.get_by_label(key+' evidence reference',exact=True).fill('DEMO-'+key+'-evidence')
     page.get_by_label(key+' evidence reference',exact=True).locator('..').get_by_role('button',name='Record evidence',exact=True).click()
     expect(page.get_by_label(key+' evidence reference',exact=True)).to_have_count(0)
    page.get_by_role('button',name='Activate site',exact=True).click();expect(page.get_by_role('dialog')).to_contain_text('Active')
    assert state()['trialSites']['AYU-002-S2']['status']=='Active';close()
    checked('Site readiness gates, evidence recording, and gated activation remain intact')
    page.get_by_role('button',name='Ask assistant',exact=True).click();page.get_by_role('button',name='Prepare a recruitment summary.',exact=True).click()
    expect(page.locator('.assistant-answer')).to_contain_text('191/400')
    page.get_by_role('button',name='Which sites need attention, and why?',exact=True).click();expect(page.locator('.assistant-sources')).to_contain_text('AYU-001-S3')
    close();checked('Server-authorized assistant reflects 191/400 and links current supporting records')
    logout();login('regulator');expect(page.get_by_role('heading',name='Reports',exact=True)).to_be_visible()
    page.get_by_label('Report type',exact=True).select_option('Audit')
    expect(page.locator('.audit-list')).to_contain_text('safetyCreate')
    with page.expect_download() as d:page.get_by_role('button',name='Export JSON',exact=True).click()
    d.value.save_as(str(OUT/'browser-audit-export.json'))
    exported=json.loads((OUT/'browser-audit-export.json').read_text());assert exported['recordCount']>0
    denial=server_post('/api/operations',json={'op':'enroll','args':['SCR-001']},headers={'Origin':ORIGIN,'X-CSRF-Token':page.evaluate('AyuAuth.authService.csrf')})
    assert denial.status_code==403
    page.get_by_label('Trial filter',exact=True).select_option('AYU-001');page.get_by_label('Site filter',exact=True).select_option('S3');page.get_by_label('Report type',exact=True).select_option('Recruitment')
    with page.expect_download() as d:page.get_by_role('button',name='Export CSV',exact=True).click()
    d.value.save_as(str(OUT/'browser-scoped-recruitment.csv'))
    rows=list(csv.DictReader((OUT/'browser-scoped-recruitment.csv').open()));assert len(rows)==18 and all(r['site_id']=='S3' for r in rows)
    checked('Regulator lands on Reports; de-identified audit and scoped CSV download work while direct writes return 403')
    # Ordinary profile changes do not expose a role control.
    page.get_by_label('Signed-in profile',exact=True).click();page.get_by_role('button',name='Profile / Security',exact=True).click()
    expect(page.get_by_role('heading',name='Change your password',exact=True)).to_be_visible();assert page.get_by_label('Assigned role',exact=True).count()==0
    newpw='Long regulator browser passphrase 2026!'
    page.get_by_label('Current password',exact=True).fill(PASSWORD);page.get_by_label('New password',exact=True).fill(newpw);page.get_by_label('Confirm new password',exact=True).fill(newpw)
    page.get_by_role('button',name='Change password & sign out',exact=True).click();expect(page.get_by_role('heading',name='Welcome back',exact=True)).to_be_visible()
    assert server_get('/api/records').status_code==401
    page.wait_for_function('!!AyuAuth.authService.csrf');login('regulator',password=newpw);logout()
    checked('Regulator can change their own password without privilege controls; sessions revoke and new login works')
    # Full password-recovery UI with the explicitly isolated mock delivery channel.
    page.get_by_role('button',name='Forgot password?',exact=True).click();expect(page.get_by_role('heading',name='Reset your password',exact=True)).to_be_visible()
    page.get_by_label('Email address',exact=True).fill('regulator@ayusetu.test');page.get_by_role('button',name='Send recovery instructions',exact=True).click()
    expect(page.get_by_role('status')).to_contain_text('If an eligible account exists')
    page.get_by_role('button',name='Open isolated demo outbox',exact=True).click();page.locator('.outbox-view a').last.click()
    expect(page.get_by_role('heading',name='Choose a new password',exact=True)).to_be_visible()
    page.get_by_label('New password',exact=True).fill('x'*1025);page.get_by_label('Confirm new password',exact=True).fill('x'*1025)
    assert len(page.get_by_label('New password',exact=True).input_value())==1025
    page.get_by_role('button',name='Save new password',exact=True).click();expect(page.get_by_role('alert')).to_contain_text('1,024')
    checked('Overlong pasted passwords remain intact in the input and are rejected explicitly, never silently truncated')
    page.get_by_label('New password',exact=True).fill(PASSWORD);page.get_by_label('Confirm new password',exact=True).fill('this mismatch must fail')
    page.get_by_role('button',name='Save new password',exact=True).click();expect(page.get_by_role('alert')).to_contain_text('do not match')
    page.get_by_label('Confirm new password',exact=True).fill(PASSWORD);page.get_by_role('button',name='Save new password',exact=True).click()
    expect(page.get_by_role('status')).to_contain_text('Password updated')
    page.get_by_role('button',name='Back to sign in',exact=False).click();login('regulator');logout()
    checked('Forgot/reset screens use a single-use delivered link, enforce matching passwords, and require normal login')
    login('admin');expect(page.get_by_role('heading',name='Administration',exact=True)).to_be_visible()
    page.get_by_role('tab',name='Accounts & access',exact=True).click()
    page.get_by_role('button',name='Create account',exact=True).click()
    page.get_by_label('Staff name',exact=True).fill('Synthetic Browser Reviewer');page.get_by_label('Account email',exact=True).fill('browser-new@ayusetu.test')
    page.get_by_label('Assigned role',exact=True).select_option('Coordinator')
    page.locator('.assignment-options > div').first.get_by_label('Delhi',exact=True).check()
    page.get_by_role('button',name='Create & send setup link',exact=True).click()
    expect(page.locator('tbody tr').filter(has_text='browser-new@ayusetu.test')).to_contain_text('Setup pending')
    page.get_by_role('button',name='Open isolated demo outbox',exact=True).click();page.locator('.outbox-view a').last.click()
    expect(page.get_by_role('heading',name='Choose a new password',exact=True)).to_be_visible()
    page.get_by_label('New password',exact=True).fill('Browser newly setup passphrase 2026!');page.get_by_label('Confirm new password',exact=True).fill('Browser newly setup passphrase 2026!')
    page.get_by_role('button',name='Save new password',exact=True).click();expect(page.get_by_role('status')).to_contain_text('Password updated')
    page.get_by_role('button',name='Back to sign in',exact=False).click();login('browser-new',password='Browser newly setup passphrase 2026!')
    expect(page.get_by_role('heading',name='Participants & Visits',exact=True)).to_be_visible()
    assert {x['siteId'] for x in state()['participants'].values()}=={'S1'};logout()
    checked('OTP-verified Admin creates scoped account; setup link sets a password without a default or public signup')
    login('admin');page.get_by_role('tab',name='Accounts & access',exact=True).click()
    row=page.locator('tbody tr').filter(has_text='browser-new@ayusetu.test');row.get_by_role('button',name='Edit access',exact=True).click()
    page.get_by_label('Account active',exact=False).uncheck();page.get_by_label('Access-change reason',exact=True).fill('Deactivate synthetic browser test account.')
    page.get_by_role('button',name='Save access changes',exact=True).click();expect(row).to_contain_text('Disabled')
    page.get_by_role('button',name='Review restricted security log',exact=True).click();expect(page.get_by_role('heading',name='Restricted security history',exact=True)).to_be_visible()
    page.screenshot(path=str(OUT/'admin-accounts.png'),full_page=True)
    checked('Administrative account status changes and restricted security history render and persist')
    names=['Overview','Trials','Sites','Participants & Visits','Safety','Monitoring','Compliance & Documents','Intelligence','Action Center','Reports','Administration']
    for name in names:
     nav(name);assert page.get_by_role('heading',level=1).count()==1
     assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),name+' overflows desktop'
    checked('All eleven clinical and administration destinations render without desktop page overflow')
    page.get_by_role('tab',name='Workspace settings',exact=True).click();page.get_by_role('button',name='Reset demo',exact=True).click()
    page.get_by_label('Type RESET to confirm',exact=True).fill('wrong');page.get_by_role('button',name='Confirm reset',exact=True).click();expect(page.get_by_role('alert')).to_contain_text('Type RESET')
    page.get_by_label('Type RESET to confirm',exact=True).fill('RESET');page.get_by_role('button',name='Confirm reset',exact=True).click();expect(page.get_by_role('dialog')).to_have_count(0)
    assert len([p for p in state()['participants'].values() if p['enrolledAt']])==190 and len(state()['audit'])>0
    checked('Admin reset requires confirmation and restores clinical baseline without erasing audit or account changes')
    page.set_viewport_size({'width':390,'height':844})
    for name in names:
     nav(name);assert page.get_by_role('heading',level=1).count()==1
     assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),name+' overflows mobile'
    nav('Overview');page.screenshot(path=str(OUT/'authenticated-mobile.png'),full_page=True)
    checked('All eleven destinations fit a 390px mobile viewport with contained table scrolling')
    page.get_by_role('button',name='Ask assistant',exact=True).click()
    for _ in range(12):
     page.keyboard.press('Tab');assert page.evaluate("!!document.activeElement.closest('[role=dialog]')")
    page.keyboard.press('Escape');expect(page.get_by_role('dialog')).to_have_count(0)
    checked('Mobile assistant dialog traps keyboard focus and Escape dismisses it')
    logout();page.screenshot(path=str(OUT/'login-mobile.png'),full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    login('coordinator');assert page.locator('.assistant-answer').count()==0 and page.locator('.outbox-view').count()==0
    assert 'browser-new@ayusetu.test' not in page.locator('body').inner_text()
    checked('Logout removes prior-user UI and assistant history before another scoped account signs in on mobile')
    denied=page.evaluate("""async()=>{const user=AyuAuth.authService.current.user,old=user.role;user.role='Admin';const r=await fetch('/api/admin/accounts');user.role=old;return r.status;}""")
    assert denied==403
    checked('Editing the browser user role does not grant backend administrative access')

    logout();assert not errors,errors
    checked('Browser-driven journey completes without JavaScript page errors')
    result.update({'status':'passed','passed':len(checks),'checks':checks,'errors':errors,'apiCalls':api_calls})
   except Exception as exc:
    traceback.print_exc();result.update({'status':'failed','error':str(exc),'checks':checks,'errors':errors,'apiCalls':api_calls});page.screenshot(path=str(OUT/'browser-failure.png'),full_page=True)
   finally:
    browser.close()
  (OUT/'browser-auth-results.json').write_text(json.dumps(result,indent=2))
 finally:
  proc.terminate();proc.wait(timeout=10);logfile.close()
if result.get('status')!='passed':raise SystemExit(1)
