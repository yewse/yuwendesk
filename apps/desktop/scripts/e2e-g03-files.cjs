// G03 真实文件（PDF/DOCX）端到端驱动（仅测试用）。真实 preload+渲染层+IPC+SqliteStore。
// 合成拖拽(Phase A) 与 真实文件选择(Phase B，经 CDP DOM.setFileInputFiles 触发真实 <input type=file> onChange) 分别记录。
// 覆盖：结构化定位、版本关系确认、扫描件保留但不可靠检索、隐私阻断、重启恢复。
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
const S = '/tmp/yuwendesk-samples2';
const userData = process.env.E2E_USERDATA || path.join(os.tmpdir(), 'yuwendesk-e2ef-' + Date.now());
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

const transcript = [];
const log = (step, data) => {
  transcript.push({ step, data });
  console.log('E2EF ' + step + ' :: ' + JSON.stringify(data));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let store;
async function wireStore() {
  store = new SqliteStore(userData, { safeStorage });
  await store.load();
  const svc = new IpcService({
    store,
    sourceStore: store,
    appVersion: 'e2ef',
    appNameZh: 'e2ef',
    platformSupported: true,
    httpListeners: 0,
    online: false,
    buildMode: 'production',
    sandboxEnabled: true,
    platformDevOverride: true,
    platformTargetSupported: true,
    platformIdentity: 'e2ef'
  });
  for (const op of IMPLEMENTED_OPERATIONS) {
    ipcMain.removeHandler(`yuwen:${op}`);
    ipcMain.handle(`yuwen:${op}`, async (_e, req) => svc.handle(op, req));
  }
}

function makeWindow() {
  return new BrowserWindow({
    width: 1200,
    height: 860,
    show: true,
    webPreferences: { preload: path.join(DIST, 'preload', 'index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
}
async function loadUI(w) {
  await w.loadFile(path.join(DIST, 'renderer', 'index.html'));
  await sleep(600);
}
async function shot(w, name) {
  fs.writeFileSync(path.join(ART, name), (await w.webContents.capturePage()).toPNG());
}
const js = (code) => `(async()=>{${code}})()`;

async function gotoResources(w) {
  await w.webContents.executeJavaScript(
    js(`const n=[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes('资料')); if(n)n.click(); await new Promise(r=>setTimeout(r,350)); return !!document.querySelector('.dropzone');`)
  );
}

// Phase A：合成拖拽真实文件字节（从磁盘读取 → base64 → 渲染层重建 File → 派发 drop）。
async function dragImport(w, filePath) {
  const name = path.basename(filePath);
  const b64 = fs.readFileSync(filePath).toString('base64');
  return w.webContents.executeJavaScript(
    js(`
      const prev=document.querySelector('.dropzone .notice:last-child')?.textContent||'';
      const bin=Uint8Array.from(atob(${JSON.stringify(b64)}), c=>c.charCodeAt(0));
      const dz=document.querySelector('.dropzone');
      const dt=new DataTransfer();
      dt.items.add(new File([bin], ${JSON.stringify(name)}, {type:'application/octet-stream'}));
      dz.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
      const t0=Date.now();
      while(Date.now()-t0<8000){ const t=[...document.querySelectorAll('.dropzone .notice')].map(n=>n.textContent).join('|'); if(t && t!==prev && !t.includes('导入中')) break; await new Promise(r=>setTimeout(r,150)); }
      await new Promise(r=>setTimeout(r,200));
      return [...document.querySelectorAll('.dropzone .notice')].map(n=>n.textContent).join(' || ');
    `)
  );
}

// Phase B：真实文件选择 —— 经 CDP DOM.setFileInputFiles 把真实磁盘文件放入 <input type=file>，触发真实 onChange。
async function realSelectImport(w, filePath) {
  const dbg = w.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  await dbg.sendCommand('DOM.enable');
  const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1 });
  const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await dbg.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId });
  await sleep(1500);
  dbg.detach();
  return w.webContents.executeJavaScript(
    js(`return [...document.querySelectorAll('.dropzone .notice')].map(n=>n.textContent).join(' || ');`)
  );
}

async function search(w, q) {
  return w.webContents.executeJavaScript(
    js(`
      const inp=document.querySelector('.search-input');
      const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(inp, ${JSON.stringify(q)}); inp.dispatchEvent(new Event('input',{bubbles:true}));
      const btn=[...document.querySelectorAll('.btn')].find(b=>b.textContent.trim()==='搜索'); if(btn)btn.click();
      const auth=await window.yuwen.searchSources(${JSON.stringify(q)});
      await new Promise(r=>setTimeout(r,500));
      const first=document.querySelector('.hit .hit-head'); 
      return { ipc: auth.ok?auth.data.hits.length:-1, firstLabel: first?first.textContent.replace(/\\s+/g,' ').trim():null, locators: auth.ok?auth.data.hits.map(h=>({label:h.locatorLabel,kind:h.locator&&h.locator.kind})):[] };
    `)
  );
}
async function openReader(w) {
  const r = await w.webContents.executeJavaScript(
    js(`const b=[...document.querySelectorAll('.hit .btn')].find(x=>x.textContent.includes('查看原文')); if(b)b.click(); await new Promise(r=>setTimeout(r,400)); return document.querySelector('.reader-body')?.textContent?.slice(0,100)||null;`)
  );
  return r;
}
async function closeReader(w) {
  await w.webContents.executeJavaScript(js(`const b=[...document.querySelectorAll('.reader-head .btn')].find(x=>x.textContent.includes('关闭')); if(b)b.click(); await new Promise(r=>setTimeout(r,200)); return true;`));
}
async function confirmNewVersion(w) {
  return w.webContents.executeJavaScript(
    js(`const b=[...document.querySelectorAll('.confirm-actions .btn')].find(x=>x.textContent.includes('新版本')); if(b)b.click(); await new Promise(r=>setTimeout(r,700)); return document.querySelectorAll('.confirm-box').length;`)
  );
}
async function openVersions(w) {
  return w.webContents.executeJavaScript(
    js(`const b=[...document.querySelectorAll('.src-item .btn')].find(x=>x.textContent.includes('版本')); if(b)b.click(); await new Promise(r=>setTimeout(r,500)); return [...document.querySelectorAll('.ver-item')].map(li=>li.textContent.replace(/\\s+/g,' ').trim());`)
  );
}
async function closeReaderMask(w) {
  await w.webContents.executeJavaScript(js(`const b=[...document.querySelectorAll('.reader-head .btn')].find(x=>x.textContent.includes('关闭')); if(b)b.click(); await new Promise(r=>setTimeout(r,200)); return true;`));
}
async function ipcList(w) {
  return w.webContents.executeJavaScript(js(`const r=await window.yuwen.listSources(); return r.ok?r.data.sources.map(s=>({t:s.title,v:s.version,st:s.status})):null;`));
}
async function privacyProbe(w) {
  return w.webContents.executeJavaScript(
    js(`const r=await window.yuwen.importSource({title:'学生作答(自拟)',format:'txt',content:'自拟占位',classification:'student_sensitive'}); return {ok:r.ok, code:r.ok?null:r.error.code};`)
  );
}

async function run() {
  await wireStore();
  let w = makeWindow();
  await loadUI(w);
  await gotoResources(w);
  await shot(w, 'g03f-01-empty.png');

  log('PhaseA 合成拖拽导入 PDF', await dragImport(w, path.join(S, 'a', '春-课文.pdf')));
  await shot(w, 'g03f-02-dragpdf.png');

  log('PhaseB 真实文件选择导入 DOCX(CDP setFileInputFiles)', await realSelectImport(w, path.join(S, '任务单.docx')));
  await shot(w, 'g03f-03-realselect-docx.png');

  log('导入扫描件PDF(拖拽)', await dragImport(w, path.join(S, '扫描件样例.pdf')));
  log('list', await ipcList(w));
  await shot(w, 'g03f-04-scanned-in-list.png');

  log('检索 春天的脚步 (PDF→页定位)', await search(w, '春天的脚步'));
  await shot(w, 'g03f-05-search-pdf.png');
  log('查看原文', await openReader(w));
  await shot(w, 'g03f-06-reader.png');
  await closeReader(w);

  log('检索 分组朗读 (DOCX段落)', await search(w, '分组朗读'));
  log('检索 第一单元 (DOCX表格单元格)', await search(w, '第一单元'));
  await shot(w, 'g03f-07-search-docx.png');

  log('检索 扫描件唯一词(应无可靠命中)', await search(w, '扫描件样例'));

  // 版本关系：导入同名不同内容 PDF → 需确认 → 作为新版本
  log('导入同名不同内容 PDF(拖拽)', await dragImport(w, path.join(S, 'b', '春-课文.pdf')));
  await shot(w, 'g03f-08-confirm.png');
  log('确认为新版本后剩余待确认数', await confirmNewVersion(w));
  await shot(w, 'g03f-09-after-newversion.png');
  log('版本/来源面板', await openVersions(w));
  await shot(w, 'g03f-10-versions.png');
  await closeReaderMask(w);

  log('隐私阻断探针(敏感分类)', await privacyProbe(w));

  // 重启恢复
  w.destroy();
  store.close();
  await sleep(300);
  await wireStore();
  w = makeWindow();
  await loadUI(w);
  await gotoResources(w);
  log('重启后 list', await ipcList(w));
  await shot(w, 'g03f-11-restart-list.png');
  log('重启后检索 分组朗读', await search(w, '分组朗读'));
  await shot(w, 'g03f-12-restart-search.png');

  fs.writeFileSync(path.join(ART, 'g03f-transcript.json'), JSON.stringify(transcript, null, 2));
  console.log('E2EF DONE userData=' + userData);
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  try {
    await run();
    app.exit(0);
  } catch (e) {
    console.error('E2EF FAILED', e && e.stack ? e.stack : e);
    app.exit(1);
  }
});
