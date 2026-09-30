/** Same-origin authentication client. Credentials/cookies are never copied to browser storage.
 * UI checks are only presentation. The FastAPI session and permission boundary is authoritative.
 */
namespace AyuAuth {
 export interface SafeUser extends Ayu.User { email:string; home:string; allowedPages:string[]; otpRequired:boolean; assignments:{trialId:string;siteIds:string[]}[]; }
 export interface SafeSession { id:string; accessExpiresAt:number; absoluteExpiresAt:number; idleExpiresAt:number; remembered:boolean; }
 export interface SessionResult {user:SafeUser;session:SafeSession;csrfToken:string;destination?:string;}
 export class APIError extends Error {
  fields:Record<string,string>;status:number;code:string;retryAfter:number;
  constructor(status:number,data:any,retryAfter=0){super(data.message||'The request failed.');this.name='APIError';this.status=status;this.code=data.code||'request_failed';this.fields=data.fields||{};this.retryAfter=retryAfter;}
 }
 export class AuthService {
  current:SessionResult|null=null;csrf='';config:any=null;generation=0;listeners:((reason:string)=>void)[]=[];
  controllers=new Set<AbortController>();refreshing:Promise<SessionResult>|null=null;logoutUnconfirmed=false;
  channel:BroadcastChannel|null=null;lastActivity=0;timer:any;
  constructor(){
   try {this.channel=new BroadcastChannel('ayusetu-session-v2');this.channel.onmessage=()=>this.invalidate('Session changed in another tab. Checking account…');}catch{}
   try{localStorage.removeItem('ayusetu.synthetic.v1');localStorage.removeItem('ayusetu.ui.v1');}catch{}
   document.addEventListener('pointerdown',this.activity,true);document.addEventListener('keydown',this.activity,true);
   window.addEventListener('pagehide',()=>{if(this.current)this.invalidate('Checking session…');});
   window.addEventListener('pageshow',(e)=>{if(e.persisted)this.invalidate('Checking session…');});
   window.addEventListener('focus',()=>{if(this.current)this.checkLive();});
   this.timer=setInterval(()=>this.checkLive(),15000);
  }
  subscribe(fn:(reason:string)=>void){this.listeners.push(fn);return()=>{this.listeners=this.listeners.filter(f=>f!==fn);};}
  abort(){this.generation++;for(const c of this.controllers)c.abort();this.controllers.clear();}
  invalidate(reason='Please sign in again.'){this.abort();this.current=null;this.csrf='';this.listeners.forEach(fn=>fn(reason));}
  apply(result:SessionResult){this.current=result;this.csrf=result.csrfToken;return result;}
  broadcast(){this.channel?.postMessage({event:'session_changed'});}
  async request(path:string, init:any={}, protectedCall=true, retry=true, raw=false):Promise<any>{
   const controller=new AbortController();this.controllers.add(controller);const epoch=this.generation;
   const headers:any={...(init.body?{'Content-Type':'application/json'}:{}),...(init.headers||{})};
   if(init.method && !['GET','HEAD'].includes(init.method))headers['X-CSRF-Token']=this.csrf;
   let response:Response;
   try{response=await fetch(path,{...init,headers,credentials:'same-origin',cache:'no-store',signal:controller.signal});}
   catch(e){if((e as Error).name==='AbortError')throw new APIError(0,{message:'Request cancelled.',code:'cancelled'});throw new APIError(0,{message:'Connection unavailable. No success has been confirmed. Check the connection and retry.',code:'network_error'});}
   finally{this.controllers.delete(controller);}
   if(epoch!==this.generation)throw new APIError(0,{message:'The account changed. This response was discarded.',code:'cancelled'});
   if(response.status===401 && protectedCall && retry){
    try{await this.refresh();return await this.request(path,init,protectedCall,false,raw);}
    catch(e){if((e as APIError).status!==0)this.invalidate('Your session expired or access changed. Please sign in again.');throw e;}
   }
   if(!response.ok){
    let data:any;try{data=await response.json();}catch{data={message:'The server could not complete this request.'};}
    if(protectedCall && (response.status===401 || data.code==='csrf_failed'))this.invalidate('Your session expired or access changed. Please sign in again.');
    throw new APIError(response.status,data,Number(response.headers.get('Retry-After')||0));
   }
   const idle=Number(response.headers.get('X-Ayu-Idle-Expires')||0);if(idle && this.current)this.current.session.idleExpiresAt=idle;
   return raw?response:response.json();
  }
  async bootstrap(){this.config=await this.request('/api/auth/bootstrap',{},false);this.csrf=this.config.csrfToken;return this.config;}
  async restore():Promise<SessionResult|null>{
   await this.bootstrap();
   try{return this.apply(await this.request('/api/auth/session',{},false));}
   catch(e){if((e as APIError).status!==401)throw e;}
   try{return await this.refresh();}catch(e){if((e as APIError).status===401 || (e as APIError).status===403)return null;throw e;}
  }
  async refresh():Promise<SessionResult>{
   if(this.refreshing)return this.refreshing;
   const work=async()=>{
    // Recheck under a same-origin cross-tab lock before rotating: another tab may have refreshed already.
    try{return this.apply(await this.request('/api/auth/session',{},false));}catch(e){if((e as APIError).status!==401)throw e;}
    return this.apply(await this.request('/api/auth/refresh',{method:'POST',body:'{}'},false));
   };
   const locks=(navigator as any).locks;
   this.refreshing=(locks?locks.request('ayusetu-refresh',work):work()).finally(()=>{this.refreshing=null;});
   return this.refreshing!;
  }
  async login(email:string,password:string,remember:boolean,next:string){
   const result=await this.request('/api/auth/login',{method:'POST',body:JSON.stringify({email,password,remember,next})},false);
   if(!result.otpRequired){this.apply(result);this.broadcast();}
   return result;
  }
  async verify(code:string){const result=await this.request('/api/auth/otp/verify',{method:'POST',body:JSON.stringify({code})},false);this.apply(result);this.broadcast();return result;}
  async logout(){
   this.abort();
   try{await this.request('/api/auth/logout',{method:'POST',body:'{}'},false);this.logoutUnconfirmed=false;this.broadcast();this.invalidate('Signed out. Shared trial changes have been preserved.');}
   catch(e){this.logoutUnconfirmed=true;this.invalidate('Server sign-out could not be confirmed. Reconnect and retry sign out before sharing this browser.');throw e;}
  }
  async changePassword(body:any){const result=await this.request('/api/auth/change-password',{method:'POST',body:JSON.stringify(body)});this.broadcast();this.invalidate(result.message);return result;}
  activity=()=>{
   if(!this.current || Date.now()-this.lastActivity<60000)return;
   this.lastActivity=Date.now();
   this.request('/api/auth/activity',{method:'POST',body:'{}'}).then(r=>{if(this.current)this.current.session.idleExpiresAt=r.idleExpiresAt;}).catch(()=>{});
  };
  checkLive=async()=>{
   if(!this.current || document.visibilityState==='hidden')return;
   if(Date.now()/1000>=Math.min(this.current.session.absoluteExpiresAt,this.current.session.idleExpiresAt)){
    this.invalidate('Your session reached its inactivity or absolute time limit. Please sign in again.');return;
   }
   try{const result=await this.request('/api/auth/session',{},false);if(this.current && result.session.id!==this.current.session.id)this.invalidate('The signed-in account changed. Checking session…');else this.apply(result);}
   catch(e){if((e as APIError).status===401){try{await this.refresh();}catch(err){if((err as APIError).status!==0)this.invalidate('Your session expired or access changed. Please sign in again.');}}}
  };
  async file(path:string){const response=await this.request(path,{},true,true,true);const blob=await response.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=(response.headers.get('Content-Disposition')||'').match(/filename="([^"]+)"/)?.[1]||'AYUSETU-export.txt';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 }
 export const authService=new AuthService();
 export class ServerRepository {
  [key:string]:any;
  private data:Ayu.State;private actor:SafeUser;private listeners:(()=>void)[]=[];warning='';revision:number;
  constructor(data:Ayu.State,actor:SafeUser,revision:number){this.data=data;this.actor=actor;this.revision=revision;
   const methods=['screen','eligibility','consent','enroll','visit','safetyCreate','pvReview','prepareReport','answerQuery','verifyQuery','deviation','document','ethicsDecision','completeCompliance','readiness','activateSite','createTrial','configureTrial','lifecycle','assign','settings','patternReview','reset','validateImport','commitImport'];
   for(const op of methods)this[op]=async(_ignoredBrowserActor:string,...args:any[])=>{
    // Deliberately discard any caller-supplied identity. Only the session resolves the actor on the server.
    if(op==='reset')args=['RESET'];
    const value=await authService.request('/api/operations',{method:'POST',body:JSON.stringify({op,args})});
    this.data=value.state;this.revision=value.revision;this.listeners.forEach(fn=>fn());return value.result;
   };
  }
  subscribe(fn:()=>void){this.listeners.push(fn);return()=>{this.listeners=this.listeners.filter(f=>f!==fn);};}
  view(_ignored:string,scope:Ayu.Scope={}){return Ayu.scoped(this.data,this.actor.id,scope);}
  identities(){return Ayu.vals(this.data.users);}
  async reload(){const value=await authService.request('/api/records');this.data=value.state;this.revision=value.revision;this.listeners.forEach(fn=>fn());}
  dispose(){this.data=null as any;this.listeners=[];}
 }
}
