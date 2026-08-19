/**
 * Design system.
 *
 * A single light palette, ported from the "Juricat" design system that the
 * product mockups are drawn in. Committing to one theme keeps contrast
 * predictable and avoids a whole class of "unreadable in the other mode" bugs —
 * which matters here because the app puts account credentials on screen.
 *
 * The visual language is flat rather than layered: a plain ground, white cards
 * separated by a hairline and a soft two-stop shadow, and colour reserved for
 * status. There are no gradients and no coloured glow — if you find yourself
 * reaching for one, the mockup almost certainly solves it with a tinted
 * background from the `*Soft` tokens instead.
 *
 * Token *key names* are deliberately stable: they were inherited from the
 * previous dark palette so that `tsc --noEmit` proves every screen still
 * compiles after a palette change. Some names read oddly in a light theme
 * (`surfaceGlass`, `bgDeep`); they are kept as aliases rather than renamed.
 */

/** Raw Juricat ramps. Prefer the semantic tokens below at call sites. */
export const blue = {
  50: '#e3f2fd',
  100: '#bbdefb',
  200: '#90caf9',
  300: '#64b5f6',
  400: '#42a5f5',
  500: '#2196f3',
  600: '#1e88e5',
  700: '#1976d2',
  800: '#1565c0',
  900: '#0d47a1',
} as const;

export const neutral = {
  50: '#fafafa',
  100: '#f5f5f5',
  200: '#eeeeee',
  300: '#e0e0e0',
  400: '#bdbdbd',
  500: '#9e9e9e',
  600: '#757575',
  700: '#616161',
  800: '#424242',
  900: '#212121',
} as const;

export const colors = {
  // --- ground -------------------------------------------------------------
  /** App backdrop. Cards lift off this. */
  bg: '#f5f5f5',
  /** Alias, kept for call-site stability. In light there is nothing below bg. */
  bgDeep: '#eeeeee',

  // --- surface ladder -----------------------------------------------------
  /** Resting surface for cards, headers and the tab bar. */
  surface: '#ffffff',
  /** One step down: inputs, nested rows, pressed states. Tinted, not raised. */
  surfaceAlt: '#f5f5f5',
  /** Menus and sheets. Same white; separation comes from shadow, not colour. */
  surfaceRaised: '#ffffff',
  /**
   * Aliases from the old dark palette, where these were translucent "glass".
   * Light has no equivalent — a card is simply white — so they resolve to
   * white and exist only so existing call sites keep compiling.
   */
  surfaceGlass: '#ffffff',
  surfaceGlassStrong: '#ffffff',

  // --- lines --------------------------------------------------------------
  border: '#e0e0e0',
  borderSoft: 'rgba(0, 0, 0, 0.08)',
  borderStrong: '#bdbdbd',

  // --- type ---------------------------------------------------------------
  text: 'rgba(0, 0, 0, 0.87)',
  textMuted: 'rgba(0, 0, 0, 0.60)',
  /**
   * ~4.0:1 on white — below WCAG AA for body text. Disabled and decorative use
   * only; anything meant to be read gets `textMuted`.
   */
  textFaint: 'rgba(0, 0, 0, 0.38)',
  /** Foreground on a filled accent/success/danger surface. */
  onAccent: '#ffffff',

  // --- accents ------------------------------------------------------------
  accent: blue[600],
  accentBright: blue[400],
  /** Pale tinted background behind accent-toned chips and callouts. */
  accentSoft: blue[50],
  /**
   * Signature navy. Selected tab labels and toggle text — the one place the
   * product reads as more than stock Material blue.
   */
  navy: '#002C61',
  /** Unselected toggle/tab text. */
  slate: '#64748B',
  /** Toggle group track. */
  slateTrack: '#F1F5F9',

  /** Secondary accent, used only for chart stops. */
  violet: '#8e24aa',
  violetSoft: '#f3e5f5',

  success: '#43a047',
  successSoft: '#e8f5e9',
  warning: '#fb8c00',
  warningSoft: '#fff3e0',
  danger: '#e53935',
  dangerSoft: '#ffebee',
  info: '#039be5',
  infoSoft: '#e1f5fe',

  /*
   * Foregrounds for text sitting on the matching `*Soft` fill.
   *
   * The 600-weight hues above are for fills, icons and rules; every one of them
   * fails WCAG AA as text on its own pale background — warning is the worst at
   * 2.16:1, and even danger only reaches 3.70:1. These are the 900-weight
   * shades, which clear 4.5:1 comfortably.
   *
   * warningText is the one value outside the Juricat ramp: warning-900
   * (#e65100) still only manages 3.46:1 on warningSoft, so this is darkened
   * past the end of the ramp to 7.61:1.
   */
  successText: '#1b5e20',
  warningText: '#7a3e00',
  dangerText: '#b71c1c',
  infoText: '#01579b',
  accentText: '#0d47a1',

  /**
   * Two-stop ramps for SVG gradients in charts.tsx. These live on `colors`
   * rather than a `gradients` export on purpose: charts are the only remaining
   * legitimate use of a gradient, and a top-level `gradients` object invites
   * them back into ordinary surfaces.
   */
  chart: {
    accent: ['#1e88e5', '#8e24aa'] as [string, string],
    positive: ['#43a047', '#1e88e5'] as [string, string],
    negative: ['#e53935', '#fb8c00'] as [string, string],
  },
} as const;

