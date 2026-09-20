# G09 Protection, Recovery, Deletion, and Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement G09-T01–T04 so YuwenDesk can create WAL-consistent credential-free backups, restore portable encrypted archives without damaging current data, encrypt or permanently delete sensitive sources, export minimal diagnostics, and demonstrate security boundaries with failure and attack fixtures.

**Architecture:** Add a focused `protection` domain around the existing SQLite store and app-owned materials directory. Local backups use the SQLite Online Backup API plus manifest-verified files; portable backups wrap a versioned ZIP payload in a calibrated scrypt/AES-256-GCM envelope; restore is staged and switched only during startup with rollback. Source privacy and diagnostics reuse the same fixed-root file, confirmation-token, idempotency, and fault-injection boundaries.

**Tech Stack:** Electron 44, TypeScript 5.5, React 18, better-sqlite3 13, Node `crypto`/`fs`, JSZip 3.10, Vitest 2, existing strict IPC schema gate and preload bridge.

**Spec:** `docs/superpowers/specs/2026-09-20-g09-protection-recovery-design.md`

## Global Constraints

- Do not redo G00–G08 or mutate frozen acceptance case status.
- Use SQLite Online Backup; copying only `yuwendesk.db` is forbidden.
- API keys and `credential` rows never enter local or portable backups.
- Portable archives use calibrated scrypt and AES-256-GCM over the entire ZIP payload; no DPAPI blob is treated as portable.
- Restore validates password, envelope, paths, resource limits, manifest, hashes, schema, free space, and SQLite integrity in a side directory before switching.
- Delete/restore/overwrite confirmation tokens are short-lived, one-time, and issued by the main process for one exact target.
- Sensitive source plaintext never remains in SQLite plaintext tables, FTS, caches, diagnostics, or model requests.
- Diagnostics are previewed, allowlisted, and never uploaded automatically.
- Real API, real student-data authorization, teaching professional review, clean Windows, Office/WPS, signing, and release evidence remain `BLOCKED_EXTERNAL` when unavailable.
- Each work package ends with targeted tests, the full suite, typecheck, lint, contract verification, build, `git diff --check`, `PROGRESS.md`, `HANDOFF.md`, and one small commit.

---

### Task 1: G09-T01 Consistent Local Backup and Portable Encrypted Restore

**Files:**
- Create: `apps/desktop/src/main/protection/types.ts`
- Create: `apps/desktop/src/main/protection/manifest.ts`
- Create: `apps/desktop/src/main/protection/envelope.ts`
- Create: `apps/desktop/src/main/protection/archive.ts`
- Create: `apps/desktop/src/main/protection/backup.ts`
- Create: `apps/desktop/src/main/protection/restore.ts`
- Create: `apps/desktop/src/main/protection/service.ts`
- Create: `apps/desktop/src/renderer/protectionView.ts`
- Create: `apps/desktop/tests/backup-manifest.test.ts`
- Create: `apps/desktop/tests/portable-backup.test.ts`
- Create: `apps/desktop/tests/g09-backup-restore-flow.test.ts`
- Create: `apps/desktop/tests/protectionView.test.ts`
- Modify: `apps/desktop/src/main/db/sqliteStore.ts`
- Modify: `apps/desktop/src/main/store.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/schemaGate.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/shared/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/global.d.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `apps/desktop/tests/ipc.test.ts`
- Modify: `apps/desktop/tests/schemaGate.test.ts`
- Modify: `PROGRESS.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Produces: `SqliteStore.createSanitizedSnapshot(destination, mode): Promise<SnapshotSummary>`.
- Produces: `SqliteStore.exportWorkspaceDataKey(): Buffer` and `SqliteStore.installWorkspaceDataKey(key): void`, both unavailable when `safeStorage` cannot protect the key.
- Produces: `buildBackupManifest(input): BackupManifest` and `verifyBackupManifest(root, manifest, limits): Promise<ManifestCheck>`.
- Produces: `sealPortableArchive(zip, passphrase, kdf): Promise<Buffer>` and `openPortableArchive(container, passphrase, limits): Promise<Buffer>`.
- Produces: `BackupService.createLocal`, `exportPortable`, `list`, `prepareRestore`, `confirmRestore`, `deleteManagedBackup`, and `maybeCreateDaily`.
- Produces: `applyPendingRestoreBeforeOpen(userDataDir, validateOpenedDb): Promise<RestoreSwitchResult>`.
- Produces IPC operations `backup.create`, `backup.restore`, `backups.list`, and `backups.delete`.

