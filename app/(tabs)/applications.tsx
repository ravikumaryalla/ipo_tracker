import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import {
  AppHeader,
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  HeaderAction,
  Icon,
  Loading,
  Screen,
  Segmented,
} from '../../components/ui';
import { colors, formatInr, motion, radius, spacing, type } from '../../constants/theme';
import { listApplications } from '../../lib/db/applications';
import {
  formatDateTime,
  STATUS_ACCENT,
  STATUS_LABEL,
  STATUS_TONE,
  summariseCheck,
} from '../../lib/status';
import type { ApplicationPnl, ApplicationStatus } from '../../lib/types';

type Filter = 'all' | 'live' | 'allotted' | 'closed';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'live', label: 'Live' },
  { key: 'allotted', label: 'Allotted' },
  { key: 'closed', label: 'Closed' },
];

function matches(status: ApplicationStatus, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'live') return status === 'APPLIED';
  if (filter === 'allotted') return status === 'ALLOTTED' || status === 'PARTIAL';
  return status === 'NOT_ALLOTTED' || status === 'WITHDRAWN' || status === 'REFUNDED';
}

/** The status every row in the group shares, or null when they differ. */
function uniformStatus(group: ApplicationPnl[]): ApplicationStatus | null {
  const first = group[0].status;
  return group.every((r) => r.status === first) ? first : null;
}

