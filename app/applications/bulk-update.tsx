/**
 * Update the outcome for every account that applied to one IPO in a single
 * action, instead of repeating app/applications/[id].tsx's form once per
 * pill. Shares allotted can genuinely differ per account (different lot
 * counts), so leaving it blank defaults each account to its own full
 * applied shares when marking Allotted — an explicit override still
 * applies the same number to every selected account.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  AllotmentCheckResults,
  Button,
  Card,
  ErrorText,
  Field,
  Heading,
  Loading,
  Screen,
} from '../../components/ui';
import { colors, radius, spacing, type } from '../../constants/theme';
import { listApplications, updateApplicationOutcome } from '../../lib/db/applications';
import type { ApplicationPnl, ApplicationStatus, IpoApplication } from '../../lib/types';

const OUTCOMES: { key: ApplicationStatus; label: string }[] = [
  { key: 'APPLIED', label: 'Still pending' },
  { key: 'ALLOTTED', label: 'Allotted' },
  { key: 'PARTIAL', label: 'Partial' },
  { key: 'NOT_ALLOTTED', label: 'Not allotted' },
  { key: 'REFUNDED', label: 'Refunded' },
  { key: 'WITHDRAWN', label: 'Withdrawn' },
];

/** Same validation rules as app/applications/[id].tsx's save mutation, evaluated per row. */
function computePatch(
  a: ApplicationPnl,
  status: ApplicationStatus,
  sharesOverride: string,
  sell: number | null,
): { status: ApplicationStatus; shares_allotted: number; sell_price: number | null; sold_at: string | null } {
  let shares: number;
  if (sharesOverride !== '') {
    shares = Number(sharesOverride);
  } else if (status === 'ALLOTTED') {
    shares = a.shares_applied;
  } else if (status === 'PARTIAL') {
    throw new Error('Enter shares allotted for a partial allotment.');
  } else {
    shares = 0;
  }

  if (Number.isNaN(shares) || shares < 0) throw new Error('Enter a valid number of shares.');
  if (shares > a.shares_applied) {
    throw new Error(`Applied for ${a.shares_applied} shares — allotment cannot exceed that.`);
  }
  if (status === 'ALLOTTED' && shares === 0) {
    throw new Error('Enter how many shares were allotted.');
  }

  return {
    status,
    shares_allotted: shares,
    sell_price: sell,
    sold_at: sell !== null ? new Date().toISOString() : null,
  };
}

export default function BulkUpdate() {
  const { ipoId } = useLocalSearchParams<{ ipoId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  const applications = useQuery({ queryKey: ['applications'], queryFn: listApplications });
  const mine = (applications.data ?? []).filter((a) => a.ipo_id === ipoId);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(mine.map((a) => a.id)));
  const [status, setStatus] = useState<ApplicationStatus | null>(null);
  const [sharesAllotted, setSharesAllotted] = useState('');
  const [sellPrice, setSellPrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<
    { id: string; result: PromiseSettledResult<IpoApplication> }[] | null
  >(null);

  function toggleId(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const update = useMutation({
    mutationFn: async () => {
      if (!status) throw new Error('Pick an outcome.');
      if (selectedIds.size === 0) throw new Error('Select at least one account.');

      const sell = sellPrice.trim() === '' ? null : Number(sellPrice);
      if (sell !== null && (Number.isNaN(sell) || sell <= 0)) {
        throw new Error('Enter a valid sale price.');
      }

      const ids = [...selectedIds];
      const settled = await Promise.allSettled(
        ids.map((id) =>
          (async () => {
            const a = mine.find((x) => x.id === id)!;
            const patch = computePatch(a, status, sharesAllotted, sell);
            return updateApplicationOutcome(id, patch);
          })(),
        ),
      );
      return ids.map((id, i) => ({ id, result: settled[i] }));
    },
    onSuccess: async (settled) => {
      const anySuccess = settled.some((r) => r.result.status === 'fulfilled');
      if (anySuccess) await queryClient.invalidateQueries({ queryKey: ['applications'] });
      setResults(settled);
      if (settled.every((r) => r.result.status === 'fulfilled')) router.back();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not update.'),
  });

  if (applications.isLoading) return <Loading />;
  if (mine.length === 0) {
    return (
      <Screen>
        <Text style={styles.label}>No applications found for this IPO.</Text>
      </Screen>
    );
  }

  const categories = new Set(mine.map((a) => a.category));

  return (
    <Screen>
      <Heading sub="Applies the same outcome to every account you leave selected below.">
        {mine[0].company_name}
      </Heading>

      <ErrorText>{error}</ErrorText>

      <Card>
        <Text style={styles.section}>Accounts ({selectedIds.size} of {mine.length})</Text>
        <View style={styles.chipRow}>
          {mine.map((a) => (
            <Pressable
              key={a.id}
              onPress={() => toggleId(a.id)}
              style={[styles.chip, selectedIds.has(a.id) && styles.chipOn]}
            >
              <Text style={[styles.chipText, selectedIds.has(a.id) && styles.chipTextOn]}>
                {a.account_nickname}
                {categories.size > 1 ? ` · ${a.category}` : ''}
              </Text>
            </Pressable>
          ))}
        </View>
      </Card>

      <Card>
        <Text style={styles.section}>Outcome</Text>
        <View style={styles.chipRow}>
          {OUTCOMES.map((o) => (
            <Pressable
              key={o.key}
              onPress={() => setStatus(o.key)}
              style={[styles.chip, o.key === status && styles.chipOn]}
            >
              <Text style={[styles.chipText, o.key === status && styles.chipTextOn]}>{o.label}</Text>
            </Pressable>
          ))}
        </View>

        {(status === 'ALLOTTED' || status === 'PARTIAL') && (
          <View style={{ marginTop: spacing.lg }}>
            <Field
              label="Shares allotted"
              value={sharesAllotted}
              onChangeText={setSharesAllotted}
              keyboardType="number-pad"
              placeholder={status === 'ALLOTTED' ? 'Leave blank for full allotment' : 'Required for partial'}
              hint={
                status === 'ALLOTTED'
                  ? "Leave blank to default each account to its own full applied shares."
                  : 'Partial has no default — enter the shares allotted for every selected account.'
              }
            />
          </View>
        )}

        <Field
          label="Sale price (optional)"
          value={sellPrice}
          onChangeText={setSellPrice}
          keyboardType="decimal-pad"
          hint="Applied to every selected account, once you have sold."
        />

        <Button
          title={`Update ${selectedIds.size} application${selectedIds.size === 1 ? '' : 's'}`}
          onPress={() => {
            setError(null);
            setResults(null);
            update.mutate();
          }}
          loading={update.isPending}
        />
      </Card>

      {results && (
        <AllotmentCheckResults
          results={results.map((r) => {
            const nickname = mine.find((a) => a.id === r.id)?.account_nickname ?? r.id;
            if (r.result.status === 'fulfilled') {
              return { id: r.id, label: nickname, message: 'Updated', tone: 'success' as const };
            }
            return {
              id: r.id,
              label: nickname,
              message: r.result.reason instanceof Error ? r.result.reason.message : 'Could not update.',
              tone: 'warning' as const,
            };
          })}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { ...type.heading, color: colors.text, marginBottom: spacing.md },
  label: { ...type.body, color: colors.textMuted, fontSize: 14 },
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
