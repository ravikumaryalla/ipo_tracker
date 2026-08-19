/**
 * Badges, banners, errors, empty states and loading.
 *
 * Everything here keeps the exact prop shape the old components/ui.tsx had, so
 * the 17 screens importing ErrorText and the 10 importing Banner need no edits.
 */
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useEffect } from 'react';

import { colors, radius, spacing, type } from '../../constants/theme';
import { Icon, type IconName } from './Icon';

export function Heading({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <View style={{ marginBottom: spacing.xl }}>
      <Text style={styles.heading}>{children}</Text>
      {sub ? <Text style={styles.subheading}>{sub}</Text> : null}
    </View>
  );
}

export function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title.toUpperCase()}</Text>
      {action}
    </View>
  );
}

/**
 * Status pill. Doubles as the design system's Chip.
 *
 * `filled` is the design system's default and is what status chips in the
 * mockups use; `tonal` is the pale-background treatment the app used
 * throughout before, and stays the default so existing call sites are
 * unchanged. Labels are only uppercased in the tonal treatment — a filled chip
 * carries enough weight without it.
 */
export function Badge({
  label,
  tone = 'muted',
  variant = 'tonal',
  size = 'medium',
}: {
  label: string;
  tone?: 'muted' | 'success' | 'warning' | 'danger' | 'accent' | 'info' | 'navy';
  variant?: 'tonal' | 'filled' | 'outlined';
  size?: 'small' | 'medium';
}) {
  const map = {
    muted: [colors.surfaceAlt, colors.textMuted, colors.border],
    success: [colors.successSoft, colors.success, colors.success],
    warning: [colors.warningSoft, colors.warning, colors.warning],
    danger: [colors.dangerSoft, colors.danger, colors.danger],
    accent: [colors.accentSoft, colors.accent, colors.accent],
    info: [colors.infoSoft, colors.info, colors.info],
    navy: [colors.accentSoft, colors.navy, colors.navy],
  } as const;
  const [soft, strong, line] = map[tone];

  const box =
    variant === 'filled'
      ? { backgroundColor: strong, borderColor: strong }
      : variant === 'outlined'
        ? { backgroundColor: 'transparent', borderColor: line }
        : { backgroundColor: soft, borderColor: 'transparent' };
  const fg =
    variant === 'filled'
      ? tone === 'muted'
        ? colors.text
        : colors.onAccent
      : strong;

  return (
    <View style={[styles.badge, size === 'small' && styles.badgeSmall, box]}>
      <Text
        style={[styles.badgeText, size === 'small' && styles.badgeTextSmall, { color: fg }]}
        numberOfLines={1}
      >
        {variant === 'tonal' ? label.toUpperCase() : label}
      </Text>
    </View>
  );
}

export function ErrorText({ children }: { children?: string | null }) {
  if (!children) return null;
  return (
    <View style={styles.errorBox}>
      <Icon name="warning" size={18} color={colors.danger} />
      <Text style={styles.errorText}>{children}</Text>
    </View>
  );
}

/** Inline callout. Doubles as the design system's Alert. */
export function Banner({
  tone = 'warning',
  title,
  children,
}: {
  tone?: 'warning' | 'danger' | 'info' | 'success';
  /** Optional bold first line, for alerts that need a headline. */
  title?: string;
  children: React.ReactNode;
}) {
  const map = {
    warning: [colors.warningSoft, colors.warning, 'warning'],
    danger: [colors.dangerSoft, colors.danger, 'warning'],
    info: [colors.infoSoft, colors.info, 'info'],
    success: [colors.successSoft, colors.success, 'check'],
  } as const;
  const [bg, fg, icon] = map[tone];

  return (
    <View style={[styles.banner, { backgroundColor: bg }]}>
      <Icon name={icon as IconName} size={18} color={fg} />
      <View style={styles.bannerBody}>
        {title ? <Text style={[styles.bannerTitle, { color: fg }]}>{title}</Text> : null}
        <Text style={[styles.bannerText, { color: fg }]}>{children}</Text>
      </View>
    </View>
  );
}

