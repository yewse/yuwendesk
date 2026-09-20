import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import { SqliteStore } from '../../src/main/db/sqliteStore';
import { buildLessonPlan, demoLessonSpec } from '../../src/main/lesson/build';
import type { LessonPlan } from '../../src/main/lesson/types';
import { buildMaterialSet } from '../../src/main/materials/generate';
import { reviewMaterialSet } from '../../src/main/review/bundleReview';

export const G10_FIXTURE_SPEC = Object.freeze({
  version: 'g10-performance-v1',
  seed: 20260920,
  planCount: 100,
  sourceSegmentCount: 5000,
  longQuery: '固定检索长词',
  shortQuery: '春',
  expectedFiles: 5,
  expectedPresentationSlides: 20,
  targetDocxPages: 10
});

export type MetricStatus =
  | 'PASS'
  | 'FAIL'
  | 'MEASURED_NO_RELEASE_THRESHOLD'
  | 'ENGINEERING_CORE_WITHIN_BUDGET'
  | 'ENGINEERING_CORE_OVER_BUDGET';

export type G10BenchmarkStage =
  | 'sqliteWarmup'
  | 'sqliteOpen'
  | 'planOpen'
  | 'searchLong'
  | 'searchShort'
  | 'materialGenerate'
  | 'materialReview'
  | 'artifactProfile';

export interface G10Metric {
  rawMs: number[];
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  thresholdMs: number | null;
  status: MetricStatus;
}

export interface G10PerformanceReport {
  schemaVersion: 1;
  measurementClass: 'ENGINEERING_MEASUREMENT';
  runStatus: 'COMPLETE';
  measuredAt: string;
  repositoryHead: string;
  repositoryState: string;
  benchmarkSourceSha256: string;
  environment: {
    platform: string;
    release: string;
    arch: string;
    node: string;
    electron: string | null;
    logicalCpuCount: number;
    cpuModel: string;
    totalMemoryBytes: number;
  };
  fixture: {
    version: string;
    seed: number;
    planCount: number;
    sourceSegmentCount: number;
    containsRealData: false;
    exportArtifactProfile: {
      expectedFiles: 5;
      expectedPresentationSlides: 20;
      targetDocxPages: 10;
      docxPaginationVerification: 'NOT_RUN/BLOCKED_EXTERNAL';
    };
  };
  methodology: {
    percentile: 'nearest-rank';
    rawSamplesPreserved: true;
    outliersRemoved: false;
    sqliteOpenIncludes: 'SqliteStore.load + close';
    exportIncludes: 'five-file generation + deterministic consistency review';
    qualification: string;
    cacheState: string;
  };
  metrics: {
    sqliteOpen: G10Metric;
    planOpen: G10Metric;
    searchLong: G10Metric;
    searchShort: G10Metric;
    searchMixed: G10Metric;
    materialGenerate: G10Metric;
    materialReview: G10Metric;
    materialGenerateAndReview: G10Metric;
  };
  memory: {
    nodeRssBeforeBytes: number;
    nodeRssAfterBytes: number;
    status: 'MEASURED_NO_RELEASE_THRESHOLD';
    qualification: string;
  };
  external: {
    electronColdStart: { status: 'NOT_RUN/BLOCKED_EXTERNAL'; target: 'P95<=8000ms, Win11 8GB SSD, 30 runs' };
    electronIdleMemory: { status: 'NOT_RUN/BLOCKED_EXTERNAL'; target: '<=700MB total Electron processes' };
    targetWindowsHardware: { status: 'NOT_RUN/BLOCKED_EXTERNAL' };
    formalPackageExport: {
      status: 'NOT_RUN/BLOCKED_EXTERNAL';
      target: 'approximately 10-page DOCX and 20-slide deck, measured separately with publish I/O';
    };
    officeWpsPagination: { status: 'NOT_RUN/BLOCKED_EXTERNAL'; target: 'approximately 10-page DOCX' };
  };
}

export interface G10BenchmarkOptions {
  sqliteOpenSamples: number;
  planOpenSamples: number;
  searchSamplesPerKind: number;
  exportSamples: number;
  progressOutputPath?: string;
  faultAfterSample?: { stage: G10BenchmarkStage; completed: number };
}

