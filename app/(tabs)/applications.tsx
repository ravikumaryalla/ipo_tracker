import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import {
  AllotmentCheckResults,
  type AllotmentCheckResultTone,
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
import { colors, formatInr, motion, radius, spacing, type } from '../../constants/theme';
import {
  checkAllotmentsForIpo,
  type BulkAllotmentCheck,
  type OnDemandCheckResult,
} from '../../lib/db/allotment';
import { listApplications } from '../../lib/db/applications';
import type { ApplicationPnl, ApplicationStatus } from '../../lib/types';

const STATUS_TONE: Record<ApplicationStatus, 'muted' | 'success' | 'warning' | 'danger' | 'accent'> =
  {
    APPLIED: 'accent',
    ALLOTTED: 'success',
    PARTIAL: 'success',
    NOT_ALLOTTED: 'muted',
    WITHDRAWN: 'muted',
    REFUNDED: 'warning',
  };

const STATUS_ACCENT: Record<ApplicationStatus, string> = {
  APPLIED: colors.accent,
  ALLOTTED: colors.success,
  PARTIAL: colors.success,
  NOT_ALLOTTED: colors.textFaint,
  WITHDRAWN: colors.textFaint,
  REFUNDED: colors.warning,
};

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

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function ApplicationsTab() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('all');
  const [checkResults, setCheckResults] = useState<Record<string, BulkAllotmentCheck>>({});
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

  const check = useMutation({
    mutationFn: async ({
      ipoId,
      ids,
      kfintechCompanyId,
    }: {
      ipoId: string;
      ids: string[];
      kfintechCompanyId: string | null;
    }) => {
      const outcome = await checkAllotmentsForIpo(ipoId, ids, kfintechCompanyId);
      return { ipoId, outcome };
    },
    onSuccess: async ({ ipoId, outcome }) => {
      // Unconditional: the unmatched path stamps allotment_checked_at too (see
      // checkAllotmentsForIpo), so gating this on `matched` left "Last checked"
      // showing the *previous* tap's time for as long as the IPO stayed
      // unmatched — exactly the case the stamp was added for.
      await queryClient.invalidateQueries({ queryKey: ['applications'] });
      setCheckResults((prev) => ({ ...prev, [ipoId]: outcome }));
    },
    onError: (e, { ipoId }) => {
      // Only reached on a genuine failure to even reach the check service
      // (loadCheckRow errors, or resolveKfintechMatch's invoke failing) — a
      // real "not matched" result is returned via onSuccess, not thrown, so
      // nothing was persisted here and there's nothing to refetch.
      const message = e instanceof Error ? e.message : 'Could not check status.';
      setCheckResults((prev) => ({ ...prev, [ipoId]: { matched: false, message } }));
    },
  });

  if (applications.isLoading) return <Loading label="Loading applications…" />;

  return (
    <Screen inset>
      <Heading sub="Every bid you have placed, and what came of it.">Applications</Heading>

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

      <Button
        title="Record an application"
        icon="add"
        onPress={() => router.push('/applications/new')}
      />

      {rows.length === 0 ? (
        <EmptyState
          icon="applications"
          title="No applications yet"
          body="Once you apply to an IPO, record it here to track allotment and listing gains."
        />
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
          const checking = check.isPending && check.variables?.ipoId === first.ipo_id;
          const result = checkResults[first.ipo_id];
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
                  <View style={{ flex: 1 }}>
                    <Text style={styles.company} numberOfLines={1}>
                      {first.company_name}
                    </Text>
                    <Text style={styles.sub} numberOfLines={1}>
                      {group.length} account{group.length === 1 ? '' : 's'} applied
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

                {eligible.length > 0 && (
                  <View style={{ marginTop: spacing.lg }}>
                    <Button
                      title="Check status"
                      variant="secondary"
                      onPress={() => {
                        setCheckResults((prev) => {
                          const next = { ...prev };
                          delete next[first.ipo_id];
                          return next;
                        });
                        check.mutate({
                          ipoId: first.ipo_id,
                          ids: eligible.map((r) => r.id),
                          kfintechCompanyId: first.kfintech_company_id,
                        });
                      }}
                      loading={checking}
                    />
                    {lastChecked && (
                      <Text style={[styles.meta, { marginTop: spacing.sm }]}>
                        Last checked {formatDateTime(lastChecked)}
                      </Text>
                    )}
                    {result && !result.matched && (
                      <Banner tone="warning">{result.message}</Banner>
                    )}
                    {result && result.matched && (
                      <View style={{ marginTop: spacing.md }}>
                        <AllotmentCheckResults
                          results={result.results.map((r) => {
                            const nickname =
                              group.find((row) => row.id === r.id)?.account_nickname ?? r.id;
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

                <View style={{ marginTop: spacing.md }}>
                  <Button
                    title="Add accounts"
                    variant="ghost"
                    icon="add"
                    onPress={() => router.push(`/applications/new?ipoId=${first.ipo_id}`)}
                  />
                </View>

                {group.length > 1 && (
                  <View style={{ marginTop: spacing.md }}>
                    <Button
                      title="Update all"
                      variant="ghost"
                      onPress={() => router.push(`/applications/bulk-update?ipoId=${first.ipo_id}`)}
                    />
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
  rail: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
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
  meta: { ...type.caption, color: colors.textFaint },
  pnl: { ...type.bodyStrong, fontSize: 15 },
});