export default function ApplicationsTab() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('all');
  const applications = useQuery({ queryKey: ['applications'], queryFn: listApplications });

  const rows = applications.data ?? [];

  const groups = useMemo(() => {
    const byIpo = new Map<string, ApplicationPnl[]>();
    for (const r of rows) byIpo.set(r.ipo_id, [...(byIpo.get(r.ipo_id) ?? []), r]);
    return [...byIpo.values()];
  }, [rows]);

  const counts = useMemo(
    () =>
      FILTERS.reduce<Record<Filter, number>>(
        (acc, f) => {
          acc[f.key] = groups.filter((g) => g.some((r) => matches(r.status, f.key))).length;
          return acc;
        },
        { all: 0, live: 0, allotted: 0, closed: 0 },
      ),
    [groups],
  );

  const visible = useMemo(
    () => groups.filter((g) => g.some((r) => matches(r.status, filter))),
    [groups, filter],
  );

  // Hoisted so the loading state keeps the header — see the same note on Home.
  const header = (
    <AppHeader
      title="Allotment Status"
      right={
        <HeaderAction
          icon="add"
          label="Record an application"
          color={colors.accent}
          onPress={() => router.push('/applications/new')}
        />
      }
    />
  );

  if (applications.isLoading) {
    return (
      <Screen inset header={header}>
        <Loading label="Loading applications…" />
      </Screen>
    );
  }

  return (
    <Screen inset header={header}>
      <ErrorText>
        {applications.error instanceof Error ? applications.error.message : null}
      </ErrorText>

      {rows.length > 0 && (
        <Segmented
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((f) => ({ ...f, count: counts[f.key] }))}
        />
      )}

      {rows.length === 0 ? (
        <>
          <EmptyState
            icon="applications"
            title="No applications yet"
            body="Once you apply to an IPO, record it here to track allotment and listing gains."
          />
          {/* The header's + carries this action once the list has content; on
              an empty screen there is nothing to infer it from. */}
          <Button
            title="Record an application"
            icon="add"
            onPress={() => router.push('/applications/new')}
          />
        </>
      ) : visible.length === 0 ? (
        <EmptyState
          icon="applications"
          title={`Nothing ${filter}`}
          body="Try a different filter to see your other applications."
        />
      ) : (
        visible.map((group, i) => {
          const first = group[0];
          const status = uniformStatus(group);
          const categories = new Set(group.map((r) => r.category));
          const blocked = group
            .filter((r) => r.status === 'APPLIED')
            .reduce((s, r) => s + Number(r.amount_blocked), 0);
          const pnl = group
            .filter((r) => r.shares_allotted > 0)
            .reduce((s, r) => s + Number(r.realised_pnl) + Number(r.unrealised_pnl), 0);
          const hasAllotted = group.some((r) => r.shares_allotted > 0);
          const eligible = group.filter((r) => r.status === 'APPLIED');
          const summary = summariseCheck(group);
          const lastChecked = group
            .map((r) => r.allotment_checked_at)
            .filter((v): v is string => v !== null)
            .sort()
            .at(-1);

          return (
            <Animated.View
              key={first.ipo_id}
              entering={FadeInDown.delay(i * motion.stagger).duration(motion.base)}
            >
              <Card variant="glass" style={styles.card}>
                <View
                  style={[
                    styles.rail,
                    { backgroundColor: status ? STATUS_ACCENT[status] : colors.borderStrong },
                  ]}
                />

                <View style={styles.header}>
                  <Avatar name={first.company_name} size={38} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.company} numberOfLines={1}>
                      {first.company_name}
                    </Text>
                    <Text style={styles.sub} numberOfLines={1}>
                      {summary.allottedAccounts > 0
                        ? `${summary.allottedAccounts} of ${summary.totalAccounts} allotted · ${summary.sharesAllotted} shares`
                        : summary.pending
                          ? `${group.length} account${group.length === 1 ? '' : 's'} applied`
                          : // Nothing allotted and nothing pending: say which
                            // settled state it is, since withdrawn and refunded
                            // are not "not allotted".
                            status
                            ? STATUS_LABEL[status]
                            : `${group.length} accounts`}
                    </Text>
                  </View>
                  {status ? (
                    <Badge label={status.replace('_', ' ')} tone={STATUS_TONE[status]} />
                  ) : (
                    <Badge label={`${group.length} accounts`} tone="muted" />
                  )}
                </View>

                <View style={styles.pillRow}>
                  {group.map((r) => (
                    <Pressable
                      key={r.id}
                      onPress={() => router.push(`/applications/${r.id}`)}
                      style={styles.pill}
                    >
                      <View style={[styles.pillDot, { backgroundColor: STATUS_ACCENT[r.status] }]} />
                      <Text style={styles.pillText} numberOfLines={1}>
                        {r.account_nickname}
                        {categories.size > 1 ? ` · ${r.category}` : ''}
                        {r.shares_allotted > 0 ? ` · ${r.shares_allotted} shares` : ''}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {(blocked > 0 || hasAllotted) && (
                  <View style={styles.footer}>
                    {blocked > 0 && (
                      <View style={styles.metaRow}>
                        <Icon name="wallet" size={13} color={colors.textFaint} />
                        <Text style={styles.meta}>{formatInr(blocked)} blocked</Text>
                      </View>
                    )}
                    {hasAllotted && (
                      <Text
                        style={[
                          styles.pnl,
                          {
                            color:
                              pnl > 0 ? colors.success : pnl < 0 ? colors.danger : colors.textMuted,
                          },
                        ]}
                      >
                        {pnl >= 0 ? '+' : ''}
                        {formatInr(pnl)}
                      </Text>
                    )}
                  </View>
                )}

                <View style={styles.actions}>
                  {eligible.length > 0 && (
                    <View style={{ flex: 1 }}>
                      <Button
                        title="Check"
                        variant="secondary"
                        size="sm"
                        onPress={() => router.push(`/allotment/${first.ipo_id}`)}
                      />
                    </View>
                  )}
                  <View style={{ flex: 1 }}>
                    <Button
                      title="Add"
                      variant="ghost"
                      size="sm"
                      icon="add"
                      onPress={() => router.push(`/applications/new?ipoId=${first.ipo_id}`)}
                    />
                  </View>
                  {group.length > 1 && (
                    <View style={{ flex: 1 }}>
                      <Button
                        title="Update"
                        variant="ghost"
                        size="sm"
                        onPress={() =>
                          router.push(`/applications/bulk-update?ipoId=${first.ipo_id}`)
                        }
                      />
                    </View>
                  )}
                </View>

                {eligible.length > 0 && lastChecked && (
                  <View style={{ marginTop: spacing.md }}>
                    <Text style={styles.meta}>Last checked {formatDateTime(lastChecked)}</Text>
                  </View>
                )}
              </Card>
            </Animated.View>
          );
        })
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { paddingLeft: spacing.lg + 4 },
  rail: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    // Card stopped clipping its children — that would cut off the shadow that
    // now defines its edge — so the rail rounds its own outer corners.
    borderTopLeftRadius: radius.md,
    borderBottomLeftRadius: radius.md,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  company: { ...type.bodyStrong, color: colors.text, fontSize: 16 },
  sub: { ...type.caption, color: colors.textMuted, marginTop: 2 },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm - 2,
  },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  pillText: { ...type.label, color: colors.textMuted, fontSize: 12, letterSpacing: 0.2 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.lg,
    gap: spacing.md,
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 1, flex: 1 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  meta: { ...type.caption, color: colors.textMuted },
  pnl: { ...type.bodyStrong, fontSize: 15 },
});
