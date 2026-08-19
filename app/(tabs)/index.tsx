/**
 * Home.
 *
 * The IPO list, with a condensed portfolio header above the filter. That header
 * is the surviving half of the old dashboard: net position and the two figures
 * that qualify it. The rest of that screen — the allotment gauge and the
 * per-account breakdown — moved to Profile, where there is room to read it.
 *
 * Each row carries the metric that matters for where the IPO is in its cycle.
 * Grey-market premium is deliberately not among them: it lives in `ipo_gmp` and
 * is fetched per issue, so showing it here would mean one query per row. The
 * detail screen shows it, where it costs a single fetch.
 */
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import {
  AnimatedNumber,
  AppHeader,
  Avatar,
  Badge,
  Banner,
  Card,
  EmptyState,
  ErrorText,
  HeaderAction,
  Loading,
  Screen,
  Segmented,
} from '../../components/ui';
import {
  colors,
  formatInr,
  formatInrCompact,
  motion,
  spacing,
  type,
} from '../../constants/theme';
import { listApplications, summarise } from '../../lib/db/applications';
import { bucketOf, latestSyncStatus, listIpos, type IpoBucket } from '../../lib/db/ipos';
import type { Ipo } from '../../lib/types';

const TABS: { key: IpoBucket; label: string }[] = [
  { key: 'open', label: 'Open now' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'closed', label: 'Closed' },
  { key: 'listed', label: 'Listed' },
];

/** Flag the list as stale once the newest successful sync is over a day old. */
const STALE_AFTER_HOURS = 30;

/** The sync-ipos providers that write `ipos` rows; the rest are side legs. */
const LIST_PROVIDERS = new Set(['NSE', 'BSE', 'IPOWATCH', 'IPOGYANI']);

const BUCKET_BADGE: Record<
  IpoBucket,
  { label: string; tone: 'success' | 'info' | 'warning' | 'muted' }
> = {
  open: { label: 'Live', tone: 'success' },
  upcoming: { label: 'Upcoming', tone: 'info' },
  closed: { label: 'Closed', tone: 'warning' },
  listed: { label: 'Listed', tone: 'muted' },
};

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

/** Price band as a single string; collapses when the band is a fixed price. */
function priceBand(ipo: Ipo): string {
  if (ipo.price_band_min === null) return '—';
  const spread =
    ipo.price_band_max !== null && ipo.price_band_max !== ipo.price_band_min
      ? ` – ${formatInr(ipo.price_band_max)}`
      : '';
  return `${formatInr(ipo.price_band_min)}${spread}`;
}

/**
 * The right-hand figure on a card. Which one is worth showing depends on the
 * bucket: a listed issue is judged by what it did, an open one by what it costs
 * to enter.
 */
function trailingMetric(
  ipo: Ipo,
  bucket: IpoBucket,
): { label: string; value: string; tone: 'good' | 'bad' | 'plain' } {
  if (bucket === 'listed' && ipo.listing_price !== null && ipo.price_band_max) {
    const pct = ((ipo.listing_price - ipo.price_band_max) / ipo.price_band_max) * 100;
    return {
      label: 'Listing gain',
      value: `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`,
      tone: pct > 0 ? 'good' : pct < 0 ? 'bad' : 'plain',
    };
  }
  if (ipo.lot_size) {
    return { label: 'Lot size', value: `${ipo.lot_size} shares`, tone: 'plain' };
  }
  return {
    label: 'Issue size',
    value: ipo.issue_size_cr ? `₹${ipo.issue_size_cr} Cr` : '—',
    tone: 'plain',
  };
}

/** The one-line date note under each card. */
function dateNote(ipo: Ipo, bucket: IpoBucket): string {
  const today = new Date().toISOString().slice(0, 10);
  if (bucket === 'open') {
    if (ipo.close_date === today) return `Closes today · ${shortDate(ipo.close_date)}`;
    return ipo.open_date && ipo.close_date
      ? `Open ${shortDate(ipo.open_date)} – ${shortDate(ipo.close_date)}`
      : 'Open now';
  }
  if (bucket === 'upcoming') {
    return ipo.open_date ? `Opens ${shortDate(ipo.open_date)}` : 'Dates to be announced';
  }
  if (bucket === 'closed') {
    return ipo.allotment_date ? `Allotment ${shortDate(ipo.allotment_date)}` : 'Awaiting allotment';
  }
  return ipo.listing_date
    ? `Listed ${shortDate(ipo.listing_date)} on ${ipo.exchange}`
    : `Listed on ${ipo.exchange}`;
}

