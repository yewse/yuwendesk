// G03 真实 Electron 端到端驱动（仅测试用，不随产品发布）。
// 使用真实 preload + 真实渲染层 + 真实 IPC/IpcService + 真实 SqliteStore，
// 通过合成 drop 事件注入自拟非敏感文件内容（走真实拖拽代码路径），用 capturePage 截取真实 UI。
// 覆盖：导入 / 去重 / 新版本 / 中文检索(FTS trigram + 短词回退) / 原文精确定位 / 停用 / 重启恢复。
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
const SAMPLES = '/tmp/yuwendesk-samples';
const userData = process.env.E2E_USERDATA || path.join(os.tmpdir(), 'yuwendesk-e2e-' + Date.now());
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

const transcript = [];
function log(step, data) {
  const line = { step, data };
  transcript.push(line);
  console.log('E2E ' + step + ' :: ' + JSON.stringify(data));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let store;
async function wireStore() {
  store = new SqliteStore(userData, { safeStorage });
  await store.load();
  const svc = new IpcService({
    store,
    sourceStore: store,
    appVersion: 'e2e',
    appNameZh: 'e2e',
    platformSupported: true,
    httpListeners: 0,
    online: false,
    buildMode: 'production',
    sandboxEnabled: true,
    platformDevOverride: true,
    platformTargetSupported: true,
    platformIdentity: 'e2e'
  });
  for (const op of IMPLEMENTED_OPERATIONS) {
    ipcMain.removeHandler(`yuwen:${op}`);
    ipcMain.handle(`yuwen:${op}`, async (_e, req) => svc.handle(op, req));
  }
}

function makeWindow() {
  const w = new BrowserWindow({
    width: 1200,
    height: 840,
    show: true,
    webPreferences: {
      preload: path.join(DIST, 'preload', 'index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  return w;
}

async function loadUI(w) {
  await w.loadFile(path.join(DIST, 'renderer', 'index.html'));
  await sleep(600);
}

async function shot(w, name) {
  const img = await w.webContents.capturePage();
  const p = path.join(ART, name);
  fs.writeFileSync(p, img.toPNG());
  return p;
}

const js = (code) => `(async()=>{${code}})()`;

async function gotoResources(w) {
  await w.webContents.executeJavaScript(
    js(`const n=[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes('资料')); if(n)n.click(); await new Promise(r=>setTimeout(r,350)); return !!document.querySelector('.dropzone');`)
  );
}

async function importFile(w, name, content) {
  // 轮询等待提示文案“发生变化”，避免读到 React 提交前的旧消息。
  const res = await w.webContents.executeJavaScript(
    js(`
      const prev=document.querySelector('.dropzone .notice')?.textContent || '';
      const dz=document.querySelector('.dropzone');
      const dt=new DataTransfer();
      dt.items.add(new File([${JSON.stringify(content)}], ${JSON.stringify(name)}, {type:'text/plain'}));
      dz.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
      const t0=Date.now();
      while(Date.now()-t0<6000){ const t=document.querySelector('.dropzone .notice')?.textContent || ''; if(t && t!==prev) break; await new Promise(r=>setTimeout(r,120)); }
      await new Promise(r=>setTimeout(r,150));
      return document.querySelector('.dropzone .notice')?.textContent || '(no-message)';
    `)
  );
  return res;
}

async function search(w, q) {
  // DOM 结果计数 + 权威直连 IPC 计数（后者不受渲染时序影响，作为可信断言）。
  const r = await w.webContents.executeJavaScript(
    js(`
      const inp=document.querySelector('.search-input');
      const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(inp, ${JSON.stringify(q)}); inp.dispatchEvent(new Event('input',{bubbles:true}));
      const btn=[...document.querySelectorAll('.btn')].find(b=>b.textContent.trim()==='搜索'); if(btn)btn.click();
      const auth=await window.yuwen.searchSources(${JSON.stringify(q)});
      const authCount = auth.ok ? auth.data.hits.length : -1;
      const t0=Date.now();
      while(Date.now()-t0<4000){ const dom=document.querySelectorAll('.hit').length; const none=[...document.querySelectorAll('.muted.small')].some(e=>e.textContent.includes('未找到')); if(dom===authCount || (authCount===0 && none)) break; await new Promise(r=>setTimeout(r,120)); }
      await new Promise(r=>setTimeout(r,150));
      return { dom: document.querySelectorAll('.hit').length, ipc: authCount };
    `)
  );
  return r;
}

async function openReader(w) {
  const preview = await w.webContents.executeJavaScript(
    js(`
      const b=[...document.querySelectorAll('.hit .btn')].find(x=>x.textContent.includes('查看原文')); if(b)b.click();
      await new Promise(r=>setTimeout(r,400));
      return document.querySelector('.reader-body')?.textContent?.slice(0,120) || null;
    `)
  );
  return preview;
}
async function closeReader(w) {
  await w.webContents.executeJavaScript(
    js(`const b=[...document.querySelectorAll('.reader-head .btn')].find(x=>x.textContent.includes('关闭')); if(b)b.click(); await new Promise(r=>setTimeout(r,200)); return true;`)
  );
}
async function retireFirst(w) {
  return w.webContents.executeJavaScript(
    js(`
      const b=[...document.querySelectorAll('.src-item .btn')].find(x=>x.textContent.includes('停用')); if(b)b.click();
      await new Promise(r=>setTimeout(r,500));
      return [...document.querySelectorAll('.src-item')].map(li=>li.textContent.replace(/\\s+/g,' ').trim());
    `)
  );
}
async function ipcList(w) {
  return w.webContents.executeJavaScript(js(`const r=await window.yuwen.listSources(); return r;`));
}

async function run() {
  const c1 = fs.readFileSync(path.join(SAMPLES, '春-朱自清.txt'), 'utf8');
  const c1b = fs.readFileSync(path.join(SAMPLES, '春-朱自清-修订版.txt'), 'utf8');
  const cmd = fs.readFileSync(path.join(SAMPLES, '教学任务单.md'), 'utf8');

  await wireStore();
  let w = makeWindow();
  await loadUI(w);
  await gotoResources(w);
  await shot(w, 'g03e2e-01-empty.png');

  log('import#1', await importFile(w, '春-朱自清.txt', c1));
  await shot(w, 'g03e2e-02-import1.png');
  log('import#1-dup', await importFile(w, '春-朱自清.txt', c1)); // 同哈希 → duplicate
  await shot(w, 'g03e2e-03-duplicate.png');
  log('import#2-md', await importFile(w, '教学任务单.md', cmd));
  // 同标题不同内容 → 新版本(versionConflict)：再次导入“春-朱自清.txt”但内容用修订版
  log('import#1-newversion', await importFile(w, '春-朱自清.txt', c1b));
  await shot(w, 'g03e2e-04-newversion.png');
  log('list-after-import', await ipcList(w));

  log('search 春天的脚步 hits', await search(w, '春天的脚步'));
  await shot(w, 'g03e2e-05-search.png');
  log('reader preview', await openReader(w));
  await shot(w, 'g03e2e-06-reader.png');
  await closeReader(w);

  log('search 草 (short-word fallback) hits', await search(w, '草'));
  await shot(w, 'g03e2e-07-shortword.png');
  log('search 量子纠缠 (none) hits', await search(w, '量子纠缠'));
  await shot(w, 'g03e2e-08-noresult.png');

  log('retire-first -> remaining', await retireFirst(w));
  await shot(w, 'g03e2e-09-retired.png');
  log('search 春天的脚步 after retire hits', await search(w, '春天的脚步'));
  await shot(w, 'g03e2e-10-after-retire-search.png');

  // 重启恢复：关闭窗口 + 新建 store(同 userData) + 新窗口
  w.destroy();
  store.close();
  await sleep(300);
  await wireStore();
  w = makeWindow();
  await loadUI(w);
  await gotoResources(w);
  log('restart list', await ipcList(w));
  await shot(w, 'g03e2e-11-restart-list.png');
  log('restart search 教学任务 hits', await search(w, '教学任务'));
  await shot(w, 'g03e2e-12-restart-search.png');

  fs.writeFileSync(path.join(ART, 'g03e2e-transcript.json'), JSON.stringify(transcript, null, 2));
  console.log('E2E DONE userData=' + userData);
}

app.on('window-all-closed', () => {
  /* e2e：销毁窗口做“重启”演示，不让应用自动退出 */
});

app.whenReady().then(async () => {
  try {
    await run();
    app.exit(0);
  } catch (e) {
    console.error('E2E FAILED', e && e.stack ? e.stack : e);
    app.exit(1);
  }
});
