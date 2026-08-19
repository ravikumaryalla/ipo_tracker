/**
 * Application detail: record the outcome once allotment is out, then the sale.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { Badge, Button, Card, ErrorText, Field, Loading, Screen } from '../../components/ui';
import { colors, formatInr, radius, spacing, type } from '../../constants/theme';
import { checkAllotment } from '../../lib/db/allotment';
import {
  deleteApplication,
  listApplications,
  updateApplicationOutcome,
} from '../../lib/db/applications';
import type { ApplicationStatus } from '../../lib/types';

const OUTCOMES: { key: ApplicationStatus; label: string }[] = [
  { key: 'APPLIED', label: 'Still pending' },
  { key: 'ALLOTTED', label: 'Allotted' },
  { key: 'PARTIAL', label: 'Partial' },
  { key: 'NOT_ALLOTTED', label: 'Not allotted' },
  { key: 'REFUNDED', label: 'Refunded' },
  { key: 'WITHDRAWN', label: 'Withdrawn' },
];

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

export default function ApplicationDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  const applications = useQuery({ queryKey: ['applications'], queryFn: listApplications });
  const application = applications.data?.find((a) => a.id === id);

  const [status, setStatus] = useState<ApplicationStatus | null>(null);
  const [sharesAllotted, setSharesAllotted] = useState('');
  const [sellPrice, setSellPrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  const checkNow = useMutation({
    mutationFn: () =>
      checkAllotment(
        id!,
        {
          kfintech_company_id: application?.kfintech_company_id ?? null,
          bigshare_company_id: application?.bigshare_company_id ?? null,
          mufg_company_id: application?.mufg_company_id ?? null,
          registrar: application?.registrar ?? null,
        },
        application!.ipo_id,
      ),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['applications'] });

      const { title, message } =
        result.outcome === 'resolved'
          ? result.status === 'ALLOTTED'
            ? {
                title: 'Allotted',
                message: `You got ${result.shares_allotted} of ${result.shares_applied} shares.`,
              }
            : result.status === 'PARTIAL'
              ? {
                  title: 'Partial allotment',
                  message: `${result.shares_allotted} of ${result.shares_applied} shares allotted.`,
                }
              : { title: 'Not allotted', message: 'No shares this time.' }
          : result.outcome === 'not-yet'
            ? { title: 'Not announced yet', message: 'Results were not announced.' }
            : { title: 'Could not check', message: result.message ?? 'Please try again.' };
      Alert.alert(title, message);
    },
    onError: (e) => {
      // Only reached on a genuine failure to even reach the check service —
      // every other outcome (no match, no PAN, not announced, resolved)
      // comes back via onSuccess now, since check-allotments reports it
      // rather than throwing.
      setCheckError(e instanceof Error ? e.message : 'Could not check allotment.');
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      const nextStatus = status ?? application!.status;
      const shares = sharesAllotted === '' ? application!.shares_allotted : Number(sharesAllotted);

      if (Number.isNaN(shares) || shares < 0) throw new Error('Enter a valid number of shares.');
      if (shares > application!.shares_applied) {
        throw new Error(`You applied for ${application!.shares_applied} shares — allotment cannot exceed that.`);
      }
      if (nextStatus === 'ALLOTTED' && shares === 0) {
        throw new Error('Enter how many shares were allotted.');
      }

      const sell = sellPrice.trim() === '' ? null : Number(sellPrice);
      if (sell !== null && (Number.isNaN(sell) || sell <= 0)) {
        throw new Error('Enter a valid sale price.');
      }

      return updateApplicationOutcome(id!, {
        status: nextStatus,
        shares_allotted: shares,
        sell_price: sell,
        sold_at: sell !== null ? new Date().toISOString() : null,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['applications'] });
      setStatus(null);
      setSharesAllotted('');
      setSellPrice('');
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save.'),
  });

  const remove = useMutation({
    mutationFn: () => deleteApplication(id!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['applications'] });
      router.back();
    },
  });

  if (applications.isLoading) return <Loading />;
  if (!application) {
    return (
      <Screen>
        <Text style={styles.label}>This application no longer exists.</Text>
      </Screen>
    );
  }

  const pnl = Number(application.realised_pnl) + Number(application.unrealised_pnl);
  const current = status ?? application.status;

  return (
    <Screen>
      <View style={{ marginBottom: spacing.lg }}>
        <Text style={styles.title}>{application.company_name}</Text>
        <Text style={styles.subtitle}>
          {application.account_nickname} · {application.category}
        </Text>
      </View>

      <ErrorText>{error}</ErrorText>

      <Card>
        <Row label="Lots" value={`${application.lots} (${application.shares_applied} shares)`} />
        <Row label="Bid price" value={formatInr(Number(application.bid_price))} />
        <Row label="Amount blocked" value={formatInr(Number(application.amount_blocked))} />
        <Row label="Applied on" value={new Date(application.applied_at).toLocaleDateString('en-IN')} />
      </Card>

      {application.status === 'APPLIED' && (
        <Card>
          <Text style={styles.section}>Check allotment</Text>
          <Text style={[styles.label, { marginBottom: spacing.md }]}>
            Check your allotment status directly instead of visiting the registrar's site.
          </Text>
          <ErrorText>{checkError}</ErrorText>
          <Button
            title="Check allotment now"
            onPress={() => {
              setCheckError(null);
              checkNow.mutate();
            }}
            loading={checkNow.isPending}
          />
          {application.allotment_checked_at && (
            <Text style={[styles.label, { marginTop: spacing.md }]}>
              Last checked{' '}
              {new Date(application.allotment_checked_at).toLocaleString('en-IN', {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </Text>
          )}
        </Card>
      )}

      {application.shares_allotted > 0 && (
        <Card>
          <Row label="Shares allotted" value={String(application.shares_allotted)} />
          <Row label="Invested" value={formatInr(Number(application.amount_invested))} />
          <Row label="Listing price" value={formatInr(application.listing_price)} />
          {application.sell_price !== null && (
            <Row label="Sold at" value={formatInr(Number(application.sell_price))} />
          )}
          <View style={styles.row}>
            <Text style={styles.label}>
              {application.sell_price !== null ? 'Realised P&L' : 'Unrealised P&L'}
            </Text>
            <Text
              style={[
                styles.value,
                { color: pnl > 0 ? colors.success : pnl < 0 ? colors.danger : colors.text },
              ]}
            >
              {pnl >= 0 ? '+' : ''}
              {formatInr(pnl)}
            </Text>
          </View>
        </Card>
      )}

      <Card>
        <Text style={styles.section}>Update outcome</Text>

        <View style={styles.chipRow}>
          {OUTCOMES.map((o) => (
            <Pressable
              key={o.key}
              onPress={() => setStatus(o.key)}
              style={[styles.chip, o.key === current && styles.chipOn]}
            >
              <Text style={[styles.chipText, o.key === current && styles.chipTextOn]}>
                {o.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {(current === 'ALLOTTED' || current === 'PARTIAL') && (
          <View style={{ marginTop: spacing.lg }}>
            <Field
              label="Shares allotted"
              value={sharesAllotted}
              onChangeText={setSharesAllotted}
              keyboardType="number-pad"
              placeholder={String(application.shares_allotted || application.shares_applied)}
              hint={`You applied for ${application.shares_applied}.`}
            />
            <Field
              label="Sale price (optional)"
              value={sellPrice}
              onChangeText={setSellPrice}
              keyboardType="decimal-pad"
              hint="Fill this in once you have sold, to move the P&L from unrealised to realised."
            />
          </View>
        )}

        <Button
          title="Save outcome"
          onPress={() => {
            setError(null);
            save.mutate();
          }}
          loading={save.isPending}
        />
      </Card>

      <Button
        title="Delete this application"
        variant="danger"
        onPress={() =>
          Alert.alert('Delete this application?', 'This cannot be undone.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: () => remove.mutate() },
          ])
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...type.title, color: colors.text },
  subtitle: { ...type.body, color: colors.textMuted, marginTop: 2 },
  section: { ...type.heading, color: colors.text, marginBottom: spacing.md },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
    gap: spacing.lg,
  },
  label: { ...type.body, color: colors.textMuted, fontSize: 14 },
  value: { ...type.bodyStrong, color: colors.text, fontSize: 14 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chipOn: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  chipText: { ...type.label, color: colors.textMuted, fontSize: 12, letterSpacing: 0.2 },
  chipTextOn: { color: colors.accent },
});