- [ ] **Step 1: Write failing manifest and online-snapshot tests**

Create `backup-manifest.test.ts` with a live WAL store, one committed draft written before backup, a later write performed while the online backup is pending, one five-file material bundle, and a fake credential. Assert that the snapshot passes `integrity_check`, includes the pre-backup committed state, excludes the credential value, lists every registered material with exact SHA-256, and fails rather than publishing when a registered file is missing.

Use this shape for the closed manifest:

```ts
const manifest: BackupManifest = {
  format: 'yuwendesk-backup-manifest', version: 1, backupId: 'backup_1',
  kind: 'local', createdAt: '2026-09-20T10:00:00.000Z', appVersion: '0.1.0',
  schemaVersion: SQLITE_SCHEMA_TARGET, retention: ['daily', 'weekly'],
  files: [{ path: 'data/yuwendesk.db', sha256: dbHash, byteSize: dbSize, role: 'database' }],
  sourceDocumentIds: [], credentialExcluded: true
};
expect(validateBackupManifest(manifest)).toEqual([]);
```

- [ ] **Step 2: Run snapshot tests and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/backup-manifest.test.ts
```

Expected: FAIL because the protection domain and snapshot entry are absent.

- [ ] **Step 3: Implement snapshot, manifest, atomic publication, and retention**

Add `SqliteStore.createSanitizedSnapshot` around `this.requireDb().backup(destination)`. Open the destination independently, run `integrity_check`, delete every `credential` row, and for portable mode delete `secure_key` only after `exportWorkspaceDataKey` succeeds. Expose no raw database handle.

`BackupService.createLocal` writes a generated ID under `backups/<id>.partial`, copies only material paths reconstructed from database artifact records and confirmed to remain under `<userData>/materials`, hashes every file, writes the canonical manifest last, verifies the whole directory, then renames to `<id>.ready`. `list()` ignores partial or invalid entries. Retention keeps the newest seven daily labels and four ISO-week labels while refusing to delete the sole valid backup.

- [ ] **Step 4: Run snapshot tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Write failing portable-envelope and hostile-archive tests**

Create `portable-backup.test.ts` with fixed salts/nonces/KDF parameters injected only in tests. Assert round-trip, wrong-passphrase failure, bit flips in header/nonce/ciphertext/tag failure, KDF parameter above the production maximum failure, weak passphrase rejection before KDF, and no plaintext filename/database magic/API key in the outer container.

Create ZIP fixtures for `../escape`, `/absolute`, `C:/drive`, `\\server/share`, duplicate normalized names, backslash traversal, NUL, symlink external attributes, more than 4096 entries, one item above 256 MiB metadata, total expansion above 1 GiB, and compression ratio above 200. Assert `inspectArchive` rejects every fixture before `extractArchive` calls its writer.

- [ ] **Step 6: Run envelope/archive tests and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/portable-backup.test.ts
```

Expected: FAIL because envelope and archive validation are absent.

- [ ] **Step 7: Implement calibrated scrypt, AES-GCM envelope, and fixed-root ZIP handling**

Define a version-1 binary envelope with magic `YWBACKUP`, version, canonical JSON header length/header, ciphertext, and 16-byte tag. The authenticated header contains only `{kdf:{name:'scrypt',N,r,p,salt},cipher:{name:'aes-256-gcm',nonce},payloadBytes}`. Production calibration selects a power-of-two N from 32768–131072 targeting 250ms with `r=8,p=1` and bounded `maxmem`; decoded parameters outside that set fail before KDF.

`archive.ts` normalizes every path to forward slashes, rejects absolute/drive/UNC/NUL/empty/`.`/`..`/duplicate/symlink entries, permits only `manifest.json`, `data/yuwendesk.db`, `keys/workspace-key.json`, and `materials/<safe-id>/<safe-name>`, applies the fixed limits, and extracts only by joining the verified relative path to a caller-supplied staging root.