export interface G10PerformanceFixture {
  root: string;
  dbPath: string;
  store: SqliteStore;
  planIds: string[];
  exportPlan: LessonPlan;
  counts(): { plans: number; sourceSegments: number };
  writeReport(path: string, report: G10PerformanceReport): void;
}

function fixedId(prefix: string, index: number): string {
  return `${prefix}_${String(index).padStart(4, '0')}`;
}

function fixedRandom(): () => number {
  let state = G10_FIXTURE_SPEC.seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function sourceContent(): string {
  const random = fixedRandom();
  const actions = ['朗读', '比较', '解释', '修订'] as const;
  return Array.from({ length: G10_FIXTURE_SPEC.sourceSegmentCount }, (_, index) => {
    const serial = String(index + 1).padStart(4, '0');
    const action = actions[Math.floor(random() * actions.length)];
    return `虚构性能资料第${serial}段：春的课堂${action}固定检索长词，序号${serial}，不含真实教材或学生数据。`;
  }).join('\n');
}

function makeExportPlan(sourceVersionId: string, planIndex: number): LessonPlan {
  const base = demoLessonSpec({
    plan_id: fixedId('plan_perf', planIndex),
    title: `虚构性能课时 ${String(planIndex).padStart(3, '0')}`,
    declared_duration_sec: 45 * 60,
    task_context_id: 'ctx_synthetic_performance',
    anchors: [
      {
        source_version_id: sourceVersionId,
        locator: { line: 1 },
        quote: '虚构性能资料：春的课堂阅读固定检索长词。',
        source_class: 'teacher_private',
        verification: 'exact_checked'
      }
    ],
    tasks: Array.from({ length: 9 }, (_, index) => ({
      prompt: `虚构任务 ${index + 1}：结合锚点完成阅读、比较与修订，不使用真实学生信息。`,
      cognitive_demand: index % 3 === 0 ? 'compare' : index % 3 === 1 ? 'explain' : 'create',
      support_level: 'independent' as const,
      teacher_notes: `虚构追问 ${index + 1}：说明依据与修改理由。`,
      acceptable_variants: [
        `虚构合理答案 ${index + 1}A：引用锚点并解释。`,
        `虚构合理答案 ${index + 1}B：允许有证据的不同表达。`
      ],
      insufficient_examples: [`虚构不足示例 ${index + 1}：只有结论没有依据。`],
      anchorIndexes: [1]
    })),
    activities: Array.from({ length: 9 }, (_, index) => ({
      title: `虚构活动 ${index + 1}`,
      start_sec: index * 300,
      end_sec: (index + 1) * 300,
      actor: index % 2 === 0 ? ('student' as const) : ('both' as const),
      student_action: `完成虚构任务 ${index + 1} 并记录依据。`,
      teacher_action: `巡视虚构任务 ${index + 1}，不记录个人信息。`,
      priority: index < 7 ? ('essential' as const) : ('compressible' as const),
      taskIndexes: [index + 1]
    })),
    teacher_summary: '固定种子生成的纯虚构性能样本，仅用于工程测量。',
    unknowns: ['真实教学适切性需有资质教师另行复核。']
  });
  const plan = buildLessonPlan(base);
  plan.revision_id = fixedId('rev_perf', planIndex);
  return plan;
}

export async function seedG10PerformanceFixture(root: string): Promise<G10PerformanceFixture> {
  const store = new SqliteStore(root);
  await store.load();
  const imported = store.importSource({
    title: '虚构性能来源 5000 段',
    format: 'txt',
    content: sourceContent(),
    classification: 'teacher_private'
  });
  if (imported.status !== 'imported') throw new Error(`g10_fixture_source_seed_failed:${imported.status}`);

  const planIds: string[] = [];
  let exportPlan: LessonPlan | null = null;
  for (let index = 1; index <= G10_FIXTURE_SPEC.planCount; index += 1) {
    const plan = makeExportPlan(imported.versionId, index);
    planIds.push(plan.plan_id);
    if (index === G10_FIXTURE_SPEC.planCount) exportPlan = plan;
    store.saveLessonRevision(
      {
        planId: plan.plan_id,
        revisionId: plan.revision_id,
        previousRevisionId: null,
        title: plan.title,
        contentJson: JSON.stringify(plan),
        contentOrigin: 'synthetic_fixture',
        valid: true,
        createdAt: '2026-09-20T00:00:00.000Z'
      },
      true
    );
  }
  if (!exportPlan) throw new Error('g10_fixture_export_plan_missing');

  const dbPath = join(root, 'yuwendesk.db');
  return {
    root,
    dbPath,
    store,
    planIds,
    exportPlan,
    counts() {
      const db = new Database(dbPath, { readonly: true });
      try {
        const plans = Number((db.prepare('SELECT COUNT(*) count FROM lesson_plan').get() as { count: number }).count);
        const sourceSegments = Number((db.prepare('SELECT COUNT(*) count FROM source_segment').get() as { count: number }).count);
        return { plans, sourceSegments };
      } finally {
        db.close();
      }
    },
    writeReport(path, report) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
  };
}

function assertSampleCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new Error(`g10_invalid_sample_count:${name}`);
}

