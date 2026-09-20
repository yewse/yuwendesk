import type { YuwenApi } from '../preload/index';

declare global {
  interface Window {
    yuwen: YuwenApi;
  }
}

export {};
