// G05/G06 端到端（仅测试用）：真实 preload+渲染层+IPC+SqliteStore。
// 组建自拟完整课时计划 → 生成三类五文件 → 展示清单（版本一致/角色隔离/内容来源标注）。
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const DIST = path.join(__dirname, '..', 'dist');
const { IpcService } = require(path.join(DIST, 'main', 'ipc.js'));
const { SqliteStore } = require(path.join(DIST, 'main', 'db', 'sqliteStore.js'));
const { IMPLEMENTED_OPERATIONS } = require(path.join(DIST, 'shared', 'ipc.js'));

const ART = process.env.E2E_ART || '/opt/cursor/artifacts';
fs.mkdirSync(ART, { recursive: true });
const userData = path.join(os.tmpdir(), 'yuwendesk-e2e-g06-' + Date.now());
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

const transcript = [];
const log = (s, d) => {
  transcript.push({ step: s, data: d });
  console.log('E2E6 ' + s + ' :: ' + JSON.stringify(d));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let store;
async function wire() {
  store = new SqliteStore(userData, { safeStorage });
  await store.load();
  const svc = new IpcService({ store, sourceStore: store, lessonStore: store, userDataDir: userData, appVersion: 'e2e6', appNameZh: 'e2e6', platformSupported: true, httpListeners: 0, online: false, buildMode: 'production', sandboxEnabled: true, platformDevOverride: true, platformTargetSupported: true, platformIdentity: 'e2e6' });
  for (const op of IMPLEMENTED_OPERATIONS) {
    ipcMain.removeHandler(`yuwen:${op}`);
    ipcMain.handle(`yuwen:${op}`, async (_e, req) => svc.handle(op, req));
  }
}
function makeWindow() {
  return new BrowserWindow({ width: 1200, height: 900, show: true, webPreferences: { preload: path.join(DIST, 'preload', 'index.js'), sandbox: true, contextIsolation: true } });
}
async function shot(w, name) {
  fs.writeFileSync(path.join(ART, name), (await w.webContents.capturePage()).toPNG());
}
const js = (c) => `(async()=>{${c}})()`;

async function run() {
  await wire();
  const w = makeWindow();
  await w.loadFile(path.join(DIST, 'renderer', 'index.html'));
  await sleep(600);
  await w.webContents.executeJavaScript(js(`const n=[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes('我的课程')); if(n)n.click(); await new Promise(r=>setTimeout(r,300)); return true;`));
  await shot(w, 'g06-01-courses-empty.png');
  log('组建自拟课时计划', await w.webContents.executeJavaScript(js(`const b=[...document.querySelectorAll('.btn')].find(x=>x.textContent.includes('组建自拟')); if(b)b.click(); await new Promise(r=>setTimeout(r,600)); return document.querySelector('.notice')?.textContent||'';`)));
  await shot(w, 'g06-02-plan-built.png');
  log('生成三类五文件', await w.webContents.executeJavaScript(js(`const b=[...document.querySelectorAll('.src-item .btn')].find(x=>x.textContent.includes('生成三类五文件')); if(b)b.click(); const t0=Date.now(); while(Date.now()-t0<8000){ if(document.querySelectorAll('.src-item').length>=6) break; await new Promise(r=>setTimeout(r,200)); } return [...document.querySelectorAll('.src-item b')].map(e=>e.textContent);`)));
  await shot(w, 'g06-03-manifest.png');
  // 权威直连：清单 + 版本一致 + 角色隔离（回读文件）
  log('清单', await w.webContents.executeJavaScript(js(`const l=await window.yuwen.lessonList(); const pid=l.data.plans[0].planId; const m=await window.yuwen.materialsGenerate(pid); return {origin:m.data.contentOrigin, stamp:m.data.versionStamp, files:m.data.files.map(f=>f.role+'/'+f.format+':'+f.filename)};`)));
  fs.writeFileSync(path.join(ART, 'g06-transcript.json'), JSON.stringify(transcript, null, 2));
  console.log('E2E6 DONE userData=' + userData);
}
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  try {
    await run();
    app.exit(0);
  } catch (e) {
    console.error('E2E6 FAILED', e && e.stack ? e.stack : e);
    app.exit(1);
  }
});
