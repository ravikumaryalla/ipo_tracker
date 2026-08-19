/**
 * Displays one stored credential.
 *
 * Everything here exists to shorten the window in which a secret is visible or
 * recoverable:
 *   - hidden behind dots until explicitly revealed
 *   - auto-hides again after AUTO_HIDE_MS
 *   - screen capture is blocked for as long as anything is revealed
 *   - a copied value is wiped from the clipboard after CLIPBOARD_CLEAR_MS
 */
import * as Clipboard from 'expo-clipboard';
import * as ScreenCapture from 'expo-screen-capture';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing, type } from '../constants/theme';
import { Icon } from './ui';

const AUTO_HIDE_MS = 15_000;
const CLIPBOARD_CLEAR_MS = 30_000;

export function SecretField({
  label,
  value,
  monospace = false,
}: {
  label: string;
  value: string;
  monospace?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clipboardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!revealed) return;
    ScreenCapture.preventScreenCaptureAsync().catch(() => undefined);
    hideTimer.current = setTimeout(() => setRevealed(false), AUTO_HIDE_MS);
    return () => {
      ScreenCapture.allowScreenCaptureAsync().catch(() => undefined);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [revealed]);

  async function onCopy() {
    await Clipboard.setStringAsync(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);

    if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
    clipboardTimer.current = setTimeout(async () => {
      // Only clear if our value is still the one on the clipboard, so we don't
      // wipe something the user copied afterwards.
      const current = await Clipboard.getStringAsync().catch(() => '');
      if (current === value) await Clipboard.setStringAsync('');
    }, CLIPBOARD_CLEAR_MS);
  }

  if (!value) {
    return (
      <View style={styles.row}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.notSet}>Not set</Text>
      </View>
    );
  }

  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.valueRow}>
        <Text
          style={[styles.value, monospace && styles.mono]}
          numberOfLines={revealed ? undefined : 1}
          selectable={revealed}
        >
          {revealed ? value : '•'.repeat(Math.min(value.length, 14))}
        </Text>

        <Pressable
          onPress={() => setRevealed((v) => !v)}
          hitSlop={8}
          style={styles.action}
          accessibilityRole="button"
          accessibilityLabel={revealed ? `Hide ${label}` : `Show ${label}`}
        >
          <Icon name={revealed ? 'hide' : 'reveal'} size={16} color={colors.accentBright} />
        </Pressable>

        <Pressable
          onPress={onCopy}
          hitSlop={8}
          style={[styles.action, copied && styles.actionDone]}
          accessibilityRole="button"
          accessibilityLabel={`Copy ${label}`}
        >
          <Icon
            name={copied ? 'check' : 'copy'}
            size={16}
            color={copied ? colors.success : colors.accentBright}
          />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
    paddingVertical: spacing.lg,
  },
  label: { ...type.label, color: colors.textMuted, marginBottom: spacing.sm },
  valueRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  value: { ...type.body, color: colors.text, flex: 1 },
  mono: { fontVariant: ['tabular-nums'], letterSpacing: 1.5 },
  notSet: { ...type.body, color: colors.textMuted, fontStyle: 'italic' },
  action: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.md,
  },
  actionDone: { borderColor: colors.success + '55' },
});
