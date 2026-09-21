import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import {
  ACCESSIBILITY_VIEWPORTS,
  MAIN_CONTENT_ID,
  buildAccessibilityLayoutMatrix,
  startDialogFocusSession
} from '../src/renderer/accessibilityLayout';

function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/gu)?.map((value) => Number.parseInt(value, 16) / 255) ?? [];
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('G10-T03 accessibility and layout contract', () => {
  it('covers the required viewport, scale, and large-text matrix without claiming a real display run', () => {
    const matrix = buildAccessibilityLayoutMatrix();
    expect(matrix).toHaveLength(12);
    expect(new Set(matrix.map((row) => `${row.physicalWidth}x${row.physicalHeight}`))).toEqual(
      new Set(['1366x768', '1920x1080'])
    );
    expect(new Set(matrix.map((row) => row.displayScale))).toEqual(new Set([1, 1.25, 1.5]));
    expect(new Set(matrix.map((row) => row.largeText))).toEqual(new Set([false, true]));
    for (const row of matrix) {
      expect(row.mainRegionScrolls).toBe(true);
      expect(row.primaryActionReachable).toBe(true);
      expect(row.contentViewportHeight).toBeGreaterThanOrEqual(220);
      if (row.cssWidth <= 980) expect(row.navigationMode).toBe('stacked');
      if (row.cssWidth <= 700 || row.largeText) expect(row.contentColumns).toBe(1);
    }
    expect(ACCESSIBILITY_VIEWPORTS).toHaveLength(6);
  });

  it('renders a skip target, named navigation, current page, status text, and an explicit large-text control in keyboard order', () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain(`href="#${MAIN_CONTENT_ID}"`);
    expect(html).toContain('>跳到主要内容</a>');
    expect(html).toContain('<nav aria-label="主导航">');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain(`id="${MAIN_CONTENT_ID}"`);
    expect(html).toContain('aria-label="备课只需三步"');
    expect(html).toContain('aria-label="选择备课资料文件"');
    expect(html).not.toContain('备课草稿（本地保存）');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('大字模式');
    expect(html.indexOf('跳到主要内容')).toBeLessThan(html.indexOf('主导航'));
    expect(html.indexOf('主导航')).toBeLessThan(html.indexOf(`id="${MAIN_CONTENT_ID}"`));
  });

  it('moves focus into a dialog before restoring a still-connected opener', () => {
    const calls: string[] = [];
    const opener = { isConnected: true, focus: () => calls.push('opener') };
    const firstControl = { isConnected: true, focus: () => calls.push('dialog') };
    const restore = startDialogFocusSession(opener, firstControl);
    expect(calls).toEqual(['dialog']);
    restore();
    expect(calls).toEqual(['dialog', 'opener']);

    const detachedCalls: string[] = [];
    const detached = { isConnected: false, focus: () => detachedCalls.push('detached') };
    startDialogFocusSession(detached, null)();
    expect(detachedCalls).toEqual([]);
  });

  it('keeps shell regions independently scrollable, focus visible, responsive, and non-color-only', () => {
    const css = readFileSync(join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
    const appSource = readFileSync(join(__dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');
    const preparationSource = readFileSync(
      join(__dirname, '..', 'src', 'renderer', 'preparation', 'AiPreparationStart.tsx'),
      'utf8'
    );
    expect(css).toMatch(/\.content\s*\{[^}]*min-height:\s*0/su);
    expect(css).toMatch(/\.scroll\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0[^}]*overflow:\s*auto/su);
    expect(css).toMatch(/\.sidebar\s*\{[^}]*overflow-y:\s*auto/su);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px/su);
    expect(css).toMatch(/@media\s*\(max-width:\s*980px\)[\s\S]*?\.app\s*\{[^}]*grid-template-columns:\s*1fr/su);
    expect(css).toMatch(/@media\s*\(max-width:\s*700px\)[\s\S]*?\.grid\s*\{[^}]*grid-template-columns:\s*1fr/su);
    expect(css).toMatch(/@media\s*\(forced-colors:\s*active\)/u);
    expect(preparationSource).toContain('已选');
    expect(preparationSource).toContain('同意将本次选中资料的必要片段发送给已配置的 AI 服务');
    expect(preparationSource).toContain('aria-label="选择备课资料文件"');
    expect(appSource).toContain("event.key === 'Tab'");
    expect(appSource).toContain('startDialogFocusSession(previousFocus');
    expect(appSource).not.toContain('autoFocus');
    expect(appSource).toContain('function LiveMessage');
    expect(appSource).toContain('aria-atomic="true"');
    expect((appSource.match(/<LiveMessage/gu) ?? []).length).toBeGreaterThanOrEqual(15);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid #fff[^}]*box-shadow:\s*0 0 0 6px #1d5f9e/su);
    expect(css).toMatch(/@media\s*\(forced-colors:\s*active\)[\s\S]*?:focus-visible\s*\{[^}]*outline:\s*3px solid Highlight/su);
    expect(css).toMatch(/\.app\.large-text :is\([^)]*\.pill[^)]*\.tag[^)]*\.reader-body[^)]*\.diagnostics-preview[^)]*\)\s*\{[^}]*font-size:\s*16px/su);
    expect(css).toMatch(/\.app\.large-text \.change-grid label\s*\{[^}]*font-size:\s*16px/su);
    expect(css).toMatch(/@media\s*\(forced-colors:\s*active\)[\s\S]*?\.draft:focus-visible\s*\{[^}]*outline:\s*3px solid Highlight/su);
    const warningInk = css.match(/--warning-ink:\s*(#[0-9a-f]{6})/iu)?.[1];
    expect(warningInk).toBeTruthy();
    expect(contrastRatio(warningInk!, '#f4ede1')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(warningInk!, '#fbf1dd')).toBeGreaterThanOrEqual(4.5);
  });
});
