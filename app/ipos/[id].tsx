import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import {
  AllotmentCheckResults,
  type AllotmentCheckResultTone,
  Badge,
  Banner,
  Button,
  Card,
  Loading,
  Screen,
} from '../../components/ui';
import { colors, formatInr, spacing, type } from '../../constants/theme';
import {
  checkAllotmentsForIpo,
  type BulkAllotmentCheck,
  type OnDemandCheckResult,
} from '../../lib/db/allotment';
import { getIpo, gmpHistory, gmpIsStale, gmpTrend, latestGmp } from '../../lib/db/ipos';
import { listApplications } from '../../lib/db/applications';

function outcomeLabel(r: OnDemandCheckResult): string {
  if (r.outcome === 'resolved') {
    if (r.status === 'ALLOTTED') return `Allotted, ${r.shares_allotted} of ${r.shares_applied} shares`;
    if (r.status === 'PARTIAL') return `Partial, ${r.shares_allotted} of ${r.shares_applied} shares`;
    return 'Not allotted';
  }
  if (r.outcome === 'not-yet') return 'Results were not announced';
  return r.message ?? 'Could not check.';
}

function outcomeTone(r: OnDemandCheckResult): AllotmentCheckResultTone {
  if (r.outcome === 'resolved') return r.status === 'ALLOTTED' || r.status === 'PARTIAL' ? 'success' : 'neutral';
  if (r.outcome === 'not-yet') return 'neutral';
  return 'warning';
}

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

const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

const TREND_GLYPH = { up: '▲', down: '▼', flat: '–', unknown: '' } as const;
const TREND_COLOR = {
  up: colors.success,
  down: colors.danger,
  flat: colors.textMuted,
  unknown: colors.text,
} as const;

export default function IpoDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [checkResult, setCheckResult] = useState<BulkAllotmentCheck | null>(null);

  const ipo = useQuery({ queryKey: ['ipo', id], queryFn: () => getIpo(id!), enabled: Boolean(id) });
  const applications = useQuery({ queryKey: ['applications'], queryFn: listApplications });
  const gmp = useQuery({
    queryKey: ['gmp', id],
    queryFn: () => gmpHistory(id!),
    enabled: Boolean(id),
  });

  const check = useMutation({
    mutationFn: (ids: string[]) =>
      checkAllotmentsForIpo(id!, ids, ipo.data?.kfintech_company_id ?? null),
    onSuccess: async (outcome) => {
      if (outcome.matched) await queryClient.invalidateQueries({ queryKey: ['applications'] });
      setCheckResult(outcome);
    },
    onError: (e) => {
      // Only reached on a genuine failure to even reach the check service —
      // a real "not matched" result comes back via onSuccess, not thrown,
      // so nothing was persisted here and there's nothing to refetch.
      const message = e instanceof Error ? e.message : 'Could not check status.';
      setCheckResult({ matched: false, message });
    },
  });

  if (ipo.isLoading) return <Loading />;
  if (!ipo.data) return <Screen><Text style={styles.label}>Not found.</Text></Screen>;

  const data = ipo.data;
  const mine = (applications.data ?? []).filter((a) => a.ipo_id === id);
  const eligible = mine.filter((a) => a.status === 'APPLIED');
  const lastChecked = mine
    .map((a) => a.allotment_checked_at)
    .filter((v): v is string => v !== null)
    .sort()
    .at(-1);
  const lotAmount =
    data.lot_size && data.price_band_max ? data.lot_size * data.price_band_max : null;

  const gmpRows = gmp.data ?? [];
  const newestGmp = latestGmp(gmpRows);
  const trend = gmpTrend(gmpRows);

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

      {newestGmp?.gmp != null && (
        <Card>
          <View style={styles.gmpHeader}>
            <Text style={styles.sectionTitle}>Grey market premium</Text>
            <Text style={[styles.gmpValue, { color: TREND_COLOR[trend] }]}>
              {`${TREND_GLYPH[trend]} ${formatInr(newestGmp.gmp)}`}
              {newestGmp.gmp_percent != null ? ` (${newestGmp.gmp_percent}%)` : ''}
            </Text>
          </View>
          <Row label="Last updated" value={formatDateTime(newestGmp.observed_at)} />
          {gmpIsStale(gmpRows) && (
            <Text style={styles.caption}>
              This quote is over a day old. Grey market prices move by the hour.
            </Text>
          )}
          {/*
            Non-negotiable. GMP is unofficial dealer chatter, SEBI has cautioned
            retail investors against relying on it, and this card sits directly
            above an "Apply from an account" button.
          */}
          <Text style={styles.caption}>
            Unofficial grey-market estimate, not exchange data. It is not a prediction of the
            listing price. Source: ipowatch.in.
          </Text>
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

          {eligible.length > 0 && (
            <View style={{ marginTop: spacing.lg }}>
              <Button
                title="Check status"
                variant="secondary"
                onPress={() => {
                  setCheckResult(null);
                  check.mutate(eligible.map((a) => a.id));
                }}
                loading={check.isPending}
              />
              {lastChecked && (
                <Text style={[styles.label, { marginTop: spacing.sm }]}>
                  Last checked {formatDateTime(lastChecked)}
                </Text>
              )}
              {checkResult && !checkResult.matched && (
                <Banner tone="warning">{checkResult.message}</Banner>
              )}
              {checkResult && checkResult.matched && (
                <View style={{ marginTop: spacing.md }}>
                  <AllotmentCheckResults
                    results={checkResult.results.map((r) => {
                      const nickname = mine.find((a) => a.id === r.id)?.account_nickname ?? r.id;
                      return {
                        id: r.id,
                        label: nickname,
                        message: outcomeLabel(r),
                        tone: outcomeTone(r),
                      };
                    })}
                  />
                </View>
              )}
            </View>
          )}
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
  gmpHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
  },
  gmpValue: { ...type.bodyStrong, fontSize: 16 },
  caption: { ...type.body, color: colors.textMuted, fontSize: 12, marginTop: spacing.sm },
  label: { ...type.body, color: colors.textMuted, fontSize: 14, flexShrink: 1 },
  value: { ...type.bodyStrong, color: colors.text, fontSize: 14, textAlign: 'right', flexShrink: 1 },
});
