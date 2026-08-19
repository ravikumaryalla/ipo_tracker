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
