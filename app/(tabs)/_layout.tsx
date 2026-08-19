/**
 * Tab navigation.
 *
 * A docked bar: full-bleed, sitting on the bottom edge behind a hairline, the
 * way the design system draws it. The active tab is marked by colour alone
 * (navy against slate) plus the platform's own selected state, so there is no
 * indicator to size or slide — each item only crossfades its own tint.
 */
import { Tabs } from 'expo-router';
import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '../../components/ui';
import { colors, motion, type } from '../../constants/theme';

/**
 * expo-router 57 vendors React Navigation inside its own build output, so
 * `@react-navigation/bottom-tabs` is not resolvable as a package and its
 * `BottomTabBarProps` cannot be imported. Reaching into
 * `expo-router/build/react-navigation/...` would bind us to a private path that
 * can move in a patch release, so we declare only the surface this bar touches.
 */
type TabBarProps = {
  state: {
    index: number;
    routes: { key: string; name: string }[];
  };
  navigation: {
    emit(event: {
      type: 'tabPress';
      target: string;
      canPreventDefault: true;
    }): { defaultPrevented: boolean };
    navigate(name: string): void;
  };
};

/**
 * Order is the bar's left-to-right order. `index` must stay named `index`:
 * app/_layout.tsx and app/vault/setup.tsx both `router.replace('/(tabs)')`,
 * which resolves to this group's index route.
 */
const TABS: { name: string; label: string; icon: IconName }[] = [
  { name: 'index', label: 'Home', icon: 'home' },
  { name: 'applications', label: 'Allotment', icon: 'clock' },
  { name: 'accounts', label: 'Demat', icon: 'briefcase' },
  { name: 'profile', label: 'Profile', icon: 'person' },
];

function TabItem({
  focused,
  label,
  icon,
  onPress,
}: {
  focused: boolean;
  label: string;
  icon: IconName;
  onPress: () => void;
}) {
  const active = useSharedValue(focused ? 1 : 0);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    active.value = reduceMotion
      ? focused
        ? 1
        : 0
      : withTiming(focused ? 1 : 0, { duration: motion.fast });
  }, [focused, reduceMotion, active]);

  const labelStyle = useAnimatedStyle(() => ({
    color: interpolateColor(active.value, [0, 1], [colors.slate, colors.navy]),
  }));

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.item}
    >
      {/*
        The icon is expo-symbols, whose tint is a native prop rather than a
        style, so it cannot be driven by reanimated — it switches outright while
        the label crossfades. At 150ms the difference is not visible.
      */}
      <Icon name={icon} size={22} color={focused ? colors.navy : colors.slate} />
      <Animated.Text style={[styles.itemLabel, labelStyle]} numberOfLines={1}>
        {label}
      </Animated.Text>
    </Pressable>
  );
}

function DockedTabBar({ state, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.bar, { height: 64 + insets.bottom, paddingBottom: insets.bottom }]}>
      {state.routes.map((route, index) => {
        const meta = TABS.find((t) => t.name === route.name);
        if (!meta) return null;
        const focused = state.index === index;

        return (
          <TabItem
            key={route.key}
            focused={focused}
            label={meta.label}
            icon={meta.icon}
            onPress={() => {
              const event = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });
              if (!focused && !event.defaultPrevented) {
                navigation.navigate(route.name);
              }
            }}
          />
        );
      })}
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <DockedTabBar {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen key={tab.name} name={tab.name} options={{ title: tab.label }} />
      ))}
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  itemLabel: { ...type.label, fontSize: 10.5, letterSpacing: 0.1 },
});