export default function Home() {
  const router = useRouter();
  const [tab, setTab] = useState<IpoBucket>('open');

  const ipos = useQuery({ queryKey: ['ipos'], queryFn: listIpos });
  const sync = useQuery({ queryKey: ['syncStatus'], queryFn: latestSyncStatus });
  const applications = useQuery({ queryKey: ['applications'], queryFn: listApplications });

  const summary = useMemo(() => summarise(applications.data ?? []), [applications.data]);

  const grouped = useMemo(() => {
    const out: Record<IpoBucket, Ipo[]> = { open: [], upcoming: [], closed: [], listed: [] };
    for (const ipo of ipos.data ?? []) out[bucketOf(ipo)].push(ipo);
    return out;
  }, [ipos.data]);

  const staleWarning = useMemo(() => {
    // Only the providers that actually supply the IPO list count towards
    // freshness. The GMP feeds, the GMP backfill, the KFintech match and the
    // cron heartbeat also write sync_log, and a run where only those succeeded
    // would otherwise suppress a genuine "this list is days old" warning.
    //
    // An allowlist rather than a denylist, so adding a provider cannot silently
    // start suppressing the warning. KFINTECH_MATCH is why that matters: it now
    // logs ok with "skipped: already synced once" on every run, so under a
    // denylist it always looked like a fresh successful sync.
    const listRows = sync.data?.filter((row) => LIST_PROVIDERS.has(row.provider));
    const lastOk = listRows
      ?.filter((row) => row.ok)
      .sort((a, b) => b.ran_at.localeCompare(a.ran_at))[0];
    if (!lastOk) {
      const failure = listRows?.[0];
      return failure
        ? `IPO sync is failing (${failure.provider}: ${failure.message ?? 'unknown error'}). Add IPOs manually until it recovers.`
        : null;
    }
    const hours = (Date.now() - new Date(lastOk.ran_at).getTime()) / 3_600_000;
    return hours > STALE_AFTER_HOURS
      ? `IPO list last updated ${Math.round(hours / 24)} day(s) ago. Check details before applying.`
      : null;
  }, [sync.data]);

  if (ipos.isLoading) return <Loading label="Loading IPOs…" />;

  const visible = grouped[tab];
  const netPnl = summary.realisedPnl + summary.unrealisedPnl;
  const netColor = netPnl > 0 ? colors.success : netPnl < 0 ? colors.danger : colors.text;

  return (
    <Screen
      inset
      header={
        <AppHeader
          title="IPO Tracker"
          right={
            <HeaderAction
              icon="add"
              label="Add an IPO manually"
              color={colors.accent}
              onPress={() => router.push('/ipos/new')}
            />
          }
        />
      }
    >
      {/* ---- portfolio header -------------------------------------------- */}
      <Card elevation={1} style={styles.summary}>
        <Text style={styles.summaryLabel}>NET POSITION</Text>
        <AnimatedNumber
          value={netPnl}
          format={formatInr}
          style={[styles.summaryValue, { color: netColor }]}
        />
        <View style={styles.summaryMeta}>
          <Text style={styles.summaryMetaText}>
            {formatInrCompact(summary.amountBlocked)} blocked
          </Text>
          <View style={styles.summaryDot} />
          <Text style={styles.summaryMetaText}>
            {summary.liveApplications} live · {summary.totalApplications} total
          </Text>
        </View>
      </Card>

      <ErrorText>{ipos.error instanceof Error ? ipos.error.message : null}</ErrorText>
      {staleWarning && <Banner tone="warning">{staleWarning}</Banner>}

      <Segmented
        value={tab}
        onChange={setTab}
        options={TABS.map((t) => ({ ...t, count: grouped[t.key].length }))}
      />

      {visible.length === 0 ? (
        <EmptyState
          icon="ipos"
          title={`Nothing ${tab === 'open' ? 'open right now' : `in ${tab}`}`}
          body="Synced IPOs appear here automatically. You can also add one by hand at any time."
        />
      ) : (
        visible.map((ipo, i) => {
          const badge = BUCKET_BADGE[tab];
          const metric = trailingMetric(ipo, tab);
          const metricColor =
            metric.tone === 'good'
              ? colors.success
              : metric.tone === 'bad'
                ? colors.danger
                : colors.text;

          return (
            <Animated.View
              key={ipo.id}
              entering={FadeInDown.delay(i * motion.stagger).duration(motion.base)}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={ipo.company_name}
                onPress={() => router.push(`/ipos/${ipo.id}`)}
              >
                <Card elevation={1}>
                  <View style={styles.head}>
                    <Avatar name={ipo.company_name} size={40} />
                    <View style={styles.headText}>
                      <Text style={styles.name} numberOfLines={1}>
                        {ipo.company_name}
                      </Text>
                      <Text style={styles.symbol} numberOfLines={1}>
                        {ipo.symbol} · {ipo.exchange}
                      </Text>
                    </View>
                    {ipo.segment === 'SME' ? (
                      <Badge label="SME" tone="navy" variant="outlined" size="small" />
                    ) : null}
                    <Badge label={badge.label} tone={badge.tone} variant="filled" size="small" />
                  </View>

                  <View style={styles.figures}>
                    <View style={styles.figure}>
                      <Text style={styles.figureLabel}>Price band</Text>
                      <Text style={styles.figureValue} numberOfLines={1}>
                        {priceBand(ipo)}
                      </Text>
                    </View>
                    <View style={styles.figure}>
                      <Text style={[styles.figureLabel, styles.alignRight]}>{metric.label}</Text>
                      <Text
                        style={[styles.figureValue, styles.alignRight, { color: metricColor }]}
                        numberOfLines={1}
                      >
                        {metric.value}
                      </Text>
                    </View>
                  </View>

                  <Text style={styles.dateNote}>{dateNote(ipo, tab)}</Text>
                </Card>
              </Pressable>
            </Animated.View>
          );
        })
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  summary: { marginBottom: spacing.lg },
  summaryLabel: { ...type.label, color: colors.textMuted, fontSize: 10.5 },
  summaryValue: { ...type.hero, marginTop: spacing.xs },
  summaryMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  summaryMetaText: { ...type.caption, color: colors.textMuted },
  summaryDot: {
    width: 3,
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.textFaint,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headText: { flex: 1, minWidth: 0 },
  name: { ...type.heading, color: colors.text },
  symbol: { ...type.caption, color: colors.textMuted, marginTop: 1 },
  figures: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  figure: { flex: 1, minWidth: 0 },
  figureLabel: { ...type.caption, color: colors.textMuted, fontSize: 11 },
  figureValue: { ...type.bodyStrong, color: colors.text, marginTop: 2 },
  alignRight: { textAlign: 'right' },
  dateNote: { ...type.caption, color: colors.textMuted, marginTop: spacing.sm },
});
