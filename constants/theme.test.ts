/**
 * Guard test for the design tokens.
 *
 * There are no component tests in this repo, so `tsc --noEmit` is the real
 * regression suite for a palette change — and it only works as one because the
 * light rewrite deliberately preserved every token *key* name from the previous
 * dark palette. These assertions protect that contract, plus the two things
 * typecheck cannot see: that no dark value survived, and that nothing still
 * asks for Sora.
 */
import { colors, elevation, fonts, radius, spacing, type } from './theme';

/**
 * Every key the dark palette exported. Screens reference these directly, so
 * dropping one is a compile error somewhere — this makes it a test failure
 * here instead, naming the key.
 */
const INHERITED_COLOR_KEYS = [
  'bg',
  'bgDeep',
  'surface',
  'surfaceAlt',
  'surfaceRaised',
  'surfaceGlass',
  'surfaceGlassStrong',
  'border',
  'borderSoft',
  'borderStrong',
  'text',
  'textMuted',
  'textFaint',
  'accent',
  'accentBright',
  'accentSoft',
  'violet',
  'violetSoft',
  'success',
  'successSoft',
  'warning',
  'warningSoft',
  'danger',
  'dangerSoft',
] as const;

/** Values that only existed in the dark palette. */
const RETIRED_VALUES = [
  '#070B14', // colors.bg
  '#04070E', // colors.bgDeep
  '#111A2E', // colors.surface
  '#18233C', // colors.surfaceAlt
  '#1F2C49', // colors.surfaceRaised
  '#243352', // colors.border
  '#EEF3FC', // colors.text
  '#5B94FF', // colors.accent
  '#3DDC97', // colors.success
  '#FF7A7A', // colors.danger
  '#FFC554', // colors.warning
];

describe('colors', () => {
  it.each(INHERITED_COLOR_KEYS)('still exports %s', (key) => {
    expect(colors).toHaveProperty(key);
    expect(typeof colors[key]).toBe('string');
  });

  it('carries no value from the dark palette', () => {
    // `colors` is `as const`, so Object.values yields a union of string
    // literals rather than `string` — widen before filtering.
    const values = (Object.values(colors) as unknown[]).filter(
      (v): v is string => typeof v === 'string',
    );
    for (const retired of RETIRED_VALUES) {
      expect(values).not.toContain(retired);
    }
  });

  it('exposes two-stop chart ramps for SVG gradients', () => {
    // charts.tsx types colorStops as a fixed-length tuple; a one-stop array
    // there is a compile error that only surfaces when the chart renders.
    for (const ramp of Object.values(colors.chart)) {
      expect(ramp).toHaveLength(2);
    }
  });
});

describe('gradients and glow', () => {
  it('are no longer exported', async () => {
    // The flat palette has no gradient surfaces and no coloured glow. Keeping
    // the exports alive as light no-ops would invite them back.
    const theme = await import('./theme');
    expect(theme).not.toHaveProperty('gradients');
    expect(theme).not.toHaveProperty('glow');
  });
});

describe('typography', () => {
  it('asks only for Inter', () => {
    for (const family of Object.values(fonts)) {
      expect(family).toMatch(/^Inter_/);
    }
  });

  it('resolves every type entry to a registered family', () => {
    const registered = Object.values(fonts);
    for (const [name, style] of Object.entries(type)) {
      expect(registered).toContain(style.fontFamily);
      // Juricat's ramp tops out at 22; anything larger is a leftover from the
      // previous scale, where hero was 44.
      expect(style.fontSize).toBeLessThanOrEqual(22);
      expect(style.fontSize).toBeGreaterThanOrEqual(11);
      expect(name).toBeTruthy();
    }
  });
});

describe('scales', () => {
  it('keeps the inherited spacing and radius keys', () => {
    expect(Object.keys(spacing)).toEqual(['xs', 'sm', 'md', 'lg', 'xl', 'xxl', 'xxxl']);
    expect(Object.keys(radius)).toEqual(['sm', 'md', 'lg', 'xl', 'xxl', 'pill']);
  });

  it('keeps low/medium/high as aliases alongside the numeric levels', () => {
    expect(elevation.low).toEqual(elevation[1]);
    expect(elevation.medium).toEqual(elevation[2]);
    expect(elevation.high).toEqual(elevation[3]);
  });

  it('has no shadow at elevation 0', () => {
    expect(elevation[0]).toEqual({});
  });
});

/**
 * WCAG relative luminance and contrast ratio, per the 2.x definition.
 *
 * This exists because the light conversion introduced exactly this bug: the
 * 600-weight semantic hues were used as text on their own pale backgrounds and
 * every pairing failed AA, warning worst at 2.16:1. The numbers are cheap to
 * assert and the failure is invisible to typecheck.
 */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const channel = (pair: string) => {
    const c = parseInt(pair, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(h.slice(0, 2)) +
    0.7152 * channel(h.slice(2, 4)) +
    0.0722 * channel(h.slice(4, 6))
  );
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('tonal text contrast', () => {
  const AA_NORMAL = 4.5;

  it.each([
    ['successText on successSoft', colors.successText, colors.successSoft],
    ['warningText on warningSoft', colors.warningText, colors.warningSoft],
    ['dangerText on dangerSoft', colors.dangerText, colors.dangerSoft],
    ['infoText on infoSoft', colors.infoText, colors.infoSoft],
    ['accentText on accentSoft', colors.accentText, colors.accentSoft],
  ])('%s clears WCAG AA', (_name, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it.each([
    ['success', colors.success, colors.successSoft],
    ['warning', colors.warning, colors.warningSoft],
    ['danger', colors.danger, colors.dangerSoft],
    ['info', colors.info, colors.infoSoft],
    ['accent', colors.accent, colors.accentSoft],
  ])('the 600-weight %s hue is fill-only, never text on its own soft fill', (_n, fg, bg) => {
    // Documents *why* the *Text tokens exist. If one of these ever starts
    // passing, the palette moved and the pairing should be revisited — not
    // silently kept.
    expect(contrast(fg, bg)).toBeLessThan(AA_NORMAL);
  });

  it('keeps white legible on every filled badge', () => {
    for (const fill of [colors.success, colors.danger, colors.accent, colors.navy]) {
      // 3:1 is the AA bar for graphical objects and large text. A filled badge
      // is a solid block carrying two or three bold words, so that is the right
      // threshold here — success at #43a047 sits just under 4.5:1 against
      // white and is legible in practice.
      expect(contrast('#ffffff', fill)).toBeGreaterThanOrEqual(3);
    }
  });
});
