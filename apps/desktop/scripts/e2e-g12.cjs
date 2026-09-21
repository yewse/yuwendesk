// G12 纵向 Electron 验收驱动：只使用合成资料和命名 preload API。
// 输出是无路径、无提示词、无密钥的 JSON；它本身不改变冻结验收案例状态。
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUTPUT = process.env.E2E_G12_OUTPUT || path.join(ROOT, 'release', 'acceptance', 'g12-e2e.json');
const CANDIDATE_RELATIVE = 'apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe';
const CANDIDATE = path.join(ROOT, 'release', 'YuwenDesk-Setup-0.1.0-x64.exe');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'yuwendesk-g12-'));
app.setPath('userData', userData);

const { IpcService } = require(path.join(DIST, 'main', 'ipc.js'));
const { SqliteStore } = require(path.join(DIST, 'main', 'db', 'sqliteStore.js'));
const { PreparationService, exportPreparedMaterials } = require(path.join(DIST, 'main', 'preparation', 'service.js'));
const { PresentationService } = require(path.join(DIST, 'main', 'presentation', 'service.js'));
const { IMPLEMENTED_OPERATIONS } = require(path.join(DIST, 'shared', 'ipc.js'));

let store;
let presentationWindow = null;
let mainWindow = null;

function makeWindow(query) {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    show: false,
    webPreferences: {
      preload: path.join(DIST, 'preload', 'index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  return window.loadFile(path.join(DIST, 'renderer', 'index.html'), query ? { query } : undefined).then(() => window);
}

async function wire() {
  store = new SqliteStore(userData, { safeStorage });
  await store.load();
  const preparationService = new PreparationService({
    store,
    exportPlan: (planId) => exportPreparedMaterials(store, path.join(userData, 'materials'), planId)
  });
  const presentationService = new PresentationService(store);
  const service = new IpcService({
    store,
    sourceStore: store,
    lessonStore: store,
    preparationStore: store,
    preparationService,
    presentationService,
    openPresentation: (sessionId) => {
      if (presentationWindow && !presentationWindow.isDestroyed()) {
        presentationWindow.focus();
        return { opened: true, reused: true };
      }
      void makeWindow({ presentationSession: sessionId }).then((window) => {
        presentationWindow = window;
      });
      return { opened: true, reused: false };
    },
    closePresentation: () => {
      if (!presentationWindow || presentationWindow.isDestroyed()) return false;
      presentationWindow.close();
      return true;
    },
    userDataDir: userData,
    appVersion: 'g12-e2e',
    appNameZh: 'G12 E2E',
    platformSupported: true,
    httpListeners: 0,
    online: false,
    buildMode: 'production',
    sandboxEnabled: true,
    platformDevOverride: false,
    platformTargetSupported: true,
    platformIdentity: 'win11'
  });
  for (const operation of IMPLEMENTED_OPERATIONS) {
    ipcMain.removeHandler(`yuwen:${operation}`);
    ipcMain.handle(`yuwen:${operation}`, (_event, request) => service.handle(operation, request));
  }
}

const runIn = (window, body) => window.webContents.executeJavaScript(`(async()=>{${body}})()`);

function sourceCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.join(ROOT, '..', '..'),
    encoding: 'utf8',
    shell: false,
    windowsHide: true
  });
  if (result.status !== 0) throw new Error('source-commit');
  return result.stdout.trim();
}

function candidateDescriptor() {
  const bytes = fs.readFileSync(CANDIDATE);
  return {
    path: CANDIDATE_RELATIVE,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength
  };
}

