import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import {
  Badge,
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
import { listApplications } from '../../lib/db/applications';
import type { ApplicationStatus } from '../../lib/types';

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

export default function ApplicationsTab() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('all');
  const applications = useQuery({ queryKey: ['applications'], queryFn: listApplications });

  const rows = applications.data ?? [];

  const counts = useMemo(
    () =>
      FILTERS.reduce<Record<Filter, number>>(
        (acc, f) => {
          acc[f.key] = rows.filter((r) => matches(r.status, f.key)).length;
          return acc;
        },
        { all: 0, live: 0, allotted: 0, closed: 0 },
      ),
    [rows],
  );

  const visible = useMemo(() => rows.filter((r) => matches(r.status, filter)), [rows, filter]);

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
        visible.map((a, i) => {
          const pnl = Number(a.realised_pnl) + Number(a.unrealised_pnl);
          return (
            <Animated.View
              key={a.id}
              entering={FadeInDown.delay(i * motion.stagger).duration(motion.base)}
            >
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push(`/applications/${a.id}`)}
              >
                <Card variant="glass" style={styles.card}>
                  <View style={[styles.rail, { backgroundColor: STATUS_ACCENT[a.status] }]} />

                  <View style={styles.header}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.company} numberOfLines={1}>
                        {a.company_name}
                      </Text>
                      <Text style={styles.sub} numberOfLines={1}>
                        {a.account_nickname} · {a.category} · {a.lots} lot(s)
                      </Text>
                    </View>
                    <Badge label={a.status.replace('_', ' ')} tone={STATUS_TONE[a.status]} />
                  </View>

                  <View style={styles.footer}>
                    <View style={styles.metaRow}>
                      <Icon
                        name={a.status === 'APPLIED' ? 'wallet' : 'check'}
                        size={13}
                        color={colors.textFaint}
                      />
                      <Text style={styles.meta}>
                        {a.status === 'APPLIED'
                          ? `${formatInr(Number(a.amount_blocked))} blocked`
                          : `${a.shares_allotted} share(s) allotted`}
                      </Text>
                    </View>
                    {a.shares_allotted > 0 && (
                      <Text
                        style={[
                          styles.pnl,
                          {
                            color:
                              pnl > 0
                                ? colors.success
                                : pnl < 0
                                  ? colors.danger
                                  : colors.textMuted,
                          },
                        ]}
                      >
                        {pnl >= 0 ? '+' : ''}
                        {formatInr(pnl)}
                      </Text>
                    )}
                  </View>
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
  card: { paddingLeft: spacing.lg + 4 },
  rail: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  company: { ...type.bodyStrong, color: colors.text, fontSize: 16 },
  sub: { ...type.caption, color: colors.textMuted, marginTop: 2 },
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
