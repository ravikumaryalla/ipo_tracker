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

export function Badge({
  label,
  tone = 'muted',
}: {
  label: string;
  tone?: 'muted' | 'success' | 'warning' | 'danger' | 'accent';
}) {
  const map = {
    muted: [colors.surfaceRaised, colors.textMuted],
    success: [colors.successSoft, colors.success],
    warning: [colors.warningSoft, colors.warning],
    danger: [colors.dangerSoft, colors.danger],
    accent: [colors.accentSoft, colors.accentBright],
  } as const;
  const [bg, fg] = map[tone];
  return (
    <View style={[styles.badge, { backgroundColor: bg, borderColor: fg + '33' }]}>
      <Text style={[styles.badgeText, { color: fg }]}>{label.toUpperCase()}</Text>
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

export function Banner({
  tone = 'warning',
  children,
}: {
  tone?: 'warning' | 'danger' | 'info';
  children: React.ReactNode;
}) {
  const bg =
    tone === 'danger' ? colors.dangerSoft : tone === 'info' ? colors.accentSoft : colors.warningSoft;
  const fg =
    tone === 'danger' ? colors.danger : tone === 'info' ? colors.accentBright : colors.warning;
  const icon: IconName = tone === 'danger' ? 'warning' : tone === 'info' ? 'info' : 'warning';
  return (
    <View style={[styles.banner, { backgroundColor: bg, borderColor: fg + '2E' }]}>
      <Icon name={icon} size={18} color={fg} />
      <Text style={[styles.bannerText, { color: fg }]}>{children}</Text>
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
  sectionTitle: { ...type.label, color: colors.textFaint },
  badge: {
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    alignSelf: 'flex-start',
  },
  badgeText: { ...type.label, fontSize: 10, letterSpacing: 0.8 },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    backgroundColor: colors.dangerSoft,
    borderWidth: 1,
    borderColor: colors.danger + '33',
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  errorText: { ...type.caption, color: colors.danger, flex: 1, fontSize: 13 },
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  bannerText: { ...type.caption, flex: 1, fontSize: 13 },
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
