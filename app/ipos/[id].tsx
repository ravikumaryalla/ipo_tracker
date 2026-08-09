import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { Badge, Button, Card, Loading, Screen } from '../../components/ui';
import { colors, formatInr, spacing, type } from '../../constants/theme';
import { getIpo } from '../../lib/db/ipos';
import { listApplications } from '../../lib/db/applications';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export default function IpoDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const ipo = useQuery({ queryKey: ['ipo', id], queryFn: () => getIpo(id!), enabled: Boolean(id) });
  const applications = useQuery({ queryKey: ['applications'], queryFn: listApplications });

  if (ipo.isLoading) return <Loading />;
  if (!ipo.data) return <Screen><Text style={styles.label}>Not found.</Text></Screen>;

  const data = ipo.data;
  const mine = (applications.data ?? []).filter((a) => a.ipo_id === id);
  const lotAmount =
    data.lot_size && data.price_band_max ? data.lot_size * data.price_band_max : null;

  return (
    <Screen>
      <View style={{ marginBottom: spacing.lg }}>
        <Text style={styles.title}>{data.company_name}</Text>
        <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm }}>
          <Badge label={data.symbol} tone="muted" />
          <Badge label={data.segment} tone={data.segment === 'SME' ? 'accent' : 'muted'} />
          <Badge label={data.source} tone="muted" />
        </View>
      </View>

      <Card>
        <Row
          label="Price band"
          value={
            data.price_band_min
              ? `${formatInr(data.price_band_min)} – ${formatInr(data.price_band_max)}`
              : '—'
          }
        />
        <Row label="Lot size" value={data.lot_size ? `${data.lot_size} shares` : '—'} />
        <Row
          label="One lot costs"
          value={lotAmount ? formatInr(lotAmount) : '—'}
        />
        <Row label="Issue size" value={data.issue_size_cr ? `₹${data.issue_size_cr} Cr` : '—'} />
      </Card>

      <Card>
        <Row label="Opens" value={formatDate(data.open_date)} />
        <Row label="Closes" value={formatDate(data.close_date)} />
        <Row label="Allotment" value={formatDate(data.allotment_date)} />
        <Row label="Listing" value={formatDate(data.listing_date)} />
      </Card>

      {(data.listing_price || data.current_price) && (
        <Card>
          <Row label="Listing price" value={formatInr(data.listing_price)} />
          <Row label="Current price" value={formatInr(data.current_price)} />
        </Card>
      )}

      {mine.length > 0 && (
        <Card>
          <Text style={styles.sectionTitle}>Your applications</Text>
          {mine.map((a) => (
            <Row
              key={a.id}
              label={`${a.account_nickname} · ${a.category}`}
              value={`${a.lots} lot(s) · ${a.status}`}
            />
          ))}
        </Card>
      )}

      <Button
        title="Apply from an account"
        onPress={() => router.push(`/applications/new?ipoId=${id}`)}
      />

      {data.registrar_url && (
        <Button
          title={`Check allotment at ${data.registrar ?? 'registrar'}`}
          variant="secondary"
          onPress={() => Linking.openURL(data.registrar_url!)}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...type.title, color: colors.text },
  sectionTitle: { ...type.heading, color: colors.text, marginBottom: spacing.sm },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
    gap: spacing.lg,
  },
  label: { ...type.body, color: colors.textMuted, fontSize: 14, flexShrink: 1 },
  value: { ...type.bodyStrong, color: colors.text, fontSize: 14, textAlign: 'right', flexShrink: 1 },
});
