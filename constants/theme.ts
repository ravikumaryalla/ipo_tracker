/**
 * Design system.
 *
 * A single dark palette. The app is a finance tool that shows secrets on screen;
 * committing to one dark theme keeps contrast predictable and avoids a whole
 * class of "unreadable in the other mode" bugs.
 *
 * The visual language is layered rather than flat: a gradient ground, surfaces
 * that sit above it at three heights, and coloured glow reserved for the few
 * numbers that actually matter. Depth is what separates "a dark app" from one
 * that feels considered — but it only reads if it is used sparingly, so the
 * elevation and glow scales below are deliberately short.
 */

export const colors = {
  // --- ground -------------------------------------------------------------
  /** Deepest layer. Nothing sits behind this. */
  bg: '#070B14',
  bgDeep: '#04070E',

  // --- surface ladder -----------------------------------------------------
  /** Resting surface for cards. */
  surface: '#111A2E',
  /** One step up: inputs, nested rows, pressed states. */
  surfaceAlt: '#18233C',
  /** Highest: menus, sheets, the active tab pill. */
  surfaceRaised: '#1F2C49',
  /**
   * Translucent fill for "glass". Layered over the gradient ground it reads as
   * frosted without the cost of a real blur — see the note in the redesign
   * plan about expo-blur on Android.
   */
  surfaceGlass: 'rgba(31, 44, 73, 0.55)',
  surfaceGlassStrong: 'rgba(31, 44, 73, 0.78)',

  // --- lines --------------------------------------------------------------
  border: '#243352',
  borderSoft: 'rgba(120, 148, 200, 0.14)',
  borderStrong: '#33456B',

  // --- type ---------------------------------------------------------------
  text: '#EEF3FC',
  textMuted: '#93A3C2',
  textFaint: '#64749A',

  // --- accents ------------------------------------------------------------
  accent: '#5B94FF',
  accentBright: '#8AB4FF',
  accentSoft: '#16294F',
  /** Secondary accent, used only for gradient partners and chart stops. */
  violet: '#9C7BFF',
  violetSoft: '#241C4A',

  success: '#3DDC97',
  successSoft: '#0C3A2C',
  warning: '#FFC554',
  warningSoft: '#3B2D0C',
  danger: '#FF7A7A',
  dangerSoft: '#3D1A1A',
} as const;

/**
 * Gradient stop arrays, ready to spread into expo-linear-gradient's `colors`.
 * Kept here rather than inline so the same ramp is reused everywhere and a
 * palette change lands in one place.
 */
export const gradients = {
  /** App backdrop. Very low contrast on purpose — it should be felt, not seen. */
  ground: ['#0B1526', '#070B14', '#05080F'],
  /** Card sheen: a barely-there highlight along the top edge. */
  cardSheen: ['rgba(139, 170, 235, 0.10)', 'rgba(139, 170, 235, 0.00)'],
  /** Primary action. */
  primary: ['#5B94FF', '#4069E8'],
  /** Reserved for the hero figure's halo. */
  halo: ['rgba(91, 148, 255, 0.35)', 'rgba(91, 148, 255, 0.00)'],
  positive: ['#3DDC97', '#1FA97A'],
  negative: ['#FF7A7A', '#E04D4D'],
  /** Chart strokes get two hues so the line has movement along its length. */
  chartAccent: ['#5B94FF', '#9C7BFF'],
  chartPositive: ['#3DDC97', '#5B94FF'],
} as const;

/**
 * Coloured shadows. Android honours `elevation` only, so glow is approximated
 * there with a slightly stronger elevation; the coloured halo comes from a
 * gradient view behind the element instead. Do not rely on shadowColor alone.
 */
export const glow = {
  accent: {
    shadowColor: colors.accent,
    shadowOpacity: 0.45,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  success: {
    shadowColor: colors.success,
    shadowOpacity: 0.4,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  danger: {
    shadowColor: colors.danger,
    shadowOpacity: 0.4,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
} as const;

/** Neutral depth, for things that should lift without drawing the eye. */
export const elevation = {
  low: {
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  medium: {
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  high: {
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 12 },
    elevation: 16,
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

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  xxl: 28,
  pill: 999,
} as const;

/**
 * Font families. The names match what `useFonts` registers in app/_layout.tsx —
 * if you change one, change it there too.
 *
 * Sora carries the display sizes because its wide apertures hold up at 40px+.
 * Inter does everything else. Numbers that sit in aligned columns use
 * `tabularNums` below.
 */
export const fonts = {
  display: 'Sora_700Bold',
  displayMedium: 'Sora_600SemiBold',
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

export const type = {
  /** The one big number on a screen. Never more than one. */
  hero: {
    fontFamily: fonts.display,
    fontSize: 44,
    lineHeight: 50,
    letterSpacing: -1.2,
  },
  display: {
    fontFamily: fonts.display,
    fontSize: 30,
    lineHeight: 36,
    letterSpacing: -0.6,
  },
  title: {
    fontFamily: fonts.displayMedium,
    fontSize: 22,
    lineHeight: 28,
    letterSpacing: -0.3,
  },
  heading: {
    fontFamily: fonts.bodySemi,
    fontSize: 16,
    lineHeight: 22,
    letterSpacing: -0.1,
  },
  body: {
    fontFamily: fonts.body,
    fontSize: 15,
    lineHeight: 21,
  },
  bodyStrong: {
    fontFamily: fonts.bodyMedium,
    fontSize: 15,
    lineHeight: 21,
  },
  /** Field labels and table headers. Uppercase is applied at the call site. */
  label: {
    fontFamily: fonts.bodySemi,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.6,
  },
  caption: {
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: 17,
  },
  /** Statistic values inside tiles. */
  stat: {
    fontFamily: fonts.display,
    fontSize: 24,
    lineHeight: 30,
    letterSpacing: -0.4,
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