function roundMs(value: number): number {
  return Number(value.toFixed(3));
}

export function nearestRankPercentile(samples: number[], percentile: number): number {
  if (samples.length === 0) throw new Error('g10_percentile_empty');
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) throw new Error('g10_percentile_invalid');
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[rank - 1];
}

function metric(
  samples: number[],
  thresholdMs: number | null,
  statuses: { within: MetricStatus; over: MetricStatus } = { within: 'PASS', over: 'FAIL' }
): G10Metric {
  const rawMs = samples.map(roundMs);
  const p50Ms = roundMs(nearestRankPercentile(rawMs, 50));
  const p95Ms = roundMs(nearestRankPercentile(rawMs, 95));
  return {
    rawMs,
    sampleCount: rawMs.length,
    p50Ms,
    p95Ms,
    thresholdMs,
    status: thresholdMs === null ? 'MEASURED_NO_RELEASE_THRESHOLD' : p95Ms <= thresholdMs ? statuses.within : statuses.over
  };
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const writing = `${path}.writing`;
  writeFileSync(writing, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(writing, path);
}

function timed<T>(run: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
}

async function timedAsync<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await run();
  return { value, ms: performance.now() - start };
}

export async function runG10CoreBenchmark(
  fixture: G10PerformanceFixture,
  options: G10BenchmarkOptions
): Promise<G10PerformanceReport> {
  assertSampleCount(options.sqliteOpenSamples, 'sqliteOpenSamples');
  assertSampleCount(options.planOpenSamples, 'planOpenSamples');
  assertSampleCount(options.searchSamplesPerKind, 'searchSamplesPerKind');
  assertSampleCount(options.exportSamples, 'exportSamples');

  const memoryBefore = process.memoryUsage().rss;
  const sqliteOpen: number[] = [];
  const planOpen: number[] = [];
  const searchLong: number[] = [];
  const searchShort: number[] = [];
  const searchMixed: number[] = [];
  const materialGenerate: number[] = [];
  const materialReview: number[] = [];
  const materialGenerateAndReview: number[] = [];
  let currentStage: G10BenchmarkStage = 'sqliteWarmup';

  const rawSamples = () => ({
    sqliteOpen: sqliteOpen.map(roundMs),
    planOpen: planOpen.map(roundMs),
    searchLong: searchLong.map(roundMs),
    searchShort: searchShort.map(roundMs),
    searchMixed: searchMixed.map(roundMs),
    materialGenerate: materialGenerate.map(roundMs),
    materialReview: materialReview.map(roundMs),
    materialGenerateAndReview: materialGenerateAndReview.map(roundMs)
  });
  const persistProgress = (runStatus: 'IN_PROGRESS' | 'FAILED', failureStage: G10BenchmarkStage | null): void => {
    if (!options.progressOutputPath) return;
    writeJsonAtomic(options.progressOutputPath, {
      schemaVersion: 1,
      measurementClass: 'ENGINEERING_MEASUREMENT',
      runStatus,
      updatedAt: new Date().toISOString(),
      repositoryHead: process.env.YUWENDESK_G10_COMMIT ?? 'working-tree',
      repositoryState: process.env.YUWENDESK_G10_SOURCE_STATE ?? 'working-tree',
      benchmarkSourceSha256: process.env.YUWENDESK_G10_SOURCE_SHA256 ?? 'not-recorded',
      failureCode: runStatus === 'FAILED' ? 'G10_BENCHMARK_FAILED' : null,
      failureStage,
      plannedSamples: {
        sqliteOpen: options.sqliteOpenSamples,
        planOpen: options.planOpenSamples,
        searchPerKind: options.searchSamplesPerKind,
        materialCore: options.exportSamples
      },
      rawSamples: rawSamples(),
      rawSamplesPreserved: true,
      outliersRemoved: false
    });
  };
  const sampleCompleted = (stage: G10BenchmarkStage, completed: number): void => {
    currentStage = stage;
    persistProgress('IN_PROGRESS', null);
    if (options.faultAfterSample?.stage === stage && options.faultAfterSample.completed === completed) {
      throw new Error('g10_injected_benchmark_failure');
    }
  };

  persistProgress('IN_PROGRESS', null);
  try {
    currentStage = 'sqliteWarmup';
    const warmStore = new SqliteStore(fixture.root);
    await warmStore.load();
    warmStore.close();
    for (let index = 0; index < options.sqliteOpenSamples; index += 1) {
      currentStage = 'sqliteOpen';
      const store = new SqliteStore(fixture.root);
      const start = performance.now();
      await store.load();
      store.close();
      sqliteOpen.push(performance.now() - start);
      sampleCompleted('sqliteOpen', index + 1);
    }

    const planId = fixture.planIds[Math.floor(fixture.planIds.length / 2)];
    fixture.store.getLessonRevision(planId);
    for (let index = 0; index < options.planOpenSamples; index += 1) {
      currentStage = 'planOpen';
      const sample = timed(() => {
        const record = fixture.store.getLessonRevision(planId);
        if (!record) throw new Error('g10_benchmark_plan_missing');
        return JSON.parse(record.contentJson) as LessonPlan;
      });
      if (sample.value.plan_id !== planId) throw new Error('g10_benchmark_plan_identity');
      planOpen.push(sample.ms);
      sampleCompleted('planOpen', index + 1);
    }

    fixture.store.searchSources(G10_FIXTURE_SPEC.longQuery);
    fixture.store.searchSources(G10_FIXTURE_SPEC.shortQuery);
    for (let index = 0; index < options.searchSamplesPerKind; index += 1) {
      currentStage = 'searchLong';
      const long = timed(() => fixture.store.searchSources(G10_FIXTURE_SPEC.longQuery));
      if (long.value.length === 0) throw new Error('g10_benchmark_long_query_empty');
      searchLong.push(long.ms);
      searchMixed.push(long.ms);
      sampleCompleted('searchLong', index + 1);

      currentStage = 'searchShort';
      const short = timed(() => fixture.store.searchSources(G10_FIXTURE_SPEC.shortQuery));
      if (short.value.length === 0) throw new Error('g10_benchmark_short_query_empty');
      searchShort.push(short.ms);
      searchMixed.push(short.ms);
      sampleCompleted('searchShort', index + 1);
    }

    for (let index = 0; index < options.exportSamples; index += 1) {
      const totalStart = performance.now();
      currentStage = 'materialGenerate';
      const generated = await timedAsync(() => buildMaterialSet(fixture.exportPlan, 'synthetic_fixture'));
      if (generated.value.files.length !== G10_FIXTURE_SPEC.expectedFiles) throw new Error('g10_benchmark_bundle_shape');
      materialGenerate.push(generated.ms);
      sampleCompleted('materialGenerate', index + 1);

      currentStage = 'materialReview';
      const reviewed = await timedAsync(() => reviewMaterialSet(fixture.exportPlan, generated.value));
      if (reviewed.value.length !== 0) throw new Error(`g10_benchmark_review_failed:${reviewed.value.map((issue) => issue.rule_id).join(',')}`);
      materialReview.push(reviewed.ms);
      materialGenerateAndReview.push(performance.now() - totalStart);
      sampleCompleted('materialReview', index + 1);

      if (index === 0) {
        currentStage = 'artifactProfile';
        const presentation = generated.value.files.find((file) => file.format === 'pptx');
        if (!presentation) throw new Error('g10_benchmark_presentation_missing');
        const zip = await JSZip.loadAsync(presentation.bytes);
        const slideCount = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name)).length;
        if (slideCount !== G10_FIXTURE_SPEC.expectedPresentationSlides) {
          throw new Error(`g10_benchmark_slide_count:${slideCount}`);
        }
      }
    }
  } catch (error) {
    try {
      persistProgress('FAILED', currentStage);
    } catch {
      // 若证据介质本身失败，保留原异常；runner 会发布闭集的无报告失败标记。
    }
    throw error;
  }

  const memoryAfter = process.memoryUsage().rss;
  const cpu = cpus();
  const report: G10PerformanceReport = {
    schemaVersion: 1,
    measurementClass: 'ENGINEERING_MEASUREMENT',
    runStatus: 'COMPLETE',
    measuredAt: new Date().toISOString(),
    repositoryHead: process.env.YUWENDESK_G10_COMMIT ?? 'working-tree',
    repositoryState: process.env.YUWENDESK_G10_SOURCE_STATE ?? 'working-tree',
    benchmarkSourceSha256: process.env.YUWENDESK_G10_SOURCE_SHA256 ?? 'not-recorded',
    environment: {
      platform: platform(),
      release: release(),
      arch: arch(),
      node: process.version,
      electron: process.versions.electron ?? null,
      logicalCpuCount: cpu.length,
      cpuModel: cpu[0]?.model ?? 'unknown',
      totalMemoryBytes: totalmem()
    },
    fixture: {
      version: G10_FIXTURE_SPEC.version,
      seed: G10_FIXTURE_SPEC.seed,
      planCount: G10_FIXTURE_SPEC.planCount,
      sourceSegmentCount: G10_FIXTURE_SPEC.sourceSegmentCount,
      containsRealData: false,
      exportArtifactProfile: {
        expectedFiles: 5,
        expectedPresentationSlides: 20,
        targetDocxPages: 10,
        docxPaginationVerification: 'NOT_RUN/BLOCKED_EXTERNAL'
      }
    },
    methodology: {
      percentile: 'nearest-rank',
      rawSamplesPreserved: true,
      outliersRemoved: false,
      sqliteOpenIncludes: 'SqliteStore.load + close',
      exportIncludes: 'five-file generation + deterministic consistency review',
      qualification:
        'Node 内存生成与确定性复核核心测量；不含 staging、写盘、回读或发布，不等同于正式备课包导出、Electron 冷启动、目标 8GB/SSD 总进程内存或 Office/WPS 分页保真。',
      cacheState: 'SQLite 先预热一次；计划打开和长短查询均重复同一对象/查询，结果是 warm-cache 工程测量。'
    },
    metrics: {
      sqliteOpen: metric(sqliteOpen, null),
      planOpen: metric(planOpen, 2000),
      searchLong: metric(searchLong, 1500),
      searchShort: metric(searchShort, 1500),
      searchMixed: metric(searchMixed, 1500),
      materialGenerate: metric(materialGenerate, null),
      materialReview: metric(materialReview, null),
      materialGenerateAndReview: metric(materialGenerateAndReview, 30_000, {
        within: 'ENGINEERING_CORE_WITHIN_BUDGET',
        over: 'ENGINEERING_CORE_OVER_BUDGET'
      })
    },
    memory: {
      nodeRssBeforeBytes: memoryBefore,
      nodeRssAfterBytes: memoryAfter,
      status: 'MEASURED_NO_RELEASE_THRESHOLD',
      qualification: '单 Node/Vitest 进程 RSS，仅作工程观察；不用于 <=700MB Electron 总进程发布目标。'
    },
    external: {
      electronColdStart: { status: 'NOT_RUN/BLOCKED_EXTERNAL', target: 'P95<=8000ms, Win11 8GB SSD, 30 runs' },
      electronIdleMemory: { status: 'NOT_RUN/BLOCKED_EXTERNAL', target: '<=700MB total Electron processes' },
      targetWindowsHardware: { status: 'NOT_RUN/BLOCKED_EXTERNAL' },
      formalPackageExport: {
        status: 'NOT_RUN/BLOCKED_EXTERNAL',
        target: 'approximately 10-page DOCX and 20-slide deck, measured separately with publish I/O'
      },
      officeWpsPagination: { status: 'NOT_RUN/BLOCKED_EXTERNAL', target: 'approximately 10-page DOCX' }
    }
  };
  if (options.progressOutputPath) writeJsonAtomic(options.progressOutputPath, report);
  return report;
}
