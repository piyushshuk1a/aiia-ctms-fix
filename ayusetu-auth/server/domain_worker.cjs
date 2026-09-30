/* Server-only bridge: reuses the original TypeScript clinical state machine.
   Never imports browser state or executes user-supplied JavaScript. */
'use strict';
const A=require('../build/domain.cjs');
let raw='';
process.stdin.setEncoding('utf8');process.stdin.on('data',c=>raw+=c);
process.stdin.on('end',()=>{
 try {
  const req=JSON.parse(raw);
  if(req.action==='seed') { process.stdout.write(JSON.stringify({ok:true,state:A.seed()})); return; }
  const state=req.state;
  const actor=req.actor;
  const storage={getItem:()=>JSON.stringify(state),setItem:(_k,v)=>Object.assign(state,JSON.parse(v))};
  let result=null;
  if(req.action==='mutate') {
   const repo=new A.LocalRepository(storage);
   if(repo.warning)throw new Error('Server clinical state failed integrity validation.');
   const methods=['screen','eligibility','consent','enroll','visit','safetyCreate','pvReview','prepareReport','answerQuery','verifyQuery','deviation','document','ethicsDecision','completeCompliance','readiness','activateSite','createTrial','configureTrial','lifecycle','assign','settings','patternReview','reset','validateImport','commitImport'];
   if(!methods.includes(req.op))throw new Error('Unsupported operation.');
   const previousAudit=state.audit, previousSeq=state.seq;
   result=repo[req.op](actor,...req.args);
   if(req.op==='reset') {
    state.users=req.stateUsers; state.assignments=req.stateAssignments;
    state.audit=previousAudit;state.seq=previousSeq+1;
    const id='AUD-RESET-'+state.seq;
    state.audit[id]={...A.base(id,'Recorded',actor),createdAt:req.now,updatedAt:req.now,actor,role:'Admin',entity:'reset',entityId:'DEMO',operation:'reset',before:null,after:{enrolled:190},reason:'Clinical demo reset confirmed. Accounts, passwords, sessions and security history preserved.'};
   }
   process.stdout.write(JSON.stringify({ok:true,state,result}));return;
  }
  const view=A.scoped(state,actor,req.scope||{});
  if(req.action==='view') result=view;
  else if(req.action==='assistant') result=A.assistant(view,req.question,req.scopeLabel);
  else if(req.action==='report') result=A.report(view,req.kind);
  else throw new Error('Unsupported read.');
  process.stdout.write(JSON.stringify({ok:true,result}));
 } catch(e) {process.stdout.write(JSON.stringify({ok:false,error:e.message,fields:e.fields||{}}));}
});