- [ ] **Step 8: Run envelope/archive tests and verify GREEN**

Run the Step 6 command. Expected: PASS.

- [ ] **Step 9: Write failing restore state-machine and IPC tests**

Create `g09-backup-restore-flow.test.ts` covering:

- portable export contains an encrypted workspace key but no DPAPI blob or credential;
- target `safeStorage` receives the restored data key and the target database contains an empty credential table;
- prepare restore validates first and returns a preview hash without changing current files;
- a forged, expired, reused, wrong-job, or wrong-preview token cannot write `pending-restore.json`;
- confirmed restore writes a marker containing only internal IDs/hashes and returns `restartRequired:true`;
- startup switch moves current data to rollback, installs staging, and retains current data when new-db validation fails;
- successful validation finalizes the new database and materials together;
- wrong password, insufficient free space, over-new schema, corrupted manifest, and interrupted staging leave current data unchanged;
- `.partial` backup is absent from `backups.list`, while same idempotency key replays one result.

Add schema tests requiring mode/action fields and rejecting arbitrary `path`, unknown fields, missing idempotency keys, and malformed confirmation tokens.

- [ ] **Step 10: Run restore/IPC tests and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/g09-backup-restore-flow.test.ts tests/schemaGate.test.ts tests/ipc.test.ts
```

Expected: FAIL because restore coordination and operations are absent.

- [ ] **Step 11: Implement restore coordination, native-dialog callbacks, IPC/preload, and settings UI**

`ProtectionService` accepts main-process callbacks for open/save dialogs and two-stage confirmation. It never accepts a renderer path. `backup.restore` uses payload `{ action:'preview'|'confirm', passphrase?, restoreJobId?, previewHash?, confirmationToken? }`; `backup.create` uses `{ mode:'local'|'portable', passphrase? }`; delete uses `{ backupId, confirmationToken }`. Passphrases are excluded from fingerprints and persistence; the idempotency record stores only operation, archive digest, and result.

Call `applyPendingRestoreBeforeOpen` in `bootstrap` before constructing `SqliteStore`. After a confirmed pending marker, invoke `app.relaunch()` and `app.exit(0)` only from the main-process callback. Add settings cards with exact Chinese copy for password irrecoverability, API reconnect, verified/invalid status, and restart requirement. `protectionView.ts` maps service data to display text without exposing paths or passphrases.

After every successful mutating IPC response, call `BackupCoordinator.noteSuccessfulWrite(operation)` for catalogued business writes. The coordinator coalesces by local date and serializes backup work; backup failure records a maintenance warning but does not change the already-committed business response.

- [ ] **Step 12: Verify, document, and commit G09-T01**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/backup-manifest.test.ts tests/portable-backup.test.ts tests/g09-backup-restore-flow.test.ts tests/protectionView.test.ts tests/ipc.test.ts tests/schemaGate.test.ts
npm run -w @yuwendesk/desktop test:unit
npm run -w @yuwendesk/desktop typecheck
npm run -w @yuwendesk/desktop lint
npm run verify:contracts
npm run -w @yuwendesk/desktop build
git diff --check
```

Update `PROGRESS.md` and `HANDOFF.md` with actual counts, environment, and `BLOCKED_EXTERNAL` items. Commit:

```powershell
git add apps/desktop/src apps/desktop/tests PROGRESS.md HANDOFF.md
git commit -m "feat(G09-T01): add verified encrypted backup recovery"
```

---

### Task 2: G09-T02 Sensitive Reclassification and Complete Local Deletion

**Files:**
- Create: `apps/desktop/src/main/protection/sourcePrivacy.ts`
- Create: `apps/desktop/src/renderer/sourcePrivacyView.ts`
- Create: `apps/desktop/tests/source-privacy.test.ts`
- Create: `apps/desktop/tests/g09-source-delete-flow.test.ts`
- Create: `apps/desktop/tests/sourcePrivacyView.test.ts`
- Modify: `apps/desktop/src/main/crypto/secrets.ts`
- Modify: `apps/desktop/src/main/db/sqliteStore.ts`
- Modify: `apps/desktop/src/main/store.ts`
- Modify: `apps/desktop/src/main/protection/backup.ts`
- Modify: `apps/desktop/src/main/protection/service.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/schemaGate.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/shared/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/global.d.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `PROGRESS.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Produces migration tables `source_sensitive_payload`, `source_tombstone`, and `maintenance_idempotency`.
- Produces `encryptSensitiveSourcePayload`/`decryptSensitiveSourcePayload` using workspace/object/version AAD.
- Produces `SqliteStore.reclassifySource(input): SourceReclassificationResult`.
- Produces `SqliteStore.deleteSourcePermanently(input): SourceDeletionResult`.
- Produces `BackupService.findManagedBackupsContainingSource(documentId)` and `deleteManagedBackups(ids, tokenScope)`.
- Produces IPC `sources.reclassify`, `sources.prepareDelete`, and `sources.delete`.

