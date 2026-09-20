// 关闭协调器（F01 主进程侧）。可注入依赖，便于单元测试；不含 Electron 直接引用。
// 关键性质：
//  - 每次关闭请求使用唯一 request_id；只接受与当前握手匹配的成功回执（忽略旧处理器的过期回执）。
//  - 保存成功→关闭；保存失败/未完成→询问用户（继续编辑/仍要退出），绝不静默丢弃。
//  - 看门狗超时不直接强关，而是同样询问用户（不把"调大时限"当修复）。

export interface CloseDeps {
  requestFlush: (requestId: string) => void;
  closeWindow: () => void;
  confirmForceQuit: () => Promise<boolean>; // 返回 true 表示用户选择"仍要退出"
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class CloseController {
  private allowClose = false;
  private currentReqId: string | null = null;
  private watchdog: unknown = null;

  constructor(
    private readonly deps: CloseDeps,
    private readonly genId: () => string = () => `close-${Date.now()}-${Math.random().toString(16).slice(2)}`
  ) {}

  // 返回 true 表示可以放行关闭（已确认）；false 表示已拦截并发起 flush 握手。
  onClose(): boolean {
    if (this.allowClose) return true;
    const id = this.genId();
    this.currentReqId = id;
    this.armWatchdog();
    this.deps.requestFlush(id);
    return false;
  }

  async onFlushResult(requestId: string, saved: boolean): Promise<void> {
    if (requestId !== this.currentReqId) return; // 过期/非本次握手的回执，忽略
    this.clearWatchdog();
    if (saved) {
      this.finish();
      return;
    }
    const quit = await this.deps.confirmForceQuit();
    if (quit) this.finish();
    else this.currentReqId = null; // 保留窗口与文本，允许用户稍后再次关闭
  }

  private async onTimeout(): Promise<void> {
    this.watchdog = null;
    const quit = await this.deps.confirmForceQuit();
    if (quit) this.finish();
    else this.currentReqId = null;
  }

  private finish(): void {
    this.allowClose = true;
    this.currentReqId = null;
    this.deps.closeWindow();
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    const ms = this.deps.timeoutMs ?? 10000;
    const set = this.deps.setTimer ?? ((fn, t) => setTimeout(fn, t));
    this.watchdog = set(() => void this.onTimeout(), ms);
  }

  private clearWatchdog(): void {
    if (this.watchdog === null) return;
    const clear = this.deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
    clear(this.watchdog);
    this.watchdog = null;
  }
}
