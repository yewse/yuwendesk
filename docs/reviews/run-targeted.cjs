'use strict';
/**
 * Independent targeted checks of PR dc41e659's exact LocalStore/IpcService sources.
 * NOT the repository's Vitest suite; NOT Electron UI, Windows, installer or API testing.
 * Node 22.16.0 / TS 5.8.3 transpilation. Shared module is constants-only stub.
 * Only self-created synthetic data in a temporary directory; no live user files.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const {LocalStore} = require('./compiled/main/store.js');
const {IpcService} = require('./compiled/main/ipc.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuwendesk-review2-'));
const results = [];
let seq = 0;
async function fresh() {
  const dir = path.join(root, String(++seq));fs.mkdirSync(dir);
  const store = new LocalStore(dir);await store.load();
  const service = new IpcService({store,appVersion:'0.1.0',appNameZh:'test',platformSupported:true,httpListeners:0,online:false,buildMode:'development',sandboxEnabled:false,platformDevOverride:true});
  return {dir, store, service, file:path.join(dir,'yuwendesk-local-state.json')};
}
function req(key, content, revision) {
  return {schema_version:'1.0.0',request_id:`r-${seq}`,operation:'ui.saveDraft',workspace_id:null,idempotency_key:key,payload:{content},...(revision === undefined ? {} : {expected_revision:revision})};
}
async function check(id,name,fn) {
 const record={id,name,status:'PASS',observed:null};
 try {await fn(record);} catch(e) {record.status='FAIL';record.message=e.message;}
 results.push(record);console.log(record.status, id, name, JSON.stringify(record.observed));
}
(async()=>{
 await check('T01','control: new LocalStore instance reloads committed draft',async r=>{
  const x=await fresh();await x.store.saveDraft('已保存');
  const next=new LocalStore(x.dir);await next.load();r.observed=next.getDraft();
  assert.equal(r.observed.content,'已保存');assert.equal(r.observed.revision,1);
 });
 await check('T02','control: sequential same-key same-request replay',async r=>{
  const x=await fresh();const q=req('k','甲',0);
  const a=await x.service.handle(q.operation,q);const b=await x.service.handle(q.operation,q);
  r.observed={a,b,revision:x.store.getDraft().revision};
  assert.deepEqual(a,b);assert.equal(a.ok,true);assert.equal(x.store.getDraft().revision,1);
 });
 await check('T03','control: concurrent draft/window flushes no rename collision',async r=>{
  const x=await fresh(), tasks=[];
  for(let i=0;i<25;i++){tasks.push(x.store.saveDraft(`内容${i}`));tasks.push(x.store.saveWindow({width:1000+i,height:700+i}));}
  await Promise.all(tasks);const disk=JSON.parse(fs.readFileSync(x.file,'utf8'));r.observed=disk;
  assert.equal(disk.draft.content,'内容24');assert.equal(disk.draft.revision,25);assert.equal(disk.window.width,1024);
 });
 await check('T04','missing expected_revision must be INPUT_INVALID',async r=>{
  const x=await fresh(), q=req('missing','should reject',undefined);const a=await x.service.handle(q.operation,q);r.observed=a;
  assert.equal(a.ok,false);assert.equal(a.error.code,'INPUT_INVALID');
 });
 await check('T05','string expected_revision must be INPUT_INVALID',async r=>{
  const x=await fresh(),q=req('string','should reject','0');const a=await x.service.handle(q.operation,q);r.observed=a;
  assert.equal(a.ok,false);assert.equal(a.error.code,'INPUT_INVALID');
 });
 await check('T06','same key with different payload must not return success for old payload',async r=>{
  const x=await fresh();await x.service.handle('ui.saveDraft',req('same','A',0));
  const a=await x.service.handle('ui.saveDraft',req('same','B',0));r.observed={response:a,disk:JSON.parse(fs.readFileSync(x.file,'utf8')).draft};
  assert.equal(a.ok,false,'expected rejection, not cached success carrying A for requested B');
 });
 await check('T07','concurrent identical requests must both resolve to original success',async r=>{
  const x=await fresh(),q=req('concurrent','A',0);
  const [a,b]=await Promise.all([x.service.handle(q.operation,q),x.service.handle(q.operation,q)]);r.observed={a,b,revision:x.store.getDraft().revision};
  assert.equal(a.ok,true);assert.equal(b.ok,true);assert.deepEqual(a,b);assert.equal(x.store.getDraft().revision,1);
 });
 await check('T08','write failure must not publish uncommitted in-memory draft/revision',async r=>{
  const x=await fresh();await x.store.saveDraft('committed-A');const before=x.store.getDraft();
  const original=fsp.writeFile;let thrown;
  fsp.writeFile=async function(file,...args){if(String(file).startsWith(x.file)){const e=new Error('synthetic ENOSPC');e.code='ENOSPC';throw e;}return original.call(fsp,file,...args);};
  try{await x.store.saveDraft('uncommitted-B');}catch(e){thrown=e.code;}finally{fsp.writeFile=original;}
  r.observed={error:thrown,before,memory:x.store.getDraft(),disk:JSON.parse(fs.readFileSync(x.file,'utf8')).draft};
  assert.equal(thrown,'ENOSPC');assert.deepEqual(x.store.getDraft(),before);
 });
 await check('T09','corrupt source must survive load plus geometry save or be quarantined',async r=>{
  const x=await fresh();const damaged='{"draft":{"content":"RECOVER-ME"';fs.writeFileSync(x.file,damaged);
  const next=new LocalStore(x.dir);await next.load();await next.saveWindow({width:900,height:700});
  const names=fs.readdirSync(x.dir);const preserved=names.some(n=>fs.statSync(path.join(x.dir,n)).isFile()&&fs.readFileSync(path.join(x.dir,n),'utf8')===damaged);
  r.observed={files:names,after:fs.readFileSync(x.file,'utf8'),originalPreserved:preserved};
  assert.equal(preserved,true,'corrupt original was neither retained nor quarantined');
 });
 await check('T10','valid JSON with invalid field types must not enter live state',async r=>{
  const x=await fresh();fs.writeFileSync(x.file,JSON.stringify({draft:{content:123,revision:'bad',updated_at:null},window:{width:'bad',height:700}}));
  const next=new LocalStore(x.dir);let rejected=false;try{await next.load();}catch{rejected=true;}
  r.observed={rejected,draft:next.getDraft(),window:next.getWindow()};
  const safe=rejected||(typeof r.observed.draft.content==='string'&&Number.isSafeInteger(r.observed.draft.revision)&&typeof r.observed.window.width==='number');
  assert.equal(safe,true,'invalid fields were accepted into runtime state');
 });
 await check('T11','saveDraft response must correspond to its own commit, not later state',async r=>{
  const x=await fresh();const [a,b]=await Promise.all([x.store.saveDraft('A'),x.store.saveDraft('B')]);r.observed={a,b,disk:JSON.parse(fs.readFileSync(x.file,'utf8')).draft};
  assert.equal(a.content,'A');assert.equal(a.revision,1);assert.equal(b.content,'B');assert.equal(b.revision,2);
 });
 const report={commit:'dc41e65971889f14a7424ae68c33cdc93a9da35b',scope:'Exact source LocalStore/IpcService targeted logic/filesystem tests, not original suite or Electron/Windows',node:process.version,platform:process.platform,transpiler:'TypeScript 5.8.3 (not project typecheck)',sourceVerification:'SOURCE_VERIFICATION.json',counts:{total:results.length,pass:results.filter(x=>x.status==='PASS').length,fail:results.filter(x=>x.status==='FAIL').length},results};
 fs.writeFileSync(path.join(__dirname,'TARGETED_RESULTS.json'),JSON.stringify(report,null,2));
 console.log('SUMMARY',JSON.stringify(report.counts));
 process.exitCode=report.counts.fail?1:0;
})().catch(e=>{console.error(e);process.exitCode=2;}).finally(()=>{fs.rmSync(root,{recursive:true,force:true});});
