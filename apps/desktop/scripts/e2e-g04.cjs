// G04 模型闭环端到端（仅测试用）。真实 preload+渲染层+IPC+SqliteStore+ModelService。
// 演示：配置测试替身+探测可用；DeepSeek 真实探测 BLOCKED；获准片段结构化分析(明标测试替身)；
// 边界拒绝(未获准/敏感)、缓存复用、真实调用 BLOCKED、重启后配置/作业持久化与不确定态。
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DIST = path.join(__dirname, '..', 'dist');
const { IpcService } = require(path.join(DIST, 'main', 'ipc.js'));
const { SqliteStore } = require(path.join(DIST, 'main', 'db', 'sqliteStore.js'));
const { ModelService } = require(path.join(DIST, 'main', 'model', 'service.js'));
const { IMPLEMENTED_OPERATIONS } = require(path.join(DIST, 'shared', 'ipc.js'));

const ART = process.env.E2E_ART || '/opt/cursor/artifacts';
fs.mkdirSync(ART, { recursive: true });
const userData = process.env.E2E_USERDATA || path.join(os.tmpdir(), 'yuwendesk-e2e-g04-' + Date.now());
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

const transcript = [];
const log = (step, data) => {
  transcript.push({ step, data });
  console.log('E2E4 ' + step + ' :: ' + JSON.stringify(data));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let store;
async function wire() {
  store = new SqliteStore(userData, { safeStorage });
  await store.load();
  const svc = new IpcService({
    store,
    sourceStore: store,
    modelService: new ModelService(store),
    appVersion: 'e2e4',
    appNameZh: 'e2e4',
    platformSupported: true,
    httpListeners: 0,
    online: false,
    buildMode: 'production',
    sandboxEnabled: true,
    platformDevOverride: true,
    platformTargetSupported: true,
    platformIdentity: 'e2e4'
  });
  for (const op of IMPLEMENTED_OPERATIONS) {
    ipcMain.removeHandler(`yuwen:${op}`);
    ipcMain.handle(`yuwen:${op}`, async (_e, req) => svc.handle(op, req));
  }
}
function makeWindow() {
  return new BrowserWindow({ width: 1200, height: 860, show: true, webPreferences: { preload: path.join(DIST, 'preload', 'index.js'), sandbox: true, contextIsolation: true } });
}
async function loadUI(w) {
  await w.loadFile(path.join(DIST, 'renderer', 'index.html'));
  await sleep(600);
}
async function shot(w, name) {
  fs.writeFileSync(path.join(ART, name), (await w.webContents.capturePage()).toPNG());
}
const js = (code) => `(async()=>{${code}})()`;
async function nav(w, label) {
  await w.webContents.executeJavaScript(js(`const n=[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes(${JSON.stringify(label)})); if(n)n.click(); await new Promise(r=>setTimeout(r,300)); return true;`));
}

async function run() {
  await wire();
  let w = makeWindow();
  await loadUI(w);

  // 1) 设置页：配置测试替身 + 探测
  await nav(w, '帮助与设置');
  await sleep(300);
  await shot(w, 'g04-01-settings.png');
  log('配置 test-double', await w.webContents.executeJavaScript(js(`
    const btn=[...document.querySelectorAll('.btn')].find(b=>b.textContent.trim()==='保存配置'); if(btn)btn.click(); await new Promise(r=>setTimeout(r,400));
    const probe=[...document.querySelectorAll('.btn')].find(b=>b.textContent.trim()==='探测'); if(probe)probe.click(); await new Promise(r=>setTimeout(r,500));
    return [...document.querySelectorAll('.notice')].map(n=>n.textContent).join(' || ');
  `)));
  await shot(w, 'g04-02-probe-testdouble.png');

  // 2) 切换 DeepSeek → 探测 BLOCKED（真实联网未授权，不伪造）
  log('切换 deepseek 并探测', await w.webContents.executeJavaScript(js(`
    const sel=document.querySelector('select.search-input'); 
    const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(sel,'deepseek'); sel.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,200));
    const btn=[...document.querySelectorAll('.btn')].find(b=>b.textContent.trim()==='保存配置'); if(btn)btn.click(); await new Promise(r=>setTimeout(r,400));
    const probe=[...document.querySelectorAll('.btn')].find(b=>b.textContent.trim()==='探测'); if(probe)probe.click(); await new Promise(r=>setTimeout(r,500));
    return [...document.querySelectorAll('.notice')].map(n=>n.textContent).join(' || ');
  `)));
  await shot(w, 'g04-03-probe-deepseek-blocked.png');

  // 恢复为 test-double 以做分析
  await w.webContents.executeJavaScript(js(`
    const sel=document.querySelector('select.search-input'); const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(sel,'test-double'); sel.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,150));
    const btn=[...document.querySelectorAll('.btn')].find(b=>b.textContent.trim()==='保存配置'); if(btn)btn.click(); await new Promise(r=>setTimeout(r,300)); return true;
  `));

  // 3) 资料页：导入自拟 txt → 检索 → 用作依据·分析（测试替身）
  await nav(w, '资料');
  const content = '《春》 朱自清\n盼望着，盼望着，东风来了，春天的脚步近了。\n小草偷偷地从土里钻出来，嫩嫩的，绿绿的。';
  await w.webContents.executeJavaScript(js(`
    const dz=document.querySelector('.dropzone'); const dt=new DataTransfer();
    dt.items.add(new File([${JSON.stringify(content)}], '春-分析用.txt', {type:'text/plain'}));
    dz.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
    await new Promise(r=>setTimeout(r,800)); return true;
  `));
  await w.webContents.executeJavaScript(js(`
    const inp=document.querySelector('.search-input'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(inp,'春天的脚步'); inp.dispatchEvent(new Event('input',{bubbles:true}));
    const btn=[...document.querySelectorAll('.btn')].find(b=>b.textContent.trim()==='搜索'); if(btn)btn.click(); await new Promise(r=>setTimeout(r,500)); return true;
  `));
  await shot(w, 'g04-04-search.png');
  log('点击 用作依据·分析', await w.webContents.executeJavaScript(js(`
    const b=[...document.querySelectorAll('.hit .btn')].find(x=>x.textContent.includes('用作依据')); if(b)b.click();
    const t0=Date.now(); while(Date.now()-t0<5000){ if(document.querySelector('.reader-body')) break; await new Promise(r=>setTimeout(r,150)); }
    const head=document.querySelector('.reader-head')?.textContent||''; const body=document.querySelector('.reader-body')?.textContent?.slice(0,80)||'';
    return { head, bodyHead: body };
  `)));
  await shot(w, 'g04-05-analysis-testdouble.png');
  await w.webContents.executeJavaScript(js(`const b=[...document.querySelectorAll('.reader-head .btn')].find(x=>x.textContent.includes('关闭')); if(b)b.click(); return true;`));

  // 4) 权威直连：边界/缓存/真实BLOCKED/作业
  log('边界-未获准片段', await w.webContents.executeJavaScript(js(`
    const s=await window.yuwen.searchSources('春天的脚步'); const h=s.data.hits.find(x=>x.matchKind==='body'&&x.anchor);
    const r=await window.yuwen.modelRun({task:'analyze_text', fragments:[{versionId:h.versionId,charStart:h.anchor.char_start,charEnd:h.anchor.char_end,approved:false}]});
    return {ok:r.ok, code:r.ok?null:r.error.code};
  `)));
  log('缓存-相同分析再次运行', await w.webContents.executeJavaScript(js(`
    const s=await window.yuwen.searchSources('春天的脚步'); const h=s.data.hits.find(x=>x.matchKind==='body'&&x.anchor);
    const frag=[{versionId:h.versionId,charStart:h.anchor.char_start,charEnd:h.anchor.char_end,approved:true}];
    const a=await window.yuwen.modelRun({task:'analyze_text', fragments:frag});
    const b=await window.yuwen.modelRun({task:'analyze_text', fragments:frag});
    return {first:a.data.status, second:b.data.status};
  `)));
  log('真实 deepseek 运行 BLOCKED', await w.webContents.executeJavaScript(js(`
    await window.yuwen.modelConfigure({provider:'deepseek'});
    const s=await window.yuwen.searchSources('春天的脚步'); const h=s.data.hits.find(x=>x.matchKind==='body'&&x.anchor);
    const r=await window.yuwen.modelRun({task:'analyze_text', fragments:[{versionId:h.versionId,charStart:h.anchor.char_start,charEnd:h.anchor.char_end,approved:true}]});
    await window.yuwen.modelConfigure({provider:'test-double'});
    return {ok:r.ok, code:r.ok?null:r.error.code};
  `)));
  log('作业列表(状态)', await w.webContents.executeJavaScript(js(`const r=await window.yuwen.modelListJobs(20); return r.data.jobs.map(j=>({task:j.task,status:j.status,provider:j.provider}));`)));

  // 5) 重启：配置与作业持久化
  w.destroy();
  store.close();
  await sleep(300);
  await wire();
  w = makeWindow();
  await loadUI(w);
  log('重启后配置', await w.webContents.executeJavaScript(js(`const r=await window.yuwen.modelGetConfig(); return r.data.config;`)));
  log('重启后作业数', await w.webContents.executeJavaScript(js(`const r=await window.yuwen.modelListJobs(20); return {count:r.data.jobs.length, statuses:r.data.jobs.map(j=>j.status)};`)));
  await nav(w, '帮助与设置');
  await shot(w, 'g04-06-restart-settings.png');

  fs.writeFileSync(path.join(ART, 'g04-transcript.json'), JSON.stringify(transcript, null, 2));
  console.log('E2E4 DONE userData=' + userData);
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  try {
    await run();
    app.exit(0);
  } catch (e) {
    console.error('E2E4 FAILED', e && e.stack ? e.stack : e);
    app.exit(1);
  }
});
