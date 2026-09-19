// G04(真实协议)+G05(课时计划) 端到端（仅测试用）。真实 preload+渲染层+IPC+SqliteStore+ModelService。
// 关键：注入离线 HTTP 传输 + 伪 safeStorage，证明 DeepSeek 真实协议路径经 App IPC 离线跑通（非仅缺密钥）；
// 真实实网仍需授权账户，保持未验证。G05 课时计划经测试替身生成并明确标注测试。
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DIST = path.join(__dirname, '..', 'dist');
const { IpcService } = require(path.join(DIST, 'main', 'ipc.js'));
const { SqliteStore } = require(path.join(DIST, 'main', 'db', 'sqliteStore.js'));
const { ModelService } = require(path.join(DIST, 'main', 'model', 'service.js'));
const { createDeepseekProvider, testDoubleProvider } = require(path.join(DIST, 'main', 'model', 'providers.js'));
const { IMPLEMENTED_OPERATIONS } = require(path.join(DIST, 'shared', 'ipc.js'));

const ART = process.env.E2E_ART || '/opt/cursor/artifacts';
fs.mkdirSync(ART, { recursive: true });
const userData = process.env.E2E_USERDATA || path.join(os.tmpdir(), 'yuwendesk-e2e-g04b-' + Date.now());
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

const transcript = [];
const log = (s, d) => {
  transcript.push({ step: s, data: d });
  console.log('E2EB ' + s + ' :: ' + JSON.stringify(d));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 伪 safeStorage（安全后端）：使密钥保护可用（离线演示）；生产用 electron.safeStorage。
const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('E:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
  decryptString: (b) => Buffer.from(b.toString('utf8').slice(2), 'base64').toString('utf8')
};
// 离线 mock 传输：返回合格 analyze_text JSON（禁止实网）。
const okAnalyze = JSON.stringify({ summary: '春天生机勃勃。', structure: ['盼春', '绘春', '赞春'], rhetoric: ['比喻', '拟人'], teaching_suggestions: ['朗读', '修辞辨析'], citations: [1] });
const mockTransport = async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: okAnalyze } }], usage: { prompt_tokens: 120, completion_tokens: 60 } }) });

let store;
async function wire() {
  store = new SqliteStore(userData, { safeStorage: fakeSafe });
  await store.load();
  const svc = new IpcService({
    store,
    sourceStore: store,
    modelService: new ModelService(store, { providers: { 'test-double': testDoubleProvider, deepseek: createDeepseekProvider(mockTransport) } }),
    appVersion: 'e2eb',
    appNameZh: 'e2eb',
    platformSupported: true,
    httpListeners: 0,
    online: false,
    buildMode: 'production',
    sandboxEnabled: true,
    platformDevOverride: true,
    platformTargetSupported: true,
    platformIdentity: 'e2eb'
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
const js = (c) => `(async()=>{${c}})()`;
async function nav(w, label) {
  await w.webContents.executeJavaScript(js(`const n=[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes(${JSON.stringify(label)})); if(n)n.click(); await new Promise(r=>setTimeout(r,300)); return true;`));
}

async function run() {
  await wire();
  let w = makeWindow();
  await loadUI(w);

  // 配置 test-double（默认）用于 G05 课时计划
  await w.webContents.executeJavaScript(js(`await window.yuwen.modelConfigure({provider:'test-double'}); return true;`));

  // 资料页：导入 → 检索 → 生成课时计划（测试替身，明确标注）
  await nav(w, '资料');
  const content = '《春》 朱自清\n盼望着，盼望着，东风来了，春天的脚步近了。\n小草偷偷地从土里钻出来，嫩嫩的，绿绿的。';
  await w.webContents.executeJavaScript(js(`
    const dz=document.querySelector('.dropzone'); const dt=new DataTransfer();
    dt.items.add(new File([${JSON.stringify(content)}], '春-课时计划用.txt', {type:'text/plain'}));
    dz.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
    await new Promise(r=>setTimeout(r,700));
    const inp=document.querySelector('.search-input'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(inp,'春天的脚步'); inp.dispatchEvent(new Event('input',{bubbles:true}));
    const btn=[...document.querySelectorAll('.btn')].find(b=>b.textContent.trim()==='搜索'); if(btn)btn.click(); await new Promise(r=>setTimeout(r,500)); return true;
  `));
  log('生成课时计划(测试替身)', await w.webContents.executeJavaScript(js(`
    const b=[...document.querySelectorAll('.hit .btn')].find(x=>x.textContent.includes('生成课时计划')); if(b)b.click();
    const t0=Date.now(); while(Date.now()-t0<5000){ if(document.querySelector('.reader-body')) break; await new Promise(r=>setTimeout(r,150)); }
    return { head: document.querySelector('.reader-head')?.textContent||'', bodyHead: document.querySelector('.reader-body')?.textContent?.slice(0,60)||'' };
  `)));
  await shot(w, 'g04b-01-lesson-plan.png');
  await w.webContents.executeJavaScript(js(`const b=[...document.querySelectorAll('.reader-head .btn')].find(x=>x.textContent.includes('关闭')); if(b)b.click(); return true;`));

  // DeepSeek 真实协议经 App IPC 离线跑通（注入 mock 传输 + 授权 + 受保护密钥）
  log('配置 deepseek(密钥+允许联网)', await w.webContents.executeJavaScript(js(`
    const r=await window.yuwen.modelConfigure({provider:'deepseek', apiKey:'sk-offline-demo', allowRealNetwork:true, budgetCapCents:0});
    return {ok:r.ok, keyStored:r.ok?r.data.keyStored:null};
  `)));
  log('deepseek 探测(离线 mock)', await w.webContents.executeJavaScript(js(`const p=await window.yuwen.modelProbe(); return {ok:p.ok, note:p.ok?p.data.note:p.error.message_zh};`)));
  log('deepseek 运行(离线 mock,真实协议路径)', await w.webContents.executeJavaScript(js(`
    const s=await window.yuwen.searchSources('春天的脚步'); const h=s.data.hits.find(x=>x.matchKind==='body'&&x.anchor);
    const r=await window.yuwen.modelRun({task:'analyze_text', fragments:[{versionId:h.versionId,charStart:h.anchor.char_start,charEnd:h.anchor.char_end,approved:true}]});
    return r.ok ? {status:r.data.status, isTestDouble:r.data.result.isTestDouble, provider:r.data.result.provider, cost:r.data.costCents} : {ok:false, code:r.error.code};
  `)));
  await nav(w, '帮助与设置');
  await sleep(300);
  await shot(w, 'g04b-02-settings-deepseek.png');
  log('作业列表', await w.webContents.executeJavaScript(js(`const r=await window.yuwen.modelListJobs(20); return r.data.jobs.map(j=>({task:j.task,provider:j.provider,status:j.status,cost:j.costCents}));`)));

  fs.writeFileSync(path.join(ART, 'g04b-transcript.json'), JSON.stringify(transcript, null, 2));
  console.log('E2EB DONE userData=' + userData);
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  try {
    await run();
    app.exit(0);
  } catch (e) {
    console.error('E2EB FAILED', e && e.stack ? e.stack : e);
    app.exit(1);
  }
});
