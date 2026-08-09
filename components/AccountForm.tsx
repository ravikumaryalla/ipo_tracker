/**
 * Create/edit form for a demat account.
 *
 * Holds plaintext in component state while the user is typing — unavoidable —
 * but hands it straight to lib/db/accounts.ts, which is the only code that
 * turns it into ciphertext. Nothing here talks to Supabase directly.
 */
import * as ScreenCapture from 'expo-screen-capture';
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius, spacing, type } from '../constants/theme';
import type { DematAccount, DematAccountInput } from '../lib/db/accounts';
import type { Broker } from '../lib/types';
import { Button, Card, ErrorText, Field } from './ui';

export function AccountForm({
  brokers,
  initial,
  submitLabel,
  onSubmit,
  onDelete,
}: {
  brokers: Broker[];
  initial?: DematAccount;
  submitLabel: string;
  onSubmit: (input: DematAccountInput) => Promise<void>;
  onDelete?: () => void;
}) {
  const [nickname, setNickname] = useState(initial?.nickname ?? '');
  const [brokerId, setBrokerId] = useState<string | null>(initial?.broker_id ?? null);
  const [clientId, setClientId] = useState(initial?.client_id ?? '');
  const [dpId, setDpId] = useState(initial?.dp_id ?? '');
  const [boId, setBoId] = useState(initial?.bo_id ?? '');
  const [username, setUsername] = useState(initial?.username ?? '');
  const [password, setPassword] = useState(initial?.password ?? '');
  const [txnPassword, setTxnPassword] = useState(initial?.txn_password ?? '');
  const [upiId, setUpiId] = useState(initial?.upi_id ?? '');
  const [linkedBank, setLinkedBank] = useState(initial?.linked_bank ?? '');
  const [pan, setPan] = useState(initial?.pan ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Passwords are on screen in plaintext the whole time this form is open.
  useEffect(() => {
    ScreenCapture.preventScreenCaptureAsync().catch(() => undefined);
    return () => {
      ScreenCapture.allowScreenCaptureAsync().catch(() => undefined);
    };
  }, []);

  async function submit() {
    setError(null);
    if (!nickname.trim()) return setError('Give this account a name you will recognise.');

    setBusy(true);
    try {
      await onSubmit({
        nickname: nickname.trim(),
        broker_id: brokerId,
        client_id: clientId.trim(),
        dp_id: dpId.trim(),
        bo_id: boId.trim(),
        username: username.trim(),
        password,
        txn_password: txnPassword,
        upi_id: upiId.trim(),
        linked_bank: linkedBank.trim(),
        pan: pan.trim().toUpperCase(),
        notes,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save this account.');
      setBusy(false);
    }
  }

  return (
    <>
      <ErrorText>{error}</ErrorText>

      <Card>
        <Text style={styles.section}>Account</Text>

        <Field
          label="Name"
          value={nickname}
          onChangeText={setNickname}
          placeholder="Zerodha — main"
          hint="Shown in the list. Not encrypted, so keep it non-identifying."
        />

        <Text style={styles.label}>Broker</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.lg }}>
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            {brokers.map((broker) => (
              <Pressable
                key={broker.id}
                onPress={() => setBrokerId(broker.id === brokerId ? null : broker.id)}
                style={[styles.chip, broker.id === brokerId && styles.chipOn]}
              >
                <Text style={[styles.chipText, broker.id === brokerId && styles.chipTextOn]}>
                  {broker.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <Field label="Client ID" value={clientId} onChangeText={setClientId} placeholder="ZY1234" autoCapitalize="characters" />
        <Field label="DP ID" value={dpId} onChangeText={setDpId} placeholder="IN300394" autoCapitalize="characters" />
        <Field label="BO ID / Demat number" value={boId} onChangeText={setBoId} keyboardType="number-pad" />
      </Card>

      <Card>
        <Text style={styles.section}>Login</Text>
        <Text style={styles.sectionHint}>
          Encrypted on this phone before it is saved. The server never sees these.
        </Text>

        <Field label="Username" value={username} onChangeText={setUsername} autoCapitalize="none" />
        <Field label="Password" value={password} onChangeText={setPassword} autoCapitalize="none" secureTextEntry />
        <Field
          label="Transaction / PIN password"
          value={txnPassword}
          onChangeText={setTxnPassword}
          autoCapitalize="none"
          secureTextEntry
          hint="The second password brokers ask for when placing orders."
        />
      </Card>

      <Card>
        <Text style={styles.section}>For IPO applications</Text>

        <Field label="UPI ID" value={upiId} onChangeText={setUpiId} autoCapitalize="none" placeholder="you@okhdfcbank" />
        <Field label="Linked bank" value={linkedBank} onChangeText={setLinkedBank} placeholder="HDFC ••1234" />
        <Field label="PAN" value={pan} onChangeText={setPan} autoCapitalize="characters" maxLength={10} />
        <Field label="Notes" value={notes} onChangeText={setNotes} multiline numberOfLines={3} />
      </Card>

      <Button title={submitLabel} onPress={submit} loading={busy} />
      {onDelete && <Button title="Delete this account" variant="danger" onPress={onDelete} />}
    </>
  );
}

const styles = StyleSheet.create({
  section: { ...type.heading, color: colors.text, marginBottom: spacing.xs },
  sectionHint: { ...type.caption, color: colors.textFaint, marginBottom: spacing.lg },
  label: { ...type.label, color: colors.textMuted, marginBottom: spacing.sm },
  chip: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  chipOn: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  chipText: { ...type.body, color: colors.textMuted, fontSize: 13 },
  chipTextOn: { color: colors.accentBright, fontFamily: fonts.bodySemi },
});