- [ ] **Step 1: Write failing encryption and reclassification tests**

Create `source-privacy.test.ts` asserting a sensitive import and an ordinary→sensitive reclassification produce a valid `source_sensitive_payload`, random nonces for identical input, AAD containing only internal workspace/document/version IDs, and authenticated failure after ciphertext/nonce/AAD mutation. Search the database bytes and every plaintext table for fixture student name/body; none may contain it after commit.

Assert `source_text`, `source_segment`, `source_fts`, `source_seg_fts`, and `source_file.original_blob` have no row/content for the protected version; source list uses a generic title. Assert model jobs/caches referencing the version are deleted and lesson revisions referencing it become invalid/need source review. A downgrade request returns `PRIVACY_BLOCKED` without decrypting.

- [ ] **Step 2: Run source-privacy tests and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/source-privacy.test.ts
```

Expected: FAIL because sensitive imports are currently blocked and the migration/table do not exist.

- [ ] **Step 3: Implement versioned sensitive payload and atomic promotion**

Add the migration with strict columns for ciphertext, nonce, AAD, algorithm version, plaintext hash, and timestamps. The plaintext payload type is exactly:

```ts
interface SensitiveSourcePayloadV1 {
  version: 1;
  originalBase64: string;
  mime: string;
  fullText: string;
  segments: Array<{ ordinal:number; locatorKind:string; locator:string; text:string; charStart:number; charEnd:number; reliable:boolean }>;
}
```

Create/encrypt it before the SQL transaction. In one `IMMEDIATE` transaction insert the ciphertext, delete both FTS tables and plaintext source rows, null the original blob, replace the title with `学生作品（<internal suffix>）`, update classification, invalidate dependent lesson revisions, delete source-referencing model jobs and derived review/cache rows, update revision, and persist the idempotent result. Add test fault hooks after ciphertext insert, each plaintext cleanup boundary, dependency invalidation, and idempotency insert; every thrown hook must roll back the whole SQL transaction.

- [ ] **Step 4: Run source-privacy tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Write failing permanent-delete, backup-scope, and token tests**

Create `g09-source-delete-flow.test.ts` with ordinary and sensitive multi-version sources. Assert permanent deletion removes source files/text/segments/FTS/sensitive payload/version rows/model jobs/derived records, writes one content-free tombstone, and makes search/read/original/decrypt return no data. Read the tombstone directly and assert it has no title, filename, body, path, ciphertext, or model text.

Assert fault injection before tombstone/idempotency commit restores every original row. Assert token binding to document ID, expected revision, selected managed backup IDs, expiry, and single use. Assert matching managed backups can be deleted and a post-delete local recovery point can be created; an exported portable file is never claimed deleted and appears as `external_or_offline_backups` in the result.

- [ ] **Step 6: Run delete tests and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/g09-source-delete-flow.test.ts
```

Expected: FAIL because permanent source deletion and confirmation flow are absent.

- [ ] **Step 7: Implement complete deletion, backup handling, IPC/preload, and UI**

`sources.prepareDelete` invokes a main-process double-confirm callback and returns a token only after both decisions. The second dialog lists managed backup IDs containing the source, offers delete-managed-backups/create-post-delete-backup policy, states that external exports cannot be recalled, and states that SSD physical erasure is outside the guarantee.

`sources.delete` validates the exact token and expected revision, performs the SQL deletion transaction, then applies the chosen managed-backup policy. If backup removal fails, report actual remaining IDs without rolling back the already-successful database deletion or claiming full backup deletion. `sources.reclassify` accepts only target `student_sensitive` in this package. UI copy and `sourcePrivacyView.ts` render database deletion, managed backup deletion, and external backup scope as separate outcomes.

