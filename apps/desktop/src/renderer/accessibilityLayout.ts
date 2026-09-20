export const MAIN_CONTENT_ID = 'yuwendesk-main-content';

export const ACCESSIBILITY_VIEWPORTS = [
  { physicalWidth: 1366, physicalHeight: 768, displayScale: 1 },
  { physicalWidth: 1366, physicalHeight: 768, displayScale: 1.25 },
  { physicalWidth: 1366, physicalHeight: 768, displayScale: 1.5 },
  { physicalWidth: 1920, physicalHeight: 1080, displayScale: 1 },
  { physicalWidth: 1920, physicalHeight: 1080, displayScale: 1.25 },
  { physicalWidth: 1920, physicalHeight: 1080, displayScale: 1.5 }
] as const;

export interface AccessibilityLayoutCase {
  physicalWidth: number;
  physicalHeight: number;
  displayScale: number;
  largeText: boolean;
  cssWidth: number;
  cssHeight: number;
  navigationMode: 'sidebar' | 'stacked';
  contentColumns: 1 | 2;
  contentViewportHeight: number;
  mainRegionScrolls: true;
  primaryActionReachable: boolean;
}

export interface DialogFocusTarget {
  readonly isConnected: boolean;
  focus(): void;
}

export function startDialogFocusSession(
  previousFocus: DialogFocusTarget | null,
  firstControl: DialogFocusTarget | null
): () => void {
  firstControl?.focus();
  return () => {
    if (previousFocus?.isConnected) previousFocus.focus();
  };
}

/**
 * Deterministic coverage model for the CSS breakpoints. This does not claim a
 * real Windows display/IME/assistive-technology run; it keeps the required
 * scale matrix executable until that external evidence is available.
 */
export function buildAccessibilityLayoutMatrix(): AccessibilityLayoutCase[] {
  return ACCESSIBILITY_VIEWPORTS.flatMap((viewport) =>
    [false, true].map((largeText): AccessibilityLayoutCase => {
      const cssWidth = Math.floor(viewport.physicalWidth / viewport.displayScale);
      const cssHeight = Math.floor(viewport.physicalHeight / viewport.displayScale);
      const navigationMode = cssWidth <= 980 ? 'stacked' : 'sidebar';
      const reservedHeight = navigationMode === 'stacked' ? 160 : 80;
      const contentViewportHeight = Math.max(0, cssHeight - reservedHeight);
      return {
        ...viewport,
        largeText,
        cssWidth,
        cssHeight,
        navigationMode,
        contentColumns: cssWidth <= 700 || largeText ? 1 : 2,
        contentViewportHeight,
        mainRegionScrolls: true,
        primaryActionReachable: contentViewportHeight >= 220
      };
    })
  );
}
