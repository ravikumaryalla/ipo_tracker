/**
 * Stat tile and list row — the two layouts this app repeats most.
 *
 * StatTile was previously a private component inside app/(tabs)/index.tsx;
 * it is shared now so the dashboard and the detail screens cannot drift apart.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { colors, motion, spacing, type } from '../../constants/theme';
import { Card } from './Card';
import { Icon, type IconName } from './Icon';

export function StatTile({
  label,
  value,
  tone = 'neutral',
  hint,
  icon,
  style,
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'neutral' | 'good' | 'bad';
  hint?: string;
  icon?: IconName;
  style?: ViewStyle;
}) {
  const valueColor =
    tone === 'good' ? colors.success : tone === 'bad' ? colors.danger : colors.text;

  return (
    <Card style={StyleSheet.flatten([styles.tile, style])} variant="glass">
      <View style={styles.tileHead}>
        <Text style={styles.tileLabel}>{label.toUpperCase()}</Text>
        {icon ? <Icon name={icon} size={16} color={colors.textFaint} /> : null}
      </View>
      {typeof value === 'string' || typeof value === 'number' ? (
        <Text style={[styles.tileValue, { color: valueColor }]}>{value}</Text>
      ) : (
        value
      )}
      {hint ? <Text style={styles.tileHint}>{hint}</Text> : null}
    </Card>
  );
}

/**
 * One tappable row. `index` staggers the entrance so a list assembles itself
 * instead of appearing all at once — reanimated skips this automatically when
 * the OS reduce-motion setting is on.
 */
export function ListRow({
  title,
  subtitle,
  right,
  onPress,
  icon,
  index = 0,
  accent,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  icon?: IconName;
  index?: number;
  /** Colour of the leading rail; omit for no rail. */
  accent?: string;
}) {
  const body = (
    <Card variant="glass" style={styles.row}>
      {accent ? <View style={[styles.rail, { backgroundColor: accent }]} /> : null}
      {icon ? (
        <View style={styles.rowIcon}>
          <Icon name={icon} size={18} color={colors.textMuted} />
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
      {onPress ? <Icon name="chevron" size={18} color={colors.textFaint} /> : null}
    </Card>
  );

  return (
    <Animated.View entering={FadeInDown.delay(index * motion.stagger).duration(motion.base)}>
      {onPress ? (
        <Pressable accessibilityRole="button" onPress={onPress}>
          {body}
        </Pressable>
      ) : (
        body
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  tile: { flexGrow: 1, flexBasis: '46%', marginBottom: 0 },
  tileHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  tileLabel: { ...type.label, color: colors.textMuted, fontSize: 11, flexShrink: 1 },
  tileValue: { ...type.stat, marginTop: spacing.sm },
  tileHint: { ...type.caption, color: colors.textFaint, fontSize: 11, marginTop: spacing.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.lg,
  },
  rail: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
  },
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { ...type.bodyStrong, color: colors.text },
  rowSubtitle: { ...type.caption, color: colors.textMuted, marginTop: 2 },
});
