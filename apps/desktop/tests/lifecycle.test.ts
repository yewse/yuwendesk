import { describe, expect, it, vi } from 'vitest';
import { CloseController, type CloseDeps } from '../src/main/lifecycle';

function makeDeps(overrides: Partial<CloseDeps> = {}): CloseDeps & {
  flushCalls: string[];
  closed: number;
} {
  const state = { flushCalls: [] as string[], closed: 0 };
  const deps: CloseDeps & { flushCalls: string[]; closed: number } = {
    flushCalls: state.flushCalls,
    get closed() {
      return state.closed;
    },
    requestFlush: (id: string) => state.flushCalls.push(id),
    closeWindow: () => {
      state.closed++;
    },
    confirmForceQuit: async () => false,
    ...overrides
  } as CloseDeps & { flushCalls: string[]; closed: number };
  return deps;
}

let idSeq = 0;
const genId = () => `req-${++idSeq}`;

describe('CloseController（F01：不提前关闭/不静默强关/忽略过期回执）', () => {
  it('首次关闭被拦截并请求 flush，不立即关闭', () => {
    const deps = makeDeps();
    const c = new CloseController(deps, genId);
    const proceed = c.onClose();
    expect(proceed).toBe(false);
    expect(deps.flushCalls.length).toBe(1);
    expect(deps.closed).toBe(0);
  });

  it('保存成功回执 → 关闭窗口', async () => {
    const deps = makeDeps();
    const c = new CloseController(deps, genId);
    c.onClose();
    const id = deps.flushCalls[deps.flushCalls.length - 1];
    await c.onFlushResult(id, true);
    expect(deps.closed).toBe(1);
  });

  it('保存失败且用户选择“继续编辑” → 不关闭，保留窗口', async () => {
    const confirm = vi.fn(async () => false);
    const deps = makeDeps({ confirmForceQuit: confirm });
    const c = new CloseController(deps, genId);
    c.onClose();
    const id = deps.flushCalls[deps.flushCalls.length - 1];
    await c.onFlushResult(id, false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(deps.closed).toBe(0);
  });

  it('保存失败且用户选择“仍要退出” → 关闭', async () => {
    const deps = makeDeps({ confirmForceQuit: async () => true });
    const c = new CloseController(deps, genId);
    c.onClose();
    const id = deps.flushCalls[deps.flushCalls.length - 1];
    await c.onFlushResult(id, false);
    expect(deps.closed).toBe(1);
  });

  it('过期握手回执被忽略（不因旧处理器提前关闭）', async () => {
    const deps = makeDeps();
    const c = new CloseController(deps, genId);
    c.onClose(); // req id X（当前）
    await c.onFlushResult('stale-old-id', true);
    expect(deps.closed).toBe(0);
  });

  it('超时不静默强关，而是询问用户（此处用户拒绝→不关闭）', async () => {
    const confirm = vi.fn(async () => false);
    let fire: (() => void) | null = null;
    const deps = makeDeps({
      confirmForceQuit: confirm,
      setTimer: (fn: () => void) => {
        fire = fn;
        return 1;
      },
      clearTimer: () => undefined,
      timeoutMs: 10
    });
    const c = new CloseController(deps, genId);
    c.onClose();
    expect(fire).not.toBeNull();
    fire!(); // 触发看门狗
    await Promise.resolve();
    await Promise.resolve();
    expect(confirm).toHaveBeenCalled();
    expect(deps.closed).toBe(0);
  });
});
