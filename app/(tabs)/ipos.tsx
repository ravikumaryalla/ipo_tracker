import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Heading,
  Icon,
  Loading,
  Screen,
  Segmented,
} from '../../components/ui';
import { colors, formatInr, motion, spacing, type } from '../../constants/theme';
import { bucketOf, latestSyncStatus, listIpos, type IpoBucket } from '../../lib/db/ipos';

const TABS: { key: IpoBucket; label: string }[] = [
  { key: 'open', label: 'Open now' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'closed', label: 'Closed' },
  { key: 'listed', label: 'Listed' },
];

/** Flag the list as stale once the newest successful sync is over a day old. */
const STALE_AFTER_HOURS = 30;

/** Each bucket gets its own rail colour so the list reads at a glance. */
const BUCKET_ACCENT: Record<IpoBucket, string> = {
  open: colors.success,
  upcoming: colors.accent,
  closed: colors.textFaint,
  listed: colors.violet,
};

export default function IposTab() {
  const router = useRouter();
  const [tab, setTab] = useState<IpoBucket>('open');

  const ipos = useQuery({ queryKey: ['ipos'], queryFn: listIpos });
  const sync = useQuery({ queryKey: ['syncStatus'], queryFn: latestSyncStatus });

  const grouped = useMemo(() => {
    const out: Record<IpoBucket, typeof ipos.data> = {
      open: [],
      upcoming: [],
      closed: [],
      listed: [],
    };
    for (const ipo of ipos.data ?? []) out[bucketOf(ipo)]!.push(ipo);
    return out;
  }, [ipos.data]);

  const staleWarning = useMemo(() => {
    // Only the providers that actually supply the IPO list count towards
    // freshness. The GMP feed and the cron heartbeat also write sync_log, and a
    // run where only those succeeded would otherwise suppress a genuine "this
    // list is days old" warning.
    const listRows = sync.data?.filter(
      (row) => row.provider !== 'CHITTORGARH_GMP' && row.provider !== 'CRON',
    );
    const lastOk = listRows?.filter((row) => row.ok).sort((a, b) => b.ran_at.localeCompare(a.ran_at))[0];
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

  const visible = grouped[tab] ?? [];

  return (
    <Screen inset>
      <Heading sub="Everything currently in the market, grouped by where it is in its cycle.">
        IPOs
      </Heading>

      <ErrorText>{ipos.error instanceof Error ? ipos.error.message : null}</ErrorText>
      {staleWarning && <Banner tone="warning">{staleWarning}</Banner>}

      <Segmented
        value={tab}
        onChange={setTab}
        options={TABS.map((t) => ({ ...t, count: grouped[t.key]!.length }))}
      />

      <Button
        title="Add an IPO manually"
        variant="secondary"
        icon="add"
        onPress={() => router.push('/ipos/new')}
      />

      {visible.length === 0 ? (
        <EmptyState
          icon="ipos"
          title={`Nothing ${tab === 'open' ? 'open right now' : `in ${tab}`}`}
          body="Synced IPOs appear here automatically. You can also add one by hand at any time."
        />
      ) : (
        visible.map((ipo, i) => (
          <Animated.View
            key={ipo.id}
            entering={FadeInDown.delay(i * motion.stagger).duration(motion.base)}
          >
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push(`/ipos/${ipo.id}`)}
            >
              <Card variant="glass" style={styles.card}>
                <View style={[styles.rail, { backgroundColor: BUCKET_ACCENT[tab] }]} />

              <View style={styles.head}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name} numberOfLines={1}>
                    {ipo.company_name}
                  </Text>
                  <Text style={styles.symbol}>
                    {ipo.symbol} · {ipo.exchange}
                  </Text>
                </View>
                {ipo.segment === 'SME' && <Badge label="SME" tone="accent" />}
                <Icon name="chevron" size={18} color={colors.textFaint} />
              </View>

              <View style={styles.metaRow}>
                {ipo.price_band_min !== null && (
                  <Meta
                    icon="savings"
                    text={`${formatInr(ipo.price_band_min)}${
                      ipo.price_band_max && ipo.price_band_max !== ipo.price_band_min
                        ? ` – ${formatInr(ipo.price_band_max)}`
                        : ''
                    }`}
                  />
                )}
                {ipo.lot_size ? <Meta icon="applications" text={`${ipo.lot_size}/lot`} /> : null}
                {ipo.close_date ? (
                  <Meta
                    icon="calendar"
                    text={`closes ${new Date(ipo.close_date).toLocaleDateString('en-IN', {
                      day: 'numeric',
                      month: 'short',
                    })}`}
                  />
                ) : null}
                </View>
              </Card>
            </Pressable>
          </Animated.View>
        ))
      )}
    </Screen>
  );
}

function Meta({ icon, text }: { icon: 'savings' | 'applications' | 'calendar'; text: string }) {
  return (
    <View style={styles.meta}>
      <Icon name={icon} size={13} color={colors.textFaint} />
      <Text style={styles.metaText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { paddingLeft: spacing.lg + 4 },
  rail: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  name: { ...type.heading, color: colors.text },
  symbol: { ...type.caption, color: colors.textMuted, marginTop: 2 },
  metaRow: {
    flexDirection: 'row',
    gap: spacing.lg,
    marginTop: spacing.lg,
    flexWrap: 'wrap',
  },
  meta: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 1 },
  metaText: { ...type.caption, color: colors.textFaint },
});