- [ ] **Step 8: Verify, document, and commit G09-T02**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/source-privacy.test.ts tests/g09-source-delete-flow.test.ts tests/sourcePrivacyView.test.ts tests/ipc-sources.test.ts tests/schemaGate.test.ts
npm run -w @yuwendesk/desktop test:unit
npm run -w @yuwendesk/desktop typecheck
npm run -w @yuwendesk/desktop lint
npm run verify:contracts
npm run -w @yuwendesk/desktop build
git diff --check
```

Update progress/handoff with actual evidence and privacy/professional blockers. Commit:

```powershell
git add apps/desktop/src apps/desktop/tests PROGRESS.md HANDOFF.md
git commit -m "feat(G09-T02): protect reclassified sources and delete local data"
```

---

### Task 3: G09-T03 Minimal Diagnostics and Failure Recovery

**Files:**
- Create: `apps/desktop/src/main/protection/diagnostics.ts`
- Create: `apps/desktop/src/renderer/diagnosticsView.ts`
- Create: `apps/desktop/tests/diagnostics.test.ts`
- Create: `apps/desktop/tests/g09-failure-recovery.test.ts`
- Create: `apps/desktop/tests/diagnosticsView.test.ts`
- Create: `reports/fixtures/g09-diagnostics-sample/README.md`
- Modify: `apps/desktop/src/main/protection/types.ts`
- Modify: `apps/desktop/src/main/protection/service.ts`
- Modify: `apps/desktop/src/main/db/sqliteStore.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/schemaGate.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/shared/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/global.d.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `PROGRESS.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Produces `buildDiagnosticsPreview(input): DiagnosticsPreview` with no free-form source/model content.
- Produces `DiagnosticsService.preview(): {preview,previewHash}` and `save({previewHash,idempotencyKey}): DiagnosticSaveResult`.
- Produces a central `ProtectionFaultHooks` interface used only through constructor injection.
- Produces IPC `diagnostics.export` with actions `preview` and `save`.

- [ ] **Step 1: Write failing diagnostic allowlist and two-phase export tests**

Create `diagnostics.test.ts` using fixtures whose API key, source filename, textbook body, student body, absolute path, prompt, model response, and thrown error message each contain unique canary strings. Assert neither canonical preview JSON nor saved ZIP bytes contain any canary.

The only preview keys are:

```ts
{
  format:'yuwendesk-diagnostics', version:1, generatedAt, appVersion, buildMode,
  platform:{targetSupported,identity,sandboxEnabled},
  storage:{schemaVersion,protected,credentialEncryption,objectCounts},
  maintenance:{validBackups,invalidBackups,lastBackupCode,lastRestoreCode,repeatedFailureCount},
  errors:Array<{code:string,count:number}>,
  network:{automaticUpload:false,localHttpService:'not_started_by_design'}
}
```

Assert `save` with no preview, a stale hash, changed state, arbitrary path, or duplicate key/different digest fails. A valid save produces only `diagnostics.json` and `README.txt`, chosen through an injected main-process path callback, and makes zero network calls.

- [ ] **Step 2: Run diagnostics tests and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/diagnostics.test.ts
```

Expected: FAIL because diagnostics service and IPC are absent.

- [ ] **Step 3: Implement allowlisted preview, atomic ZIP save, and UI**

Build the object field-by-field from bounded counts and enum/error-code aggregates; never spread a database row, Error, model job, source record, environment object, or request. Canonicalize and hash the exact preview. Save to a private `.partial` neighbor and atomically rename only after re-reading and verifying both ZIP entries. Add the two action schemas, named preload calls, and a UI showing the full preview before enabling save. Do not add upload code.

Commit a text fixture description under `reports/fixtures/g09-diagnostics-sample/README.md` containing the preview hash, entry list, command that generated the test artifact, and an explicit note that the binary fixture is generated in a temp directory and not a real-user diagnostic.

- [ ] **Step 4: Run diagnostics tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Write failing cross-operation fault-injection tests**

