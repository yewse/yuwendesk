import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  G10_FIXTURE_SPEC,
  nearestRankPercentile,
  runG10CoreBenchmark,
  seedG10PerformanceFixture,
  type G10PerformanceFixture
} from './g10-fixture';

const fixtureRoot = join(tmpdir(), `yuwendesk-g10-performance-${process.pid}-${Date.now()}`);
let fixture: G10PerformanceFixture;

beforeAll(async () => {
  fixture = await seedG10PerformanceFixture(fixtureRoot);
}, 120_000);

afterAll(() => {
  fixture?.store.close();
  if (resolve(fixtureRoot).startsWith(resolve(tmpdir()))) rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('G10-T04 固定性能夹具', () => {
  it('固定种子生成 100 个计划、5000 个来源片段和约定五文件样本', () => {
    expect(G10_FIXTURE_SPEC).toMatchObject({ seed: 20260920, planCount: 100, sourceSegmentCount: 5000 });
    expect(fixture.counts()).toEqual({ plans: 100, sourceSegments: 5000 });
    expect(fixture.planIds).toHaveLength(100);
    expect(fixture.exportPlan.tasks).toHaveLength(9);
  });

  it('nearest-rank P50/P95 保留全部原始样本且不删除离群值', () => {
    const raw = [1, 2, 3, 4, 100];
    expect(nearestRankPercentile(raw, 50)).toBe(3);
    expect(nearestRankPercentile(raw, 95)).toBe(100);
    expect(raw).toEqual([1, 2, 3, 4, 100]);
  });

  it('中途失败仍保存已完成的原始样本并标记 FAILED，不保留旧 PASS', async () => {
    const output = join(fixtureRoot, 'failed-run.json');
    await expect(
      runG10CoreBenchmark(fixture, {
        sqliteOpenSamples: 1,
        planOpenSamples: 1,
        searchSamplesPerKind: 1,
        exportSamples: 1,
        progressOutputPath: output,
        faultAfterSample: { stage: 'planOpen', completed: 1 }
      })
    ).rejects.toThrow('g10_injected_benchmark_failure');

    const failed = JSON.parse(readFileSync(output, 'utf8')) as {
      runStatus: string;
      failureStage: string;
      rawSamples: { sqliteOpen: number[]; planOpen: number[]; materialGenerateAndReview: number[] };
    };
    expect(failed.runStatus).toBe('FAILED');
    expect(failed.failureStage).toBe('planOpen');
    expect(failed.rawSamples.sqliteOpen).toHaveLength(1);
    expect(failed.rawSamples.planOpen).toHaveLength(1);
    expect(failed.rawSamples.materialGenerateAndReview).toEqual([]);
  });

  it('runner 在没有 partial 时用本轮 FAILED 标记替换旧 PASS 并返回失败', () => {
    const output = join(fixtureRoot, 'runner-failure.json');
    writeFileSync(output, '{"measurementClass":"ENGINEERING_MEASUREMENT","runStatus":"COMPLETE","stale":true}\n');
    const runner = resolve(__dirname, '../../../../scripts/run-g10-performance.mjs');
    const result = spawnSync(process.execPath, [runner], {
      cwd: resolve(__dirname, '../../../..'),
      env: {
        ...process.env,
        YUWENDESK_G10_TEST_INJECT_NO_REPORT: '1',
        YUWENDESK_G10_TEST_REPORT_PATH: output
      },
      encoding: 'utf8',
      windowsHide: true
    });

    expect(result.status).not.toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
      measurementClass: 'ENGINEERING_MEASUREMENT',
      runStatus: 'FAILED',
      failureCode: 'G10_RUNNER_NO_MEASUREMENT'
    });
  });

  it('runner 对非零退出时遗留的 IN_PROGRESS 保留样本并归一化为 FAILED', () => {
    const output = join(fixtureRoot, 'runner-interrupted.json');
    const runner = resolve(__dirname, '../../../../scripts/run-g10-performance.mjs');
    const result = spawnSync(process.execPath, [runner], {
      cwd: resolve(__dirname, '../../../..'),
      env: {
        ...process.env,
        YUWENDESK_G10_TEST_INJECT_IN_PROGRESS: '1',
        YUWENDESK_G10_TEST_REPORT_PATH: output
      },
      encoding: 'utf8',
      windowsHide: true
    });

    expect(result.status).not.toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
      measurementClass: 'ENGINEERING_MEASUREMENT',
      runStatus: 'FAILED',
      failureCode: 'G10_RUNNER_INTERRUPTED',
      rawSamples: { sqliteOpen: [12.5] }
    });
  });

  it('在 Node 工程测量中执行 SQLite 打开、计划读取、长短中文搜索和五文件生成/复核', async () => {
    const full = process.env.YUWENDESK_G10_PERF === 'full';
    const output = process.env.YUWENDESK_G10_PERF_OUTPUT;
    const report = await runG10CoreBenchmark(fixture, {
      sqliteOpenSamples: full ? 30 : 2,
      planOpenSamples: full ? 30 : 3,
      searchSamplesPerKind: full ? 30 : 3,
      exportSamples: full ? 20 : 1,
      progressOutputPath: full ? output : undefined
    });

    if (full && output) {
      // benchmark 自己逐样本落盘；返回时应已写为 COMPLETE。
      expect(existsSync(output)).toBe(true);
      expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
        measurementClass: 'ENGINEERING_MEASUREMENT',
        runStatus: 'COMPLETE'
      });
    }

    expect(report.measurementClass).toBe('ENGINEERING_MEASUREMENT');
    expect(report.fixture).toMatchObject({ planCount: 100, sourceSegmentCount: 5000 });
    expect(report.metrics.planOpen.status).toBe('PASS');
    expect(report.metrics.searchLong.status).toBe('PASS');
    expect(report.metrics.searchShort.status).toBe('PASS');
    expect(report.metrics.searchMixed.status).toBe('PASS');
    expect(report.metrics.materialGenerateAndReview.status).toBe('ENGINEERING_CORE_WITHIN_BUDGET');
    expect(report.metrics.materialGenerateAndReview.rawMs).toHaveLength(full ? 20 : 1);
    expect(report.external.formalPackageExport.status).toBe('NOT_RUN/BLOCKED_EXTERNAL');
    expect(report.external.electronColdStart.status).toBe('NOT_RUN/BLOCKED_EXTERNAL');
    expect(report.external.officeWpsPagination.status).toBe('NOT_RUN/BLOCKED_EXTERNAL');
  }, 660_000);
});
