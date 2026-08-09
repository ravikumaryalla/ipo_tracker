import { Stack } from 'expo-router';

import { colors } from '../../constants/theme';

export default function VaultLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        // The vault gate is not dismissible by swiping back.
        gestureEnabled: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    />
  );
}