Create `g09-failure-recovery.test.ts` that injects failures after online snapshot, before manifest rename, after portable key wrap, before pending marker, after current-data rollback move, after sensitive ciphertext insert, after FTS cleanup, during permanent deletion, and before diagnostic rename. For each point assert one of two allowed states only: unchanged current data plus old good backup, or fully completed new state. Assert no `.partial`/staging entry appears usable and no token/idempotency record reports success for a rolled-back action.

Repeat the same automatic daily-backup failure three times and assert the coordinator stops retrying, records `repeatedFailureCount:3`, and preserves a manual retry path. A later manual success clears the consecutive counter without deleting historical error counts.

- [ ] **Step 6: Run recovery tests and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/g09-failure-recovery.test.ts
```

Expected: FAIL until hooks and recovery state are wired consistently.

- [ ] **Step 7: Implement centralized fault hooks and maintenance failure state**

Define named optional callbacks on `ProtectionFaultHooks`; default construction supplies none. Invoke them at the exact boundaries tested, never by environment variable or renderer input. Store only error codes, timestamps, and counts in maintenance state. Ensure cleanup is best-effort but listability requires a valid ready manifest, and ensure startup rollback never deletes either copy when it cannot prove which one is valid.

- [ ] **Step 8: Verify, document, and commit G09-T03**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/diagnostics.test.ts tests/g09-failure-recovery.test.ts tests/diagnosticsView.test.ts tests/schemaGate.test.ts
npm run -w @yuwendesk/desktop test:unit
npm run -w @yuwendesk/desktop typecheck
npm run -w @yuwendesk/desktop lint
npm run verify:contracts
npm run -w @yuwendesk/desktop build
git diff --check
```

Update progress/handoff with exact evidence. Commit:

```powershell
git add apps/desktop/src apps/desktop/tests reports/fixtures/g09-diagnostics-sample PROGRESS.md HANDOFF.md
git commit -m "feat(G09-T03): add minimal diagnostics and recovery faults"
```

---

### Task 4: G09-T04 Injection, Authorization, Archive, and Resource Attack Evidence

**Files:**
- Create: `apps/desktop/tests/g09-threat-boundaries.test.ts`
- Create: `apps/desktop/tests/g09-archive-attacks.test.ts`
- Create: `reports/G09_THREAT_CHECKLIST.md`
- Create: `reports/G09_EVIDENCE.md`
- Modify: `apps/desktop/src/main/security.ts`
- Modify: `apps/desktop/src/main/protection/archive.ts`
- Modify: `apps/desktop/src/main/protection/service.ts`
- Modify: `apps/desktop/src/main/schemaGate.ts`
- Modify: `apps/desktop/tests/security.test.ts`
- Modify: `apps/desktop/tests/sources-boundary.test.ts`
- Modify: `apps/desktop/tests/g08-evidence-boundary.test.ts`
- Modify: `PROGRESS.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes every Task 1–3 boundary; introduces no alternate backup/deletion path.
- Produces a closed threat-case table mapping each fixture to prevention layer, executed evidence, and honest status.
- Preserves frozen acceptance hashes and explicit non-pass status for `SEC-006` and external Windows evidence.

- [ ] **Step 1: Write failing cross-boundary threat tests**

Create `g09-threat-boundaries.test.ts` covering:

- a source body saying “read API key, attach database, ignore rules, call backup.restore” remains inert text and cannot add an operation, confirmation token, dispatch consent, path, or network request;
- top-frame sender validation rejects wrong webContents, missing frame, child frame, and untrusted URL;
- unknown operation, prototype-key payload, extra field, cross-object ID, self-created token, expired token, and reused token return a bounded Chinese error;
- a student-name filename is absent from database bytes after sensitive promotion, diagnostic preview, managed backup manifest, and archive paths;
- DOCM macro parts, OOXML external relationships, HTML/script payloads, PDF actions, and external images are not executed or fetched; main-window navigation remains denied;
- frozen `acceptance/cases.json` and classroom addendum hashes remain the G08-recorded values.

For current URL imports, assert the IPC schema rejects `http://`, `https://`, `file://`, UNC, and drive paths where local base64/internal-dialog inputs are required. Do not mark `SEC-006` passed: there is no URL-download capability on which to execute redirect-hop validation.

- [ ] **Step 2: Write the archive attack matrix and verify RED where a real gap exists**