/**
 * Neutral depth. React Native cannot express the mockup's two-layer shadow
 * (`0 4px 6px -1px …, 0 2px 4px -1px …`) so each level approximates it with a
 * single offset shadow; Android honours `elevation` only, and over-shooting it
 * on white produces grey halos, so the values stay low.
 */
export const elevation = {
  0: {},
  1: {
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  2: {
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 5,
  },
  3: {
    shadowColor: '#000',
    shadowOpacity: 0.14,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 9,
  },
  /** Aliases from the previous palette. */
  low: {
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  medium: {
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 5,
  },
  high: {
    shadowColor: '#000',
    shadowOpacity: 0.14,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 9,
  },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

/**
 * Tighter than the previous scale — Juricat cards sit at 8px. The key names are
 * unchanged, so every call site tightens at once and it is reversible here.
 */
export const radius = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 20,
  pill: 999,
} as const;

/**
 * Font families. The names match what `useFonts` registers in app/_layout.tsx —
 * if you change one, change it there too.
 *
 * Juricat is Inter throughout, so `display` and `displayMedium` now point at
 * Inter weights. The keys keep their names because every `type` entry and
 * ~20 screens reference them; Sora is still registered in `useFonts` and is
 * removed in a later commit, deliberately separated so a stale font name fails
 * loudly rather than silently falling back to the system face.
 */
export const fonts = {
  display: 'Inter_700Bold',
  displayMedium: 'Inter_600SemiBold',
  body: 'Inter_400Regular',
  bodyMedium: 'Inter_500Medium',
  bodySemi: 'Inter_600SemiBold',
  bodyBold: 'Inter_700Bold',
} as const;

/**
 * `fontVariant: ['tabular-nums']` is iOS-only in React Native. On Android the
 * digits stay proportional, so anywhere columns must line up we also give the
 * container a fixed width rather than trusting the font.
 */
export const tabularNums = { fontVariant: ['tabular-nums' as const] };

/**
 * Juricat's type ramp: Inter, 11–22px, weights 400/600/700. Much flatter than
 * the previous scale — the mockup carries hierarchy with weight and colour
 * rather than size, so `hero` is 22 rather than 44.
 */
export const type = {
  /** The one big number on a screen. Never more than one. */
  hero: {
    fontFamily: fonts.display,
    fontSize: 22,
    lineHeight: 28,
    letterSpacing: -0.3,
  },
  display: {
    fontFamily: fonts.display,
    fontSize: 20,
    lineHeight: 26,
    letterSpacing: -0.2,
  },
  title: {
    fontFamily: fonts.display,
    fontSize: 17,
    lineHeight: 23,
    letterSpacing: -0.1,
  },
  heading: {
    fontFamily: fonts.bodySemi,
    fontSize: 15,
    lineHeight: 20,
  },
  body: {
    fontFamily: fonts.body,
    fontSize: 13.5,
    lineHeight: 19,
  },
  bodyStrong: {
    fontFamily: fonts.bodySemi,
    fontSize: 13.5,
    lineHeight: 19,
  },
  /** Field labels and table headers. Uppercase is applied at the call site. */
  label: {
    fontFamily: fonts.bodySemi,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.4,
  },
  caption: {
    fontFamily: fonts.body,
    fontSize: 11.5,
    lineHeight: 16,
  },
  /** Statistic values inside tiles. */
  stat: {
    fontFamily: fonts.display,
    fontSize: 18,
    lineHeight: 24,
    letterSpacing: -0.2,
  },
} as const;

/**
 * Motion. Durations are short on purpose: this is a tool people open to check a
 * number, and animation that makes them wait is animation working against them.
 */
export const motion = {
  fast: 150,
  base: 250,
  slow: 400,
  /** Count-up for the hero figure. Long enough to notice, short enough to skip. */
  countUp: 900,
  /** Per-item delay for staggered list entrances. */
  stagger: 45,
} as const;

/** Indian-format currency. Amounts here are rupees, always. */
export function formatInr(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);
}

/** Compact form for stat tiles: ₹1.2L, ₹3.4Cr. */
export function formatInrCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_00_00_000) return `${sign}₹${(abs / 1_00_00_000).toFixed(2)}Cr`;
  if (abs >= 1_00_000) return `${sign}₹${(abs / 1_00_000).toFixed(2)}L`;
  if (abs >= 1_000) return `${sign}₹${(abs / 1_000).toFixed(1)}K`;
  return `${sign}₹${abs.toFixed(0)}`;
}
