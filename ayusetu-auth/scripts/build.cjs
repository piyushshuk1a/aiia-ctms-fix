/* Build separate client and server artifacts. Never ship the seed dataset/repository in client JavaScript. */
const fs=require('fs'),path=require('path'),cp=require('child_process');
const root=path.resolve(__dirname,'..');process.chdir(root);
let ts;try{ts=require('typescript');}catch{ts=require(path.join(cp.execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'typescript'));}
const domain=fs.readFileSync('src/domain.ts','utf8');
const ast=ts.createSourceFile('domain.ts',domain,ts.ScriptTarget.ES2021,true);
const skip=[];
function visit(node){if((ts.isFunctionDeclaration(node)||ts.isClassDeclaration(node)) && ['seed','LocalRepository','syncActions','assertIntegrity'].includes(node.name?.text)){skip.push([node.getFullStart(),node.end]);return;}ts.forEachChild(node,visit);}
visit(ast);let client=domain;for(const [start,end] of skip.sort((a,b)=>b[0]-a[0]))client=client.slice(0,start)+client.slice(end);
fs.writeFileSync('src/client-domain.ts',client);
fs.mkdirSync('build',{recursive:true});fs.mkdirSync('dist',{recursive:true});
fs.writeFileSync('build/domain.cjs',ts.transpileModule(domain,{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.None,strict:true}}).outputText+'\nmodule.exports=Ayu;\n');
let compiler=path.join(root,'node_modules/typescript/bin/tsc');
cp.execFileSync(fs.existsSync(compiler)?process.execPath:'tsc',fs.existsSync(compiler)?[compiler,'--project','tsconfig.json']:['--project','tsconfig.json'],{stdio:'inherit'});
const html='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#102a43"><title>AYUSETU · Sign in</title><link rel="stylesheet" href="/assets/styles.css"></head><body><div id="root"><div class="auth-loading"><h1>Checking your workspace access</h1><p>No clinical data is loaded before verification.</p></div></div><script src="/assets/react.min.js"></script><script src="/assets/react-dom.min.js"></script><script src="/assets/bootstrap.js"></script><script src="/assets/app.js"></script><noscript>JavaScript is required. This application must run through its authenticated server, not as a standalone HTML file.</noscript></body></html>';
fs.writeFileSync('dist/index.html',html);
fs.writeFileSync('dist/access-denied.html','<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AYUSETU · Access denied</title><link rel="stylesheet" href="/assets/styles.css"></head><body><main class="auth-loading"><h1>Access denied</h1><p>Your signed-in account does not have access to Administration.</p><a href="/">Return to your workspace</a></main></body></html>');
const built=fs.readFileSync('build/app.js','utf8');
if(built.includes('function seed(')||built.includes('class LocalRepository')||built.includes('AyuSetu-Demo-2026!'))throw new Error('Server-only implementation leaked into client bundle.');
console.log('Built authenticated client and server domain module. Client bundle contains no seeded clinical dataset or demo passwords.');
