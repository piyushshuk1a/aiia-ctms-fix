"""Authentication architecture: Starlette authentication + itsdangerous signed opaque
credentials, argon2-cffi Argon2id, and revocable SQLite sessions (no JWTs).
Application-specific policy lives here, not in React components.
"""
from __future__ import annotations
import hashlib, hmac, json, secrets, time, re, smtplib, threading
from email.message import EmailMessage
from datetime import datetime, timezone
from typing import Any
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, InvalidHashError
from itsdangerous import URLSafeSerializer, BadSignature
from starlette.authentication import AuthenticationBackend, AuthCredentials, BaseUser
from .config import Settings
from .database import Database

ROLES = ('PI', 'Coordinator', 'Monitor', 'Ethics', 'PV', 'Admin', 'Regulator')
HOME = {'PI':'overview','Coordinator':'participants','Monitor':'monitoring','Ethics':'compliance','PV':'safety','Admin':'admin','Regulator':'reports'}
PAGES = ('overview','trials','sites','participants','safety','monitoring','compliance','intelligence','actions','reports','admin','profile')
ACCESS = 'ayusetu_access'
REFRESH = 'ayusetu_refresh'
CSRF = 'ayusetu_csrf'
PREAUTH = 'ayusetu_challenge'
OUTBOX = 'ayusetu_outbox'

class AppError(Exception):
    def __init__(self, status: int, message: str, *, code='request_failed', fields=None, headers=None, persist=True):
        self.status, self.message, self.code = status, message, code
        self.fields, self.headers, self.persist = fields or {}, headers or {}, persist

class Identity(BaseUser):
    def __init__(self, account: dict, session: dict):
        self.account, self.session = account, session
    @property
    def is_authenticated(self): return True
    @property
    def display_name(self): return self.account['name']
    @property
    def identity(self): return self.account['id']

class SessionBackend(AuthenticationBackend):
    def __init__(self, security): self.security = security
    async def authenticate(self, conn):
        # The read is short and indexed; mutations/password hashing execute in FastAPI's threadpool.
        found = self.security.lookup(conn.cookies.get(ACCESS, ''))
        if found:
            account, session = found
            return AuthCredentials(['authenticated', account['role']]), Identity(account, session)
        return None

def normalize_email(value: str) -> str:
    value = value.strip().casefold()
    if len(value) > 254 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', value):
        raise AppError(422, 'Enter a valid email address.', fields={'email':'Enter a valid email address.'})
    return value

def check_password(value: str, confirmation: str):
    # Deliberately do NOT strip, normalize, truncate, or impose composition rules.
    if value != confirmation:
        raise AppError(422, 'The passwords do not match.', fields={'confirmPassword':'The passwords do not match.'})
    if not 15 <= len(value) <= 1024:
        raise AppError(422, 'Use 15–1,024 characters. Spaces and passphrases are supported.', fields={'newPassword':'Use 15–1,024 characters.'})

