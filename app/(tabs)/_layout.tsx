/**
 * Tab navigation.
 *
 * The bar floats above the content rather than sitting in a docked strip: it is
 * inset from the edges, rounded, and solid so scrolled content never shows
 * through it. The active tab is marked by a gradient pill that grows behind the
 * icon, which is why each item animates its own indicator instead of the bar
 * sliding one shared marker — the pill has to size itself to its label.
 */
import { LinearGradient } from 'expo-linear-gradient';
import { Tabs } from 'expo-router';
import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '../../components/ui';
import { colors, gradients, motion, radius, spacing, type } from '../../constants/theme';

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

const TABS: { name: string; label: string; icon: IconName }[] = [
  { name: 'index', label: 'Dashboard', icon: 'dashboard' },
  { name: 'accounts', label: 'Accounts', icon: 'accounts' },
  { name: 'ipos', label: 'IPOs', icon: 'ipos' },
  { name: 'applications', label: 'Applied', icon: 'applications' },
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
      : withSpring(focused ? 1 : 0, { damping: 18, stiffness: 180 });
  }, [focused, reduceMotion, active]);

  const pillStyle = useAnimatedStyle(() => ({
    opacity: active.value,
    transform: [{ scale: 0.85 + active.value * 0.15 }],
  }));

  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: reduceMotion ? 0 : -active.value * 2 }],
  }));

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.item}
    >
      <Animated.View style={[StyleSheet.absoluteFill, styles.pillWrap, pillStyle]}>
        <LinearGradient
          colors={gradients.primary}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.pill}
        />
      </Animated.View>

      <Animated.View style={[styles.itemInner, iconStyle]}>
        <Icon name={icon} size={20} color={focused ? '#FFFFFF' : colors.textFaint} />
        <Text style={[styles.itemLabel, focused && styles.itemLabelActive]} numberOfLines={1}>
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

function FloatingTabBar({ state, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const enter = useSharedValue(reduceMotion ? 1 : 0);

  useEffect(() => {
    enter.value = withTiming(1, { duration: motion.slow });
  }, [enter]);

  const barStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [{ translateY: (1 - enter.value) * 24 }],
  }));

  return (
    <Animated.View
      style={[styles.barWrap, { paddingBottom: insets.bottom || spacing.md }, barStyle]}
      pointerEvents="box-none"
    >
      <View style={styles.bar}>
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
    </Animated.View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen key={tab.name} name={tab.name} options={{ title: tab.label }} />
      ))}
    </Tabs>
  );
}

const styles = StyleSheet.create({
  barWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
  },
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    padding: spacing.xs + 2,
    gap: spacing.xs,
    // Lifts the bar off the content behind it.
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 16,
  },
  item: {
    flex: 1,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  pillWrap: { borderRadius: radius.pill, overflow: 'hidden' },
  pill: { flex: 1 },
  itemInner: { alignItems: 'center', gap: 2 },
  itemLabel: { ...type.label, fontSize: 10, letterSpacing: 0.3, color: colors.textFaint },
  itemLabelActive: { color: '#FFFFFF' },
});
