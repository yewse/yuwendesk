// worker_threads 解析工作线程：在主进程之外执行耗时的原始文件解析（PDF/DOCX/…）。
// 由 parseHost 创建；接收字节+格式+限额，回传 ExtractResult 或错误码。
import { parentPort, workerData } from 'node:worker_threads';
import { extractBuffer, ExtractError } from './extract';

interface WorkerInput {
  bytes: ArrayBuffer;
  format: string;
  limits?: import('./extract').ExtractLimits;
}

async function main(): Promise<void> {
  const { bytes, format, limits } = workerData as WorkerInput;
  try {
    const result = await extractBuffer(Buffer.from(bytes), format, { limits });
    parentPort?.postMessage({ ok: true, result });
  } catch (e) {
    const code = e instanceof ExtractError ? e.code : 'parse_failed';
    parentPort?.postMessage({ ok: false, code, msg: String(e instanceof Error ? e.message : e) });
  }
}
void main();