export type AllotmentCheckResultTone = 'success' | 'neutral' | 'warning';

/**
 * One row per account after a bulk allotment check — a colored dot plus the
 * account and its outcome, instead of joining every account's message into
 * one flat paragraph of text where an allotted account reads no different
 * from an error.
 */
export function AllotmentCheckResults({
  results,
}: {
  results: { id: string; label: string; message: string; tone: AllotmentCheckResultTone }[];
}) {
  const dotColor: Record<AllotmentCheckResultTone, string> = {
    success: colors.success,
    neutral: colors.textFaint,
    warning: colors.warning,
  };
  const textColor: Record<AllotmentCheckResultTone, string> = {
    success: colors.success,
    neutral: colors.textMuted,
    warning: colors.warning,
  };

  return (
    <View style={styles.resultList}>
      {results.map((r, i) => (
        <View
          key={r.id}
          style={[styles.resultRow, i === results.length - 1 && { borderBottomWidth: 0 }]}
        >
          <View style={[styles.resultDot, { backgroundColor: dotColor[r.tone] }]} />
          <View style={{ flex: 1 }}>
            <Text style={styles.resultLabel}>{r.label}</Text>
            <Text style={[styles.resultMessage, { color: textColor[r.tone] }]}>{r.message}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

export function EmptyState({
  title,
  body,
  icon = 'empty',
}: {
  title: string;
  body: string;
  icon?: IconName;
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Icon name={icon} size={30} color={colors.textFaint} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

/** A single shimmering placeholder block. */
export function Skeleton({ height = 16, width = '100%' as number | string, style = {} }) {
  const shimmer = useSharedValue(0.4);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (reduceMotion) return;
    shimmer.value = withRepeat(
      withTiming(0.9, { duration: 900, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [reduceMotion, shimmer]);

  const animated = useAnimatedStyle(() => ({ opacity: shimmer.value }));

  return (
    <Animated.View
      style={[
        { height, width: width as number, borderRadius: radius.sm, backgroundColor: colors.surfaceAlt },
        style,
        animated,
      ]}
    />
  );
}

export function Loading({ label }: { label?: string }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colors.accent} />
      {label ? <Text style={styles.loadingLabel}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { ...type.display, color: colors.text },
  subheading: { ...type.body, color: colors.textMuted, marginTop: spacing.sm },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
  sectionTitle: { ...type.label, color: colors.textMuted },
  badge: {
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    alignSelf: 'flex-start',
  },
  badgeSmall: { paddingHorizontal: spacing.sm + 2, paddingVertical: 3 },
  badgeText: { ...type.label, fontSize: 10, letterSpacing: 0.8 },
  badgeTextSmall: { fontSize: 9.5, letterSpacing: 0.4 },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  errorText: { ...type.caption, color: colors.danger, flex: 1, fontSize: 13 },
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  bannerBody: { flex: 1, gap: 2 },
  bannerTitle: { ...type.bodyStrong, fontSize: 13 },
  bannerText: { ...type.caption, fontSize: 13 },
  resultList: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  resultDot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  resultLabel: { ...type.bodyStrong, color: colors.text, fontSize: 13 },
  resultMessage: { ...type.caption, fontSize: 12.5, marginTop: 2 },
  empty: { alignItems: 'center', paddingVertical: spacing.xxxl, paddingHorizontal: spacing.xl },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  emptyTitle: { ...type.heading, color: colors.text, marginBottom: spacing.sm },
  emptyBody: { ...type.body, color: colors.textMuted, textAlign: 'center' },
  loading: { padding: spacing.xxl, alignItems: 'center', gap: spacing.md },
  loadingLabel: { ...type.caption, color: colors.textMuted },
});
