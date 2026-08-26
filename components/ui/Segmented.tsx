/**
 * Segmented filter control.
 *
 * Scrolls horizontally rather than wrapping: the IPO buckets carry counts that
 * change width as data loads, and a wrapping row reflows to two lines and shifts
 * the whole list down when it does. The scroll lives inside the track, so the
 * control still reads as one contained object at any option count.
 *
 * Styling follows the design system's toggle group: a slate track, a white pill
 * under the selected option, navy label on it. Selection is carried by the pill
 * rather than by colour alone, so it survives a greyscale screenshot.
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, elevation, radius, spacing, type } from '../../constants/theme';

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string; count?: number }[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      style={styles.scroll}
    >
      {options.map((option) => {
        const active = option.key === value;
        return (
          <Pressable
            key={option.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.key)}
            style={[styles.chip, active && styles.chipOn]}
          >
            <Text style={[styles.label, active && styles.labelOn]}>{option.label}</Text>
            {option.count !== undefined && option.count > 0 ? (
              <View style={[styles.count, active && styles.countOn]}>
                <Text style={[styles.countText, active && styles.countTextOn]}>
                  {option.count}
                </Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    marginBottom: spacing.lg,
    backgroundColor: colors.slateTrack,
    borderRadius: radius.md,
    flexGrow: 0,
  },
  row: { gap: spacing.xs, padding: spacing.xs },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    borderRadius: radius.sm + 2,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
  chipOn: {
    backgroundColor: colors.surface,
    ...elevation[1],
  },
  label: { ...type.label, fontSize: 12, letterSpacing: 0, color: colors.slate },
  labelOn: { color: colors.navy },
  count: {
    minWidth: 18,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radius.pill,
    // A translucent tint of `colors.slate`, so it reads as part of the
    // unselected label rather than as a second colour.
    backgroundColor: 'rgba(100, 116, 139, 0.16)',
    alignItems: 'center',
  },
  countOn: { backgroundColor: colors.accentSoft },
  countText: { ...type.label, fontSize: 10, letterSpacing: 0, color: colors.slate },
  countTextOn: { color: colors.navy },
});
