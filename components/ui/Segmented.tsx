/**
 * Segmented filter control.
 *
 * Scrolls horizontally rather than wrapping: the IPO buckets carry counts that
 * change width as data loads, and a wrapping row reflows to two lines and shifts
 * the whole list down when it does.
 */
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, gradients, radius, spacing, type } from '../../constants/theme';

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
            {active && (
              <LinearGradient
                colors={gradients.primary}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
            )}
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
  scroll: { marginBottom: spacing.lg, marginHorizontal: -spacing.lg },
  row: { gap: spacing.sm, paddingHorizontal: spacing.lg },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md - 2,
    overflow: 'hidden',
  },
  chipOn: { borderColor: 'transparent' },
  label: { ...type.label, fontSize: 12, letterSpacing: 0.2, color: colors.textMuted },
  labelOn: { color: '#FFFFFF' },
  count: {
    minWidth: 20,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
  },
  countOn: { backgroundColor: 'rgba(255,255,255,0.25)' },
  countText: { ...type.label, fontSize: 10, color: colors.textMuted },
  countTextOn: { color: '#FFFFFF' },
});
