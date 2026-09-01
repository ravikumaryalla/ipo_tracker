/**
 * Application detail: record the outcome once allotment is out, then the sale.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Badge, Button, Card, ErrorText, Field, Loading, Screen } from '../../components/ui';
import { colors, formatInr, radius, spacing, type } from '../../constants/theme';
import {
  deleteApplication,
  listApplications,
  updateApplicationOutcome,
} from '../../lib/db/applications';
import { formatDateTime, STATUS_LABEL, STATUS_TONE } from '../../lib/status';
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
  const [listingGain, setListingGain] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Seed the listing-gain field from the stored value once the row loads. The
  // single "Save outcome" button treats an empty field as "clear", so an
  // unseeded field would silently wipe a recorded gain the moment the user
  // reopened this card to change something else.
  useEffect(() => {
    setListingGain(application?.listing_gain != null ? String(application.listing_gain) : '');
  }, [application?.id]);

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

      const rawGain = listingGain.trim().replace(/[₹,\s]/g, '');
      let gain: number | null = null;
      if (rawGain !== '' && rawGain !== '-') {
        gain = Number(rawGain);
        if (Number.isNaN(gain)) throw new Error('Enter a valid listing gain amount.');
      }
      const keepsGain = nextStatus === 'ALLOTTED' || nextStatus === 'PARTIAL';

      return updateApplicationOutcome(id!, {
        status: nextStatus,
        shares_allotted: shares,
        sell_price: sell,
        sold_at: sell !== null ? new Date().toISOString() : null,
        // Clear any recorded gain when the outcome is no longer an allotment,
        // so a value the user can no longer see can't linger on the row.
        listing_gain: keepsGain ? gain : null,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['applications'] });
      setStatus(null);
      setSharesAllotted('');
      setSellPrice('');
      setListingGain('');
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
      <View style={styles.head}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title}>{application.company_name}</Text>
          <Text style={styles.subtitle}>
            {application.account_nickname} · {application.category}
          </Text>
        </View>
        <Badge label={STATUS_LABEL[application.status]} tone={STATUS_TONE[application.status]} />
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
          <Button
            title="Check allotment now"
            onPress={() => router.push(`/allotment/${application.ipo_id}`)}
          />
          {application.allotment_checked_at && (
            <Text style={[styles.label, { marginTop: spacing.md }]}>
              Last checked {formatDateTime(application.allotment_checked_at)}
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
          {application.listing_gain != null ? (
            <View style={styles.row}>
              <Text style={styles.label}>Listing gain (entered)</Text>
              <Text
                style={[
                  styles.value,
                  {
                    color:
                      Number(application.listing_gain) > 0
                        ? colors.success
                        : Number(application.listing_gain) < 0
                          ? colors.danger
                          : colors.text,
                  },
                ]}
              >
                {Number(application.listing_gain) >= 0 ? '+' : ''}
                {formatInr(Number(application.listing_gain))}
              </Text>
            </View>
          ) : (
            <Row label="Listing gain (entered)" value="—" />
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
          <>
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
            <Field
              label="Listing gain (₹)"
              value={listingGain}
              onChangeText={setListingGain}
              keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'numeric'}
              placeholder="Amount you booked on this allotment"
              hint="Enter a minus sign for a listing loss. Leave blank if not booked yet."
            />
          </>
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

      <View style={{ marginTop: spacing.lg }}>
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
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
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
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
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