async function run() {
  const startedAt = new Date().toISOString();
  const commit = sourceCommit();
  const candidate = candidateDescriptor();
  await wire();
  mainWindow = await makeWindow();
  const first = await runIn(mainWindow, `
    const key=(s)=>s+'-'+crypto.randomUUID();
    const imported=await window.yuwen.importSource({title:'合成教材节选',format:'txt',content:'合成材料：一则消息应交代时间、地点、人物、事件的起因、经过和结果。'});
    if(!imported.ok||!imported.data.versionId) throw new Error('import');
    const read=await window.yuwen.readSource(imported.data.versionId);
    const bytes=new TextEncoder().encode(read.data.text);
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    const hash=[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
    const saved=await window.yuwen.preparationContextSave({classDisplayName:'八年级合成班',grade:'grade8',textbookTitle:'合成语文教材',textbookEdition:'测试版',unitTitle:'消息单元',lessonTitle:'消息要素',durationSec:2700,notes:'仅用于自动化验收'},0,key('context'));
    if(!saved.ok) throw new Error('context');
    const created=await window.yuwen.preparationSessionCreate(saved.data.context.contextId,'local_authored',key('session'));
    const selected=await window.yuwen.preparationSourcesSet(created.data.session.sessionId,[{ordinal:0,sourceVersionId:imported.data.versionId,charStart:0,charEnd:read.data.text.length,purpose:'textbook',approvedForModel:false,textSha256:hash}],created.data.session.revision,key('sources'));
    const built=await window.yuwen.preparationBuild({sessionId:selected.data.session.sessionId,focus:'识别消息六要素',coreTask:'依据合成材料概括消息六要素。',answerScope:'只接受能由所选材料支持的回答。'},selected.data.session.revision,key('build'));
    const reviewed=await window.yuwen.preparationReview(built.data.session.sessionId,built.data.session.revision,key('review'));
    const confirmed=await window.yuwen.preparationConfirm(built.data.session.sessionId,reviewed.data.session.revision,key('confirm'));
    const exported=await window.yuwen.preparationExport(built.data.session.sessionId,confirmed.data.session.revision,key('export'));
    const resumed=await window.yuwen.preparationResume(built.data.session.sessionId);
    const opened=await window.yuwen.presentationOpen(built.data.session.sessionId);
    return {sessionId:built.data.session.sessionId,planId:resumed.data.session.planId,revisionId:resumed.data.session.revisionId,bundleId:exported.data.session.bundleId,artifactCount:resumed.data.artifacts.length,reviewDisposition:resumed.data.report.disposition,presentationOpened:opened.ok,presentationError:opened.ok?null:opened.error.code};
  `);
  const deadline = Date.now() + 10000;
  while ((!presentationWindow || presentationWindow.isDestroyed()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!presentationWindow || presentationWindow.isDestroyed()) {
    const session = store.getPreparationSession(first.sessionId);
    const current = session?.planId ? store.getLessonRevision(session.planId) : null;
    const report = session?.planId && session.revisionId ? store.getLatestReviewReport(session.planId, session.revisionId) : null;
    const sourceState = session?.sources.map((source) => store.getVersionMeta(source.sourceVersionId)) ?? [];
    throw new Error(`presentation-window:${JSON.stringify({
      presentationError: first.presentationError,
      status: session?.status ?? null,
      currentMatches: current?.revisionId === session?.revisionId,
      reportMatches: report?.reportId === session?.reviewReportId,
      disposition: report?.report.disposition ?? null,
      sourceActiveCurrent: sourceState.every((item) => item?.status === 'active' && item.isCurrent)
    })}`);
  }
  const reveal = await runIn(presentationWindow, `
    const deadline=Date.now()+5000;
    while(!document.querySelector('.presentation-slide')&&Date.now()<deadline) await new Promise(r=>setTimeout(r,80));
    const answer=[...document.querySelectorAll('button')].find(button=>button.textContent.includes('显示答案'));
    if(!answer) throw new Error('answer-control');
    answer.click();
    await new Promise(r=>setTimeout(r,100));
    return {taskVisible:!!document.querySelector('.presentation-prompt'),answerVisible:!!document.querySelector('.presentation-reveal.answer')};
  `);
  const changed = await runIn(mainWindow, `
    const lesson=await window.yuwen.lessonGet(${JSON.stringify(first.planId)});
    const task=lesson.data.plan.tasks[0];
    const change={kind:'edit_task',taskId:task.task_id,prompt:task.prompt+'（先独立作答）',acceptableVariants:['答案需有合成材料依据。']};
    const preview=await window.yuwen.changePreview(lesson.data.plan.plan_id,lesson.data.plan.revision_id,change);
    if(!preview.ok) throw new Error('change-preview');
    const applied=await window.yuwen.changeApply(lesson.data.plan.plan_id,lesson.data.plan.revision_id,change,'change-'+crypto.randomUUID());
    if(!applied.ok||applied.data.result.status!=='succeeded') throw new Error('change-apply');
    return {revisionId:applied.data.result.revisionId,bundleId:applied.data.result.bundleId,fileCount:applied.data.result.files.length};
  `);
  if (presentationWindow && !presentationWindow.isDestroyed()) presentationWindow.destroy();
  mainWindow.destroy();
  store.close();
  await wire();
  mainWindow = await makeWindow();
  const restarted = await runIn(mainWindow, `
    const resumed=await window.yuwen.preparationResume(${JSON.stringify(first.sessionId)});
    return {ok:resumed.ok,status:resumed.ok?resumed.data.session.status:null,planId:resumed.ok?resumed.data.session.planId:null,revisionId:resumed.ok?resumed.data.session.revisionId:null,bundleId:resumed.ok?resumed.data.session.bundleId:null};
  `);
  const sqliteIntegrity = store.withTransaction((database) => String(database.pragma('integrity_check', { simple: true })));
  const observations = {
    artifactCount: first.artifactCount,
    reviewDisposition: first.reviewDisposition,
    presentationOpened: first.presentationOpened,
    taskVisible: reveal.taskVisible,
    answerVisible: reveal.answerVisible,
    changedFileCount: changed.fileCount,
    restartStatus: restarted.status,
    revisionAdvanced: changed.revisionId !== first.revisionId && restarted.revisionId === changed.revisionId,
    bundleAdvanced: changed.bundleId !== first.bundleId && restarted.bundleId === changed.bundleId,
    sqliteIntegrity
  };
  const passed = observations.artifactCount === 5 && observations.reviewDisposition === 'ready_for_teacher' &&
    observations.presentationOpened && observations.taskVisible && observations.answerVisible &&
    observations.changedFileCount === 5 && observations.restartStatus === 'EXPORTED' &&
    observations.revisionAdvanced && observations.bundleAdvanced && observations.sqliteIntegrity === 'ok';
  const result = {
    schemaVersion: 1,
    sourceCommit: commit,
    startedAt,
    completedAt: new Date().toISOString(),
    candidate,
    environment: {
      os: os.platform(),
      release: os.release(),
      arch: os.arch(),
      electron: process.versions.electron
    },
    syntheticDataOnly: true,
    frozenAcceptanceCasesUpdated: false,
    observations,
    passed
  };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2) + '\n', 'utf8');
  if (!passed) throw new Error('g12-e2e-assertion');
  process.stdout.write(JSON.stringify({ passed: true, artifactCount: 5, changedFileCount: 5 }) + '\n');
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  try {
    await run();
    app.exit(0);
  } catch (error) {
    process.stderr.write(`G12 E2E failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
    app.exit(1);
  }
});