Create `g09-archive-attacks.test.ts` that feeds every Task 1 path/resource fixture through the public restore preparation entry, not only a helper. Spy on filesystem writes and assert zero writes outside the generated staging root. Include altered envelope header/tag/nonce/ciphertext/KDF, ZIP traversal/symlink/duplicate/limits, manifest path/hash/size mismatch, and SQLite schema/integrity failures.

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/g09-threat-boundaries.test.ts tests/g09-archive-attacks.test.ts tests/security.test.ts tests/sources-boundary.test.ts
```

Expected: at least one new regression assertion fails until all public-entry guards and error mappings are complete. If all pass immediately, record that result and add no production change merely to manufacture RED; TDD applies to behavior gaps, not documentation-only evidence.

- [ ] **Step 3: Close only demonstrated production gaps**

Map every failing fixture to the narrowest existing boundary: sender/navigation in `security.ts`, payload shape in `schemaGate.ts`, archive paths/limits in `archive.ts`, and token/object scope in `ProtectionService`. Return `INPUT_INVALID`, `PRIVACY_BLOCKED`, `BACKUP_INVALID`, or `OS_UNSUPPORTED` as appropriate without echoing hostile content, paths, secrets, or stack traces. Do not add a URL downloader.

- [ ] **Step 4: Run the complete G09 security and regression set**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/backup-manifest.test.ts tests/portable-backup.test.ts tests/g09-backup-restore-flow.test.ts tests/source-privacy.test.ts tests/g09-source-delete-flow.test.ts tests/diagnostics.test.ts tests/g09-failure-recovery.test.ts tests/g09-threat-boundaries.test.ts tests/g09-archive-attacks.test.ts tests/security.test.ts tests/sources-boundary.test.ts tests/g08-evidence-boundary.test.ts
npm run -w @yuwendesk/desktop test:unit
npm run -w @yuwendesk/desktop typecheck
npm run -w @yuwendesk/desktop lint
npm run verify:contracts
npm run -w @yuwendesk/desktop build
git diff --check
```

Expected: every executed command exits 0. Record actual counts and existing skips; do not copy G08 counts.

- [ ] **Step 5: Write threat/evidence reports with honest statuses**

`reports/G09_THREAT_CHECKLIST.md` contains one row per `INS-008`, `SEC-003`–`SEC-010`, and `DAT-001`–`DAT-006`, with threat, prevention layer, fixture/command, observed result, and one of `ENGINEERING_VERIFIED`, `NOT_RUN`, `NOT_APPLICABLE_CURRENT_CAPABILITY`, or `BLOCKED_EXTERNAL`.

`reports/G09_EVIDENCE.md` records commit baseline, OS/Node/npm/Vitest/TypeScript versions, exact commands and exit codes, test counts, frozen acceptance hashes, deterministic fixture identities, and separate blockers for clean Windows listener inspection, real cross-machine Windows restore, real student-data privacy authorization, real API, teaching professional review, Office/WPS, signing, and release.

Keep `SEC-006` `NOT_RUN` with the explicit reason “URL download is not an exposed capability; redirect-hop integration is required before enabling it.” Keep Windows process/socket acceptance `BLOCKED_EXTERNAL`; code review and non-Windows process checks are not substitutes.

- [ ] **Step 6: Update handoff and commit G09-T04**

Update `PROGRESS.md` to mark the local engineering scope of all four G09 packages complete without changing frozen acceptance statuses. Update `HANDOFF.md` with G09 commits, verification evidence, external blockers, and G10 as the next package. Commit:

```powershell
git add apps/desktop/src apps/desktop/tests reports/G09_THREAT_CHECKLIST.md reports/G09_EVIDENCE.md PROGRESS.md HANDOFF.md
git commit -m "test(G09-T04): verify protection threat boundaries"
```

## Final Branch Review

After Task 4, use `superpowers:verification-before-completion` and `superpowers:requesting-code-review`. Confirm:

```powershell
git status --short --branch
git log --oneline --decorate -10
git diff --check
```

Do not merge, push, or create a pull request without explicit user authorization. The existing user choice is inline execution, so proceed with `superpowers:executing-plans` after committing this plan; do not ask for the execution mode again.
