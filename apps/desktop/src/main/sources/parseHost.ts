// 主进程侧的解析宿主：把解析派发到 worker 线程，使耗时解析不阻塞主进程。
// 观察取消信号并在取消时终止 worker；把 worker 错误码还原为 ExtractError。
import { Worker } from 'node:worker_threads';
import { ExtractError, type ExtractOpts, type ExtractResult } from './extract';

// 返回可注入到 SqliteStore 的 parseFile 实现。workerJsPath 为编译后的 parseWorker.js 绝对路径。
export function createWorkerParser(workerJsPath: string): (buf: Buffer, format: string, opts: ExtractOpts) => Promise<ExtractResult> {
  return (buf, format, opts) =>
    new Promise<ExtractResult>((resolve, reject) => {
      const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const worker = new Worker(workerJsPath, { workerData: { bytes, format, limits: opts.limits } });
      let done = false;
      const finish = (fn: () => void): void => {
        if (done) return;
        done = true;
        clearInterval(poll);
        void worker.terminate();
        fn();
      };
      // 轮询取消信号：取消 → 终止 worker 并以 cancelled 拒绝（取消传播到解析边界）。
      const poll = setInterval(() => {
        if (opts.signal?.cancelled) finish(() => reject(new ExtractError('cancelled')));
      }, 100);
      worker.on('message', (m: { ok: boolean; result?: ExtractResult; code?: string; msg?: string }) => {
        if (m.ok && m.result) finish(() => resolve(m.result as ExtractResult));
        else finish(() => reject(new ExtractError((m.code as ExtractError['code']) ?? 'parse_failed', m.msg)));
      });
      worker.on('error', (e) => finish(() => reject(new ExtractError('parse_failed', String(e)))));
      worker.on('exit', (code) => {
        if (!done && code !== 0) finish(() => reject(new ExtractError('parse_failed', `worker_exit_${code}`)));
      });
    });
}
