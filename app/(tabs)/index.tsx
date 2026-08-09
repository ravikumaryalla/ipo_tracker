/**
 * Dashboard.
 *
 * One hero figure, then supporting detail. The net position gets the only
 * oversized number and the only glow on the screen — if a second element
 * competed with it, neither would read as the answer to "how am I doing?".
 */
import { useQuery } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import {
  AnimatedNumber,
  Badge,
  Card,
  DonutGauge,
  EmptyState,
  ErrorText,
  Icon,
  ListRow,
  Loading,
  Screen,
  SectionHeader,
  StatTile,
} from '../../components/ui';
import {
  colors,
  formatInr,
  formatInrCompact,
  gradients,
  motion,
  radius,
  spacing,
  type,
} from '../../constants/theme';
import { listApplications, summarise } from '../../lib/db/applications';
import { bucketOf, listIpos } from '../../lib/db/ipos';

export default function Dashboard() {
  const router = useRouter();

  const applications = useQuery({ queryKey: ['applications'], queryFn: listApplications });
  const ipos = useQuery({ queryKey: ['ipos'], queryFn: listIpos });

  const summary = useMemo(() => summarise(applications.data ?? []), [applications.data]);
  const openNow = useMemo(
    () => (ipos.data ?? []).filter((ipo) => bucketOf(ipo) === 'open'),
    [ipos.data],
  );

  if (applications.isLoading) return <Loading label="Loading your portfolio…" />;

  const netPnl = summary.realisedPnl + summary.unrealisedPnl;
  const netTone = netPnl > 0 ? 'good' : netPnl < 0 ? 'bad' : 'neutral';
  const netColor =
    netPnl > 0 ? colors.success : netPnl < 0 ? colors.danger : colors.text;

  return (
    <Screen inset>
      <ErrorText>
        {applications.error instanceof Error ? applications.error.message : null}
      </ErrorText>

      {/* ---- hero -------------------------------------------------------- */}
      <Animated.View entering={FadeIn.duration(motion.slow)}>
        <View style={styles.hero}>
          {/* The halo is a sibling behind the text, not a shadow: Android
              ignores coloured shadows, so a gradient is the portable way. */}
          <LinearGradient
            colors={netTone === 'bad' ? gradients.negative : gradients.halo}
            style={styles.halo}
            pointerEvents="none"
          />
          <Text style={styles.heroLabel}>NET POSITION</Text>
          <AnimatedNumber
            value={netPnl}
            format={formatInr}
            style={[styles.heroValue, { color: netColor }]}
          />
          <View style={styles.heroMeta}>
            <Badge
              label={`${summary.totalApplications} application${summary.totalApplications === 1 ? '' : 's'}`}
              tone={netTone === 'good' ? 'success' : netTone === 'bad' ? 'danger' : 'muted'}
            />
            {summary.liveApplications > 0 && (
              <Badge label={`${summary.liveApplications} live`} tone="accent" />
            )}
          </View>
        </View>
      </Animated.View>

      {/* ---- headline stats ---------------------------------------------- */}
      <Animated.View
        entering={FadeInDown.delay(motion.stagger).duration(motion.base)}
        style={styles.grid}
      >
        <StatTile
          label="Money blocked"
          value={formatInrCompact(summary.amountBlocked)}
          hint={`${summary.liveApplications} live application(s)`}
          icon="wallet"
        />
        <StatTile
          label="Allotment rate"
          icon="pie"
          value={
            <View style={styles.gaugeRow}>
              <DonutGauge value={summary.allotmentRate ?? 0} size={58} thickness={7}>
                <Text style={styles.gaugeText}>
                  {summary.allotmentRate === null
                    ? '—'
                    : `${Math.round(summary.allotmentRate * 100)}%`}
                </Text>
              </DonutGauge>
            </View>
          }
          hint={
            summary.allotmentRate === null
              ? 'No results yet'
              : `${summary.allottedApplications} of ${summary.decidedApplications} decided`
          }
        />
        <StatTile
          label="Realised P&L"
          value={formatInrCompact(summary.realisedPnl)}
          tone={summary.realisedPnl > 0 ? 'good' : summary.realisedPnl < 0 ? 'bad' : 'neutral'}
          hint="From shares you have sold"
          icon="savings"
        />
        <StatTile
          label="Unrealised"
          value={formatInrCompact(summary.unrealisedPnl)}
          tone={summary.unrealisedPnl > 0 ? 'good' : summary.unrealisedPnl < 0 ? 'bad' : 'neutral'}
          hint="Allotted but still held"
          icon="ipos"
        />
      </Animated.View>

      {/* ---- open right now ---------------------------------------------- */}
      {openNow.length > 0 && (
        <>
          <SectionHeader title="Open right now" />
          {openNow.map((ipo, i) => (
            <ListRow
              key={ipo.id}
              index={i}
              accent={colors.success}
              title={ipo.company_name}
              subtitle={`Closes ${
                ipo.close_date
                  ? new Date(ipo.close_date).toLocaleDateString('en-IN', {
                      day: 'numeric',
                      month: 'short',
                    })
                  : '—'
              }`}
              right={<Badge label="Open" tone="success" />}
              onPress={() => router.push(`/ipos/${ipo.id}`)}
            />
          ))}
        </>
      )}

      {/* ---- by account --------------------------------------------------- */}
      {summary.byAccount.length > 0 && (
        <>
          <SectionHeader title="By account" />
          <Card variant="glass" padded={false}>
            {summary.byAccount.map((account, i) => (
              <View
                key={account.accountId}
                style={[
                  styles.accountRow,
                  i === summary.byAccount.length - 1 && styles.accountRowLast,
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.accountName}>{account.nickname}</Text>
                  <Text style={styles.accountHint}>
                    {account.applications} application(s)
                  </Text>
                </View>
                {/* Fixed width so the rupee figures line up down the column —
                    tabular-nums is iOS-only, so the container does the work. */}
                <Text
                  style={[
                    styles.accountPnl,
                    {
                      color:
                        account.pnl > 0
                          ? colors.success
                          : account.pnl < 0
                            ? colors.danger
                            : colors.textMuted,
                    },
                  ]}
                  numberOfLines={1}
                >
                  {formatInr(account.pnl)}
                </Text>
              </View>
            ))}
          </Card>
        </>
      )}

      {summary.totalApplications === 0 && (
        <EmptyState
          icon="empty"
          title="Nothing tracked yet"
          body="Add a demat account, then record your first IPO application to see your numbers here."
        />
      )}

      <Pressable style={styles.settingsRow} onPress={() => router.push('/settings')}>
        <Icon name="settings" size={18} color={colors.textMuted} />
        <Text style={styles.settingsText}>Settings</Text>
        <Icon name="chevron" size={18} color={colors.textFaint} />
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: {
    alignItems: 'center',
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xl,
    overflow: 'hidden',
  },
  halo: {
    position: 'absolute',
    top: -40,
    width: 320,
    height: 320,
    borderRadius: 160,
    opacity: 0.5,
  },
  heroLabel: { ...type.label, color: colors.textMuted, marginBottom: spacing.sm },
  heroValue: { ...type.hero, textAlign: 'center' },
  heroMeta: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  gaugeRow: { alignItems: 'flex-start', marginTop: spacing.sm },
  gaugeText: { ...type.bodyStrong, color: colors.text, fontSize: 15 },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  accountRowLast: { borderBottomWidth: 0 },
  accountName: { ...type.bodyStrong, color: colors.text },
  accountHint: { ...type.caption, color: colors.textFaint, marginTop: 2 },
  accountPnl: { ...type.bodyStrong, fontSize: 15, minWidth: 96, textAlign: 'right' },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.xl,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  settingsText: { ...type.body, color: colors.text, flex: 1 },
});
