import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktop = join(root, 'apps', 'desktop');
const injectedNoReport = process.env.YUWENDESK_G10_TEST_INJECT_NO_REPORT === '1';
const injectedInProgress = process.env.YUWENDESK_G10_TEST_INJECT_IN_PROGRESS === '1';
const testInjection = injectedNoReport || injectedInProgress;
const reportPath =
  testInjection && process.env.YUWENDESK_G10_TEST_REPORT_PATH
    ? process.env.YUWENDESK_G10_TEST_REPORT_PATH
    : join(root, 'reports', 'G10_PERFORMANCE_RAW.json');
const partialPath = `${reportPath}.${process.pid}.partial`;
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const sourceFiles = [
  'apps/desktop/tests/performance/g10-fixture.ts',
  'apps/desktop/tests/performance/g10-core-bench.test.ts',
  'scripts/run-g10-performance.mjs'
];
const sourceHash = createHash('sha256');
for (const relative of sourceFiles) {
  sourceHash.update(relative, 'utf8');
  sourceHash.update('\0');
  sourceHash.update(readFileSync(join(root, relative)));
  sourceHash.update('\0');
}
const benchmarkSourceSha256 = sourceHash.digest('hex');

const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
const repositoryHead = git.status === 0 ? git.stdout.trim() : 'working-tree';
rmSync(partialPath, { force: true });
if (injectedInProgress) {
  writeFileSync(
    partialPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        measurementClass: 'ENGINEERING_MEASUREMENT',
        runStatus: 'IN_PROGRESS',
        updatedAt: new Date().toISOString(),
        repositoryHead,
        repositoryState: 'test-injected interrupted run',
        benchmarkSourceSha256,
        failureCode: null,
        failureStage: null,
        plannedSamples: { sqliteOpen: 30, planOpen: 30, searchPerKind: 30, materialCore: 20 },
        rawSamples: { sqliteOpen: [12.5] },
        rawSamplesPreserved: true,
        outliersRemoved: false
      },
      null,
      2
    )}\n`
  );
}

const result = testInjection
  ? { status: 2, stdout: '', stderr: '', error: undefined }
  : spawnSync(
      process.execPath,
      [vitest, 'run', 'tests/performance/g10-core-bench.test.ts'],
      {
        cwd: desktop,
        env: {
          ...process.env,
          YUWENDESK_G10_PERF: 'full',
          YUWENDESK_G10_PERF_OUTPUT: partialPath,
          YUWENDESK_G10_COMMIT: repositoryHead,
          YUWENDESK_G10_SOURCE_STATE: 'G10-T04 working tree based on repositoryHead; benchmark source bound by SHA-256',
          YUWENDESK_G10_SOURCE_SHA256: benchmarkSourceSha256
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 720_000
      }
    );

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

const failureMarker = (failureCode) => ({
  schemaVersion: 1,
  measurementClass: 'ENGINEERING_MEASUREMENT',
  runStatus: 'FAILED',
  updatedAt: new Date().toISOString(),
  repositoryHead,
  repositoryState: 'G10-T04 working tree based on repositoryHead; benchmark source bound by SHA-256',
  benchmarkSourceSha256,
  failureCode,
  failureStage: null,
  plannedSamples: { sqliteOpen: 30, planOpen: 30, searchPerKind: 30, materialCore: 20 },
  rawSamples: {},
  rawSamplesPreserved: false,
  outliersRemoved: false
});

// 当前轮没有形成 partial 或 partial 损坏时，也以闭集 FAILED 标记替换旧 PASS；绝不静默沿用旧报告。
if (!existsSync(partialPath)) writeFileSync(partialPath, `${JSON.stringify(failureMarker('G10_RUNNER_NO_MEASUREMENT'), null, 2)}\n`);
let report;
try {
  report = JSON.parse(readFileSync(partialPath, 'utf8'));
  if (report.measurementClass !== 'ENGINEERING_MEASUREMENT' || !['COMPLETE', 'IN_PROGRESS', 'FAILED'].includes(report.runStatus)) {
    throw new Error('invalid_report_shape');
  }
} catch {
  report = failureMarker('G10_RUNNER_REPORT_INVALID');
  writeFileSync(partialPath, `${JSON.stringify(report, null, 2)}\n`);
}
if (result.status !== 0 || report.runStatus !== 'COMPLETE') {
  const failureCode =
    report.runStatus === 'FAILED'
      ? report.failureCode ?? 'G10_RUNNER_SUBPROCESS_FAILED'
      : report.runStatus === 'IN_PROGRESS'
        ? 'G10_RUNNER_INTERRUPTED'
        : 'G10_RUNNER_SUBPROCESS_FAILED';
  report = {
    ...report,
    runStatus: 'FAILED',
    updatedAt: new Date().toISOString(),
    failureCode,
    failureStage: report.failureStage ?? null
  };
  writeFileSync(partialPath, `${JSON.stringify(report, null, 2)}\n`);
}
// partial 与目标位于同一目录；先解析验证，再以 rename 原子替换，失败时旧报告不被预先删除。
renameSync(partialPath, reportPath);

const summary = report.metrics
  ? Object.fromEntries(
      Object.entries(report.metrics).map(([name, metric]) => [name, { p50Ms: metric.p50Ms, p95Ms: metric.p95Ms, status: metric.status }])
    )
  : { runStatus: report.runStatus, failureCode: report.failureCode, rawSampleGroups: Object.keys(report.rawSamples ?? {}) };
process.stdout.write(`${JSON.stringify({ report: reportPath, runStatus: report.runStatus, benchmarkSourceSha256, summary }, null, 2)}\n`);

if (result.error) throw result.error;
process.exitCode = result.status === 0 && report.runStatus === 'COMPLETE' ? 0 : result.status && result.status !== 0 ? result.status : 1;