class Security:
    def __init__(self, settings: Settings, database: Database, clock=None):
        self.cfg, self.db = settings, database
        self.clock = clock or time.time
        self.hasher = PasswordHasher()  # Argon2id RFC 9106 low-memory profile; library defaults.
        self.dummy_hash = self.hasher.hash(secrets.token_urlsafe(40))
        self.signers = {kind: URLSafeSerializer(settings.secret, salt='ayusetu.' + kind + '.v2', signer_kwargs={'digest_method': hashlib.sha256}) for kind in ('access','refresh','csrf','challenge','outbox')}
        self._outbox: dict[str,list[dict]] = {}
        self._outbox_lock = threading.Lock()

    def digest(self, value: str) -> str:
        return hmac.new(self.cfg.secret.encode(), value.encode(), hashlib.sha256).hexdigest()

    def token(self, kind: str) -> str:
        return self.signers[kind].dumps(secrets.token_urlsafe(32))

    def valid_token(self, kind: str, value: str) -> bool:
        try:
            result = self.signers[kind].loads(value)
            return isinstance(result, str) and len(result) >= 32
        except (BadSignature, TypeError, ValueError):
            return False

    def ip(self, request):
        # Forwarded headers are deliberately not trusted. Configure a trusted proxy before deployment.
        return self.digest(request.client.host if request.client else 'unknown')

    def log(self, db, request, event, reason, actor=None, subject=None):
        db.execute('INSERT INTO security_log(at,actor_id,event,reason,subject,ip_digest) VALUES(?,?,?,?,?,?)',
                   (self.clock(), actor, event, reason, subject, self.ip(request) if request else 'server'))

    def safe_user(self, row):
        assignments = json.loads(row['assignments'])
        name = row['name']
        return {'id':row['id'],'email':row['email'],'name':name,'role':row['role'],
                'initials':''.join(x[0] for x in name.replace('Dr. ','').split()[:2]),
                'subtitle':'Server-verified account','assignments':assignments,
                'allowedPages':[x for x in PAGES if x != 'admin' or row['role']=='Admin'],
                'home':HOME[row['role']], 'otpRequired':row['role'] in self.cfg.otp_roles}

    def destination(self, value: str, account) -> str:
        allowed = self.safe_user(account)['allowedPages']
        # Exact allowlist: no domains, protocol-relative URLs, escaping, queries or fragments.
        return value if value in ['/'+x for x in allowed] else '/' + HOME[account['role']]

    def set_cookie(self, response, key, value, *, age=None, path='/'):
        response.set_cookie(key, value, max_age=age, path=path, httponly=True,
                            secure=self.cfg.cookie_secure, samesite='lax')

    def clear_cookies(self, response, include_outbox=False):
        for key in (ACCESS, REFRESH, CSRF, PREAUTH) + ((OUTBOX,) if include_outbox else ()):
            response.delete_cookie(key, path='/api/auth' if key==REFRESH else '/',
                                   httponly=True, secure=self.cfg.cookie_secure, samesite='lax')

    def bootstrap(self, request, response):
        csrf = request.cookies.get(CSRF, '')
        if not self.valid_token('csrf', csrf):
            csrf = self.token('csrf')
            self.set_cookie(response, CSRF, csrf)
        ticket = request.cookies.get(OUTBOX, '')
        if self.cfg.demo_mode and not self.cfg.smtp_host and not self.valid_token('outbox', ticket):
            self.set_cookie(response, OUTBOX, self.token('outbox'))
        return {'csrfToken':csrf, 'demoMode':self.cfg.demo_mode, 'simulatedDelivery':self.cfg.demo_mode and not bool(self.cfg.smtp_host),
                'policy':{'accessSeconds':self.cfg.access_seconds,'sessionSeconds':self.cfg.session_seconds,
                          'idleSeconds':self.cfg.idle_seconds,'rememberedSeconds':self.cfg.remembered_seconds,
                          'otpSeconds':self.cfg.otp_seconds,'otpAttempts':self.cfg.otp_attempts,'resetSeconds':self.cfg.reset_seconds}}

    def check_csrf(self, request, db=None, session=None):
        origin = request.headers.get('origin')
        if origin and origin != self.cfg.origin:
            raise AppError(403, 'This request origin is not permitted.', code='csrf_failed')
        if request.headers.get('sec-fetch-site') == 'cross-site':
            raise AppError(403, 'Cross-site writes are not permitted.', code='csrf_failed')
        header, cookie = request.headers.get('x-csrf-token',''), request.cookies.get(CSRF,'')
        if not header or not hmac.compare_digest(header, cookie) or not self.valid_token('csrf', cookie):
            raise AppError(403, 'The request verification expired. Reload this page and try again.', code='csrf_failed')
        if session and not hmac.compare_digest(session['csrf_digest'], self.digest(cookie)):
            raise AppError(403, 'Session request verification failed.', code='csrf_failed')

    def _live(self, account, session):
        now = self.clock()
        return (account and session and account['active'] and not session['revoked'] and
                account['version']==session['version'] and session['absolute_expires']>now and
                session['last_activity'] + self.cfg.idle_seconds > now and
                (account['role'] not in self.cfg.otp_roles or session['otp_verified']))

    def lookup(self, access: str):
        if not self.valid_token('access', access): return None
        with self.db.connect() as db:
            session = db.execute('SELECT * FROM sessions WHERE access_digest=?', (self.digest(access),)).fetchone()
            if not session: return None
            account = db.execute('SELECT * FROM users WHERE id=?', (session['user_id'],)).fetchone()
            if self._live(account, session) and session['access_expires']>self.clock():
                return dict(account), dict(session)
        return None

    def requireSession(self, request, db, *, write=False, activity=True):
        # Re-read inside the transaction: changes between middleware and operation cannot bypass revocation.
        token = request.cookies.get(ACCESS, '')
        session = db.execute('SELECT * FROM sessions WHERE access_digest=?', (self.digest(token),)).fetchone() if self.valid_token('access',token) else None
        account = db.execute('SELECT * FROM users WHERE id=?',(session['user_id'],)).fetchone() if session else None
        if not self._live(account,session) or session['access_expires']<=self.clock():
            raise AppError(401, 'Please sign in again to continue.', code='session_expired')
        if write: self.check_csrf(request, db, session)
        if activity:
            request.state.idle_expires = self.clock() + self.cfg.idle_seconds
            db.execute('UPDATE sessions SET last_activity=? WHERE id=?',(self.clock(),session['id']))
        return dict(account), dict(session)

    def requirePermission(self, request, db, account, allowed):
        if account['role'] not in allowed:
            self.log(db,request,'access_denied','role_not_permitted',account['id'])
            raise AppError(403, 'Your signed-in account cannot perform this operation.', code='access_denied')

    def requireTrialSiteAccess(self, request, db, account, trial_id=None, site_id=None):
        assignments=json.loads(account['assignments'])
        allowed=any((not trial_id or a['trialId']==trial_id) and (not site_id or site_id in a['siteIds']) for a in assignments)
        if (trial_id or site_id) and not allowed:
            self.log(db,request,'access_denied','outside_trial_site_scope',account['id'])
            raise AppError(404, 'This record or scope is not available to your account.', code='not_found')

    def throttle(self, db, request, kind, email='', limit=None):
        now=self.clock()
        keys=[(kind+':identity:'+self.digest(email),limit or self.cfg.login_limit), (kind+':ip:'+self.ip(request),self.cfg.ip_login_limit)]
        count=0
        for key, cap in keys:
            row=db.execute('SELECT * FROM throttle WHERE key=?',(key,)).fetchone()
            if not row or row['window_start']+self.cfg.rate_window<=now:
                db.execute('INSERT OR REPLACE INTO throttle VALUES(?,?,?)',(key,now,1)); count=max(count,1)
            elif row['count']>=cap:
                retry=max(1,min(self.cfg.rate_window,int(row['window_start']+self.cfg.rate_window-now)+1))
                self.log(db,request,'attempt_throttled',kind+'_limit')
                raise AppError(429,'Too many attempts. Try again after the indicated delay.',code='rate_limited',headers={'Retry-After':str(retry)})
            else:
                db.execute('UPDATE throttle SET count=count+1 WHERE key=?',(key,));count=max(count,row['count']+1)
        return count

    def verify_password(self, account, password):
        hash_value=account['password_hash'] if account and account['password_hash'] else self.dummy_hash
        try:
            verified=self.hasher.verify(hash_value,password)
        except (VerificationError, InvalidHashError):
            verified=False
        return bool(verified and account and account['password_hash'] and account['active'])

    def session_payload(self, account, session, csrf):
        return {'user':self.safe_user(account),'session':{'id':session['id'],'accessExpiresAt':session['access_expires'],
                'absoluteExpiresAt':session['absolute_expires'],'idleExpiresAt':session['last_activity']+self.cfg.idle_seconds,
                'remembered':bool(session['remembered'])},'csrfToken':csrf}

    def create_session(self, db, request, response, account, remembered, otp_verified=False):
        now=self.clock();sid=secrets.token_urlsafe(24)
        access,refresh,csrf=self.token('access'),self.token('refresh'),self.token('csrf')
        lifetime=self.cfg.remembered_seconds if remembered else self.cfg.session_seconds
        values=(sid,account['id'],account['version'],self.digest(access),min(now+self.cfg.access_seconds,now+lifetime),
                self.digest(refresh),now,now+lifetime,now,int(remembered),self.digest(csrf),int(otp_verified))
        db.execute('INSERT INTO sessions(id,user_id,version,access_digest,access_expires,refresh_digest,created,absolute_expires,last_activity,remembered,csrf_digest,otp_verified) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',values)
        session=dict(db.execute('SELECT * FROM sessions WHERE id=?',(sid,)).fetchone())
        # Non-remembered cookies are browser-session cookies; remembered cookies persist to absolute expiry.
        age=int(lifetime) if remembered else None
        self.set_cookie(response,ACCESS,access,age=age)
        self.set_cookie(response,REFRESH,refresh,age=age,path='/api/auth')
        self.set_cookie(response,CSRF,csrf,age=age)
        response.delete_cookie(PREAUTH,path='/',secure=self.cfg.cookie_secure,httponly=True,samesite='lax')
        self.log(db,request,'login_success','otp_verified' if otp_verified else 'password_verified',account['id'])
        return self.session_payload(account,session,csrf)

    def login(self, request, response, email, password, remembered, destination):
        self.check_csrf(request)
        try: email=normalize_email(email)
        except AppError: email=email.strip().casefold()[:254]
        with self.db.transaction() as db:
            count=self.throttle(db,request,'login',email)
            account=db.execute('SELECT * FROM users WHERE email=?',(email,)).fetchone()
            success=len(password)<=1024 and self.verify_password(account,password)
            if not success:
                reason='unknown_account' if not account else 'disabled_account' if not account['active'] else 'invalid_password'
                self.log(db,request,'login_failed',reason,subject=self.digest(email))
                time.sleep(min(0.08*count,0.4)*self.cfg.retry_delay_scale)
                raise AppError(401,'Sign-in failed. Check your email and password or try again later.',code='invalid_credentials')
            # Reset only this identity bucket on success. IP throttling remains to cap abusive aggregate traffic.
            db.execute('DELETE FROM throttle WHERE key=?',('login:identity:'+self.digest(email),))
            if self.hasher.check_needs_rehash(account['password_hash']):
                db.execute('UPDATE users SET password_hash=? WHERE id=?',(self.hasher.hash(password),account['id']))
            # A new login replaces any same-browser previous session, never a role-switch shortcut.
            old=request.cookies.get(REFRESH,'')
            if old:
                db.execute('UPDATE sessions SET revoked=1 WHERE refresh_digest=?',(self.digest(old),))
            if account['role'] in self.cfg.otp_roles:
                return self.start_challenge(db,request,response,account,remembered,self.destination(destination,account))
            result=self.create_session(db,request,response,account,remembered)
            result['destination']=self.destination(destination,account)
            return result

    def deliver(self, request, db, account, kind, payload, *, challenge_id=None):
        if self.cfg.smtp_host:
            msg=EmailMessage();msg['Subject']='AYUSETU '+ ('verification code' if kind=='otp' else 'password '+kind)
            msg['From']=self.cfg.smtp_sender;msg['To']=account['email']
            msg.set_content(('Your AYUSETU verification code is '+payload['code']+'. It expires in five minutes.') if kind=='otp' else ('Use this one-time AYUSETU link: '+payload['url']))
            try:
                with smtplib.SMTP(self.cfg.smtp_host,self.cfg.smtp_port,timeout=10) as smtp:
                    smtp.starttls()
                    if self.cfg.smtp_user:smtp.login(self.cfg.smtp_user,self.cfg.smtp_password)
                    smtp.send_message(msg)
            except Exception:
                self.log(db,request,'delivery_failed','configured_provider_failure',account['id'])
                return False
            return True
        if not self.cfg.demo_mode or not self.cfg.isolated_synthetic:
            self.log(db,request,'delivery_unavailable','no_provider_configured',account['id'])
            return False
        # This deliberately labeled DEVELOPMENT outbox is memory-only; the DB stores only token digests.
        ticket=request.cookies.get(OUTBOX,'')
        if not self.valid_token('outbox',ticket): return False
        key=self.digest(ticket)
        with self._outbox_lock:
            self._outbox[key]=[m for m in self._outbox.get(key,[]) if m['expiresAt']>self.clock() and not (m['kind']==kind and m['to']==account['email'])]
            self._outbox[key].append({'id':secrets.token_urlsafe(12),'kind':kind,'to':account['email'],'challengeId':challenge_id,
                                     'expiresAt':self.clock()+(self.cfg.otp_seconds if kind=='otp' else self.cfg.reset_seconds),**payload})
        self.log(db,request,'demo_delivery','isolated_memory_outbox',account['id'])
        return True

    def outbox(self, request):
        if not self.cfg.demo_mode or not self.cfg.isolated_synthetic or self.cfg.smtp_host:
            raise AppError(404,'Not found.',code='not_found')
        ticket=request.cookies.get(OUTBOX,'')
        if not self.valid_token('outbox',ticket):raise AppError(404,'Not found.',code='not_found')
        challenge=request.cookies.get(PREAUTH,'')
        challenge_id=None
        with self.db.connect() as db:
            row=db.execute('SELECT * FROM challenges WHERE cookie_digest=? AND consumed=0',(self.digest(challenge),)).fetchone()
            if row and row['expires']>self.clock():challenge_id=row['id']
        with self._outbox_lock:
            messages=[dict(m) for m in self._outbox.get(self.digest(ticket),[]) if m['expiresAt']>self.clock() and (m['kind']!='otp' or m['challengeId']==challenge_id)]
        return {'label':'OTP delivery simulated — not independent MFA. Password recovery delivery is also simulated.', 'messages':messages}

    def start_challenge(self,db,request,response,account,remembered,destination):
        now=self.clock();cid=secrets.token_urlsafe(24);cookie=self.token('challenge');code=f'{secrets.randbelow(1000000):06d}'
        # Bound, limited pre-authentication state; no access/refresh credential exists at this point.
        db.execute('UPDATE challenges SET consumed=1 WHERE user_id=?',(account['id'],))
        db.execute('INSERT INTO challenges(id,user_id,cookie_digest,code_digest,expires,created,last_sent,remembered,destination,user_version) VALUES(?,?,?,?,?,?,?,?,?,?)',
                   (cid,account['id'],self.digest(cookie),self.digest(cid+':'+code),now+self.cfg.otp_seconds,now,now,int(remembered),destination,account['version']))
        self.set_cookie(response,PREAUTH,cookie,age=self.cfg.otp_seconds)
        for key in (ACCESS,REFRESH): response.delete_cookie(key,path='/api/auth' if key==REFRESH else '/',secure=self.cfg.cookie_secure,httponly=True,samesite='lax')
        sent=self.deliver(request,db,account,'otp',{'code':code},challenge_id=cid)
        self.log(db,request,'otp_challenge_created','pre_authentication_only',account['id'])
        return {'otpRequired':True,'expiresAt':now+self.cfg.otp_seconds,'resendAt':now+self.cfg.otp_resend_seconds,
                'deliveryAvailable':sent,'destination':'/verify-otp'}

    def challenge(self,request,db):
        cookie=request.cookies.get(PREAUTH,'')
        challenge=db.execute('SELECT * FROM challenges WHERE cookie_digest=?',(self.digest(cookie),)).fetchone() if self.valid_token('challenge',cookie) else None
        account=db.execute('SELECT * FROM users WHERE id=?',(challenge['user_id'],)).fetchone() if challenge else None
        if not challenge or challenge['consumed'] or challenge['expires']<=self.clock() or challenge['attempts']>=self.cfg.otp_attempts or not account or not account['active'] or account['version']!=challenge['user_version']:
            raise AppError(401,'Verification expired or unavailable. Sign in again.',code='challenge_expired')
        return challenge,account

    def verify_otp(self,request,response,code):
        self.check_csrf(request)
        with self.db.transaction() as db:
            challenge,account=self.challenge(request,db)
            db.execute('UPDATE challenges SET attempts=attempts+1 WHERE id=?',(challenge['id'],))
            if not re.fullmatch(r'\d{6}',code) or not hmac.compare_digest(challenge['code_digest'],self.digest(challenge['id']+':'+code)):
                self.log(db,request,'otp_failed','incorrect_code',account['id'])
                left=max(0,self.cfg.otp_attempts-challenge['attempts']-1)
                raise AppError(401,f'Incorrect verification code. {left} attempts remaining.',code='otp_invalid')
            db.execute('UPDATE challenges SET consumed=1 WHERE id=?',(challenge['id'],))
            result=self.create_session(db,request,response,account,bool(challenge['remembered']),True)
            result['destination']=self.destination(challenge['destination'],account)
            return result

    def resend_otp(self,request):
        self.check_csrf(request)
        with self.db.transaction() as db:
            challenge,account=self.challenge(request,db)
            now=self.clock();left=challenge['last_sent']+self.cfg.otp_resend_seconds-now
            if left>0:raise AppError(429,'Please wait before requesting another code.',code='resend_cooldown',headers={'Retry-After':str(int(left)+1)})
            # Do not reset attempts or extend challenge lifetime by resending.
            code=f'{secrets.randbelow(1000000):06d}'
            while hmac.compare_digest(challenge['code_digest'],self.digest(challenge['id']+':'+code)):
                code=f'{secrets.randbelow(1000000):06d}'
            db.execute('UPDATE challenges SET code_digest=?,last_sent=? WHERE id=?',(self.digest(challenge['id']+':'+code),now,challenge['id']))
            sent=self.deliver(request,db,account,'otp',{'code':code},challenge_id=challenge['id'])
            self.log(db,request,'otp_resent','previous_code_invalidated',account['id'])
            return {'expiresAt':challenge['expires'],'resendAt':now+self.cfg.otp_resend_seconds,'deliveryAvailable':sent}

    def refresh(self,request,response):
        self.check_csrf(request)
        old=request.cookies.get(REFRESH,'')
        if not self.valid_token('refresh',old):raise AppError(401,'Please sign in again.',code='session_expired')
        with self.db.transaction() as db:
            digest=self.digest(old)
            spent=db.execute('SELECT * FROM spent_refresh WHERE digest=?',(digest,)).fetchone()
            if spent:
                db.execute('UPDATE sessions SET revoked=1 WHERE id=?',(spent['session_id'],))
                self.log(db,request,'refresh_replay','session_revoked')
                raise AppError(401,'Please sign in again.',code='session_expired')
            session=db.execute('SELECT * FROM sessions WHERE refresh_digest=?',(digest,)).fetchone()
            account=db.execute('SELECT * FROM users WHERE id=?',(session['user_id'],)).fetchone() if session else None
            if not self._live(account,session):raise AppError(401,'Please sign in again.',code='session_expired')
            self.check_csrf(request,db,session)
            now=self.clock();access,refresh=self.token('access'),self.token('refresh')
            db.execute('INSERT INTO spent_refresh VALUES(?,?,?)',(digest,session['id'],session['absolute_expires']))
            db.execute('DELETE FROM spent_refresh WHERE expires<?',(now,))
            # Refresh is not user activity. It never extends inactivity or absolute limits.
            db.execute('UPDATE sessions SET access_digest=?,access_expires=?,refresh_digest=? WHERE id=?',
                       (self.digest(access),min(now+self.cfg.access_seconds,session['absolute_expires']),self.digest(refresh),session['id']))
            updated=db.execute('SELECT * FROM sessions WHERE id=?',(session['id'],)).fetchone()
            age=max(1,int(session['absolute_expires']-now)) if session['remembered'] else None
            self.set_cookie(response,ACCESS,access,age=age);self.set_cookie(response,REFRESH,refresh,age=age,path='/api/auth')
            self.log(db,request,'session_refreshed','rotating_opaque_credentials',account['id'])
            return self.session_payload(account,updated,request.cookies[CSRF])

    def logout(self,request,response):
        self.check_csrf(request)
        with self.db.transaction() as db:
            # Logout can revoke an expired-access session through its still-present refresh credential.
            token=request.cookies.get(REFRESH,'')
            session=db.execute('SELECT * FROM sessions WHERE refresh_digest=?',(self.digest(token),)).fetchone() if self.valid_token('refresh',token) else None
            if session:
                self.check_csrf(request,db,session)
                db.execute('UPDATE sessions SET revoked=1 WHERE id=?',(session['id'],))
                self.log(db,request,'logout','current_session_revoked',session['user_id'])
            db.execute('UPDATE challenges SET consumed=1 WHERE cookie_digest=?',(self.digest(request.cookies.get(PREAUTH,'')),))
        ticket=request.cookies.get(OUTBOX,'')
        with self._outbox_lock:self._outbox.pop(self.digest(ticket),None)
        self.clear_cookies(response,True)
        return {'signedOut':True}

    def issue_recovery(self,db,request,account,kind='reset'):
        raw=secrets.token_urlsafe(48)
        db.execute('UPDATE recovery SET consumed=1 WHERE user_id=?',(account['id'],))
        db.execute('INSERT INTO recovery VALUES(?,?,?,?,?)',(self.digest(raw),account['id'],self.clock()+self.cfg.reset_seconds,0,kind))
        # Fragment prevents raw token from appearing in HTTP paths, Referer headers and access logs.
        url=self.cfg.origin+'/reset-password#token='+raw
        self.deliver(request,db,account,kind,{'url':url})
        self.log(db,request,'recovery_issued',kind+'_single_use',account['id'])

    def forgot(self,request,email):
        self.check_csrf(request)
        try:email=normalize_email(email)
        except AppError:email=email.strip().casefold()[:254]
        with self.db.transaction() as db:
            self.throttle(db,request,'recovery',email)
            account=db.execute('SELECT * FROM users WHERE email=?',(email,)).fetchone()
            if account and account['active']:self.issue_recovery(db,request,account)
            else:self.log(db,request,'recovery_requested','account_unavailable',subject=self.digest(email))
        return {'message':'If an eligible account exists, password-reset instructions have been sent through the configured delivery channel.'}

    def invalidate_user(self,db,user_id):
        db.execute('UPDATE sessions SET revoked=1 WHERE user_id=?',(user_id,))
        db.execute('UPDATE challenges SET consumed=1 WHERE user_id=?',(user_id,))
        db.execute('UPDATE recovery SET consumed=1 WHERE user_id=?',(user_id,))

    def reset_password(self,request,response,token,password,confirmation):
        self.check_csrf(request);check_password(password,confirmation)
        with self.db.transaction() as db:
            self.throttle(db,request,'reset',self.ip(request),limit=20)
            recovery=db.execute('SELECT * FROM recovery WHERE digest=?',(self.digest(token),)).fetchone()
            account=db.execute('SELECT * FROM users WHERE id=?',(recovery['user_id'],)).fetchone() if recovery else None
            if not recovery or recovery['consumed'] or recovery['expires']<=self.clock() or not account or not account['active']:
                self.log(db,request,'reset_failed','invalid_expired_or_consumed')
                raise AppError(400,'This reset link is invalid, expired, or already used.',code='reset_invalid')
            password_hash=self.hasher.hash(password)
            db.execute('UPDATE users SET password_hash=?,version=version+1 WHERE id=?',(password_hash,account['id']))
            self.invalidate_user(db,account['id'])
            self.log(db,request,'password_reset','all_user_sessions_and_challenges_revoked',account['id'])
        self.clear_cookies(response,True)
        return {'message':'Password updated. Sign in again; any required OTP verification still applies.'}

    def change_password(self,request,response,current,password,confirmation):
        check_password(password,confirmation)
        with self.db.transaction() as db:
            account,session=self.requireSession(request,db,write=True)
            self.throttle(db,request,'password_change',account['id'])
            if not self.verify_password(account,current):
                self.log(db,request,'password_change_failed','incorrect_current_password',account['id'])
                raise AppError(400,'The current password could not be verified.',code='password_invalid')
            db.execute('UPDATE users SET password_hash=?,version=version+1 WHERE id=?',(self.hasher.hash(password),account['id']))
            self.invalidate_user(db,account['id'])
            self.log(db,request,'password_changed','all_user_sessions_revoked',account['id'])
        self.clear_cookies(response,True)
        return {'message':'Password changed. Sign in again.'}
