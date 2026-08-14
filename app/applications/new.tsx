/**
 * Record an IPO application.
 *
 * Reachable three ways: from the tab (pick both), from an IPO ("apply from an
 * account"), and from an account ("new application"). The pre-selection comes
 * in as a search param so all three land on the same screen.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Banner, Button, Card, ErrorText, Field, Loading, Screen } from '../../components/ui';
import { colors, formatInr, radius, spacing, type } from '../../constants/theme';
import { useAuth } from '../../lib/auth';
import { listAccountSummaries } from '../../lib/db/accounts';
import {
  appliedAccountIds,
  bidDefaultsFor,
  computeAmounts,
  createApplication,
  listApplications,
} from '../../lib/db/applications';
import { bucketOf, listIpos } from '../../lib/db/ipos';
import type { ApplicationCategory } from '../../lib/types';

const CATEGORIES: ApplicationCategory[] = [
  'RETAIL',
  'SHNI',
  'BHNI',
  'SHAREHOLDER',
  'EMPLOYEE',
  'POLICYHOLDER',
];

export default function NewApplication() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { userId } = useAuth();
  const params = useLocalSearchParams<{ ipoId?: string; accountId?: string }>();

  const ipos = useQuery({ queryKey: ['ipos'], queryFn: listIpos });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: listAccountSummaries });
  // Same key the Applications tab uses, so arriving from an IPO card this is
  // already in cache — it tells us what has been applied for this IPO already.
  const applications = useQuery({ queryKey: ['applications'], queryFn: listApplications });

  const [ipoId, setIpoId] = useState<string | null>(params.ipoId ?? null);
  const [accountIds, setAccountIds] = useState<string[]>(
    params.accountId ? [params.accountId] : [],
  );
  const [category, setCategory] = useState<ApplicationCategory>('RETAIL');
  const [lots, setLots] = useState('1');
  const [bidPrice, setBidPrice] = useState('');
  const [applicationNo, setApplicationNo] = useState('');
  const [upiRef, setUpiRef] = useState('');
  const [error, setError] = useState<string | null>(null);

  const selectedIpo = useMemo(
    () => ipos.data?.find((i) => i.id === ipoId) ?? null,
    [ipos.data, ipoId],
  );

  const existing = useMemo(() => applications.data ?? [], [applications.data]);

  // Adding accounts to an IPO you have already applied to: start from the bid
  // the earlier applications used rather than making you retype it. Only fires
  // when the chosen IPO changes, so it never clobbers an edit made afterwards.
  const defaults = useMemo(() => bidDefaultsFor(existing, ipoId), [existing, ipoId]);
  const prefilledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!ipoId || !defaults || prefilledFor.current === ipoId) return;
    prefilledFor.current = ipoId;
    setCategory(defaults.category);
    setLots(String(defaults.lots));
    setBidPrice(String(defaults.bid_price));
  }, [ipoId, defaults]);

  // One application per account per category per IPO — those accounts aren't
  // pickable, and anything already picked stops being valid when the category
  // or IPO changes under it.
  const applied = useMemo(
    () => appliedAccountIds(existing, ipoId, category),
    [existing, ipoId, category],
  );
  useEffect(() => {
    setAccountIds((prev) =>
      prev.some((id) => applied.has(id)) ? prev.filter((id) => !applied.has(id)) : prev,
    );
  }, [applied]);

  const selectable = useMemo(
    () => (accounts.data ?? []).filter((a) => !applied.has(a.id)),
    [accounts.data, applied],
  );

  function toggleAccount(id: string) {
    if (applied.has(id)) return;
    setAccountIds((prev) => (prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]));
  }

  // Applying at the cut-off price is the norm, so default to the upper band.
  const effectiveBid = Number(bidPrice) || selectedIpo?.price_band_max || 0;
  const lotSize = selectedIpo?.lot_size ?? 0;
  const amounts =
    lotSize > 0 && effectiveBid > 0
      ? computeAmounts({ lots: Number(lots) || 0, lot_size: lotSize, bid_price: effectiveBid })
      : null;

  const create = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error('Not signed in.');
      if (!ipoId) throw new Error('Pick an IPO.');
      if (accountIds.length === 0) throw new Error('Pick at least one demat account.');
      if (!lotSize) throw new Error('This IPO has no lot size recorded — add it on the IPO first.');
      if (!effectiveBid) throw new Error('Enter the price you bid at.');
      if (!Number(lots)) throw new Error('Enter how many lots you applied for.');

      const shared = {
        ipo_id: ipoId,
        category,
        lots: Number(lots),
        bid_price: effectiveBid,
        lot_size: lotSize,
        application_no: applicationNo.trim() || null,
        upi_ref: upiRef.trim() || null,
      };

      const results = await Promise.allSettled(
        accountIds.map((id) => createApplication(userId, { ...shared, demat_account_id: id })),
      );

      const failed = results
        .map((r, i) => ({ r, id: accountIds[i] }))
        .filter((x): x is { r: PromiseRejectedResult; id: string } => x.r.status === 'rejected');

      return { succeededIds: accountIds.filter((id) => !failed.some((f) => f.id === id)), failed };
    },
    onSuccess: async ({ succeededIds, failed }) => {
      if (succeededIds.length > 0) {
        await queryClient.invalidateQueries({ queryKey: ['applications'] });
      }
      if (failed.length === 0) {
        router.back();
        return;
      }
      setAccountIds(failed.map((f) => f.id));
      setError(
        failed
          .map((f) => {
            const nickname = accounts.data?.find((a) => a.id === f.id)?.nickname ?? f.id;
            const reason = f.r.reason instanceof Error ? f.r.reason.message : 'Could not save.';
            return `${nickname}: ${reason}`;
          })
          .join('\n'),
      );
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save.'),
  });

  if (ipos.isLoading || accounts.isLoading || applications.isLoading) return <Loading />;

  // Applying only makes sense for IPOs that are open or about to be; keep older
  // ones reachable though, since you may be back-filling history.
  const sortedIpos = [...(ipos.data ?? [])].sort((a, b) => {
    const rank = (x: typeof a) => (bucketOf(x) === 'open' ? 0 : bucketOf(x) === 'upcoming' ? 1 : 2);
    return rank(a) - rank(b);
  });

  return (
    <Screen>
      <ErrorText>{error}</ErrorText>

      {accounts.data?.length === 0 && (
        <Banner tone="warning">
          Add a demat account first — an application has to belong to one.
        </Banner>
      )}

      {(accounts.data?.length ?? 0) > 0 && ipoId !== null && selectable.length === 0 && (
        <Banner tone="info">
          Every account has already applied to this IPO in the {category} category. Pick another
          category to add more.
        </Banner>
      )}

      <Card>
        <Text style={styles.section}>IPO</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.chipRow}>
            {sortedIpos.map((ipo) => (
              <Pressable
                key={ipo.id}
                onPress={() => setIpoId(ipo.id)}
                style={[styles.chip, ipo.id === ipoId && styles.chipOn]}
              >
                <Text style={[styles.chipText, ipo.id === ipoId && styles.chipTextOn]}>
                  {ipo.symbol}
                </Text>
                <Text style={styles.chipSub}>{bucketOf(ipo)}</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        {selectedIpo && (
          <Text style={styles.detail}>
            {selectedIpo.company_name} · {selectedIpo.lot_size ?? '?'} shares/lot ·{' '}
            {formatInr(selectedIpo.price_band_min)}–{formatInr(selectedIpo.price_band_max)}
          </Text>
        )}
      </Card>

      <Card>
        <View style={styles.sectionRow}>
          <Text style={styles.section}>
            Applied from{accountIds.length > 0 ? ` (${accountIds.length})` : ''}
          </Text>
          {selectable.length > 0 && (
            <Pressable
              onPress={() =>
                setAccountIds(
                  accountIds.length === selectable.length ? [] : selectable.map((a) => a.id),
                )
              }
            >
              <Text style={styles.sectionAction}>
                {accountIds.length === selectable.length ? 'Clear' : 'Select all'}
              </Text>
            </Pressable>
          )}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.chipRow}>
            {accounts.data?.map((account) => {
              const isApplied = applied.has(account.id);
              const on = accountIds.includes(account.id);
              return (
                <Pressable
                  key={account.id}
                  onPress={() => toggleAccount(account.id)}
                  disabled={isApplied}
                  style={[styles.chip, on && styles.chipOn, isApplied && styles.chipOff]}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{account.nickname}</Text>
                  {isApplied && <Text style={styles.chipSub}>applied</Text>}
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </Card>

      <Card>
        <Text style={styles.section}>Bid</Text>

        <Text style={styles.label}>Category</Text>
        <View style={[styles.chipRow, { flexWrap: 'wrap', marginBottom: spacing.lg }]}>
          {CATEGORIES.map((c) => (
            <Pressable
              key={c}
              onPress={() => setCategory(c)}
              style={[styles.chip, c === category && styles.chipOn]}
            >
              <Text style={[styles.chipText, c === category && styles.chipTextOn]}>{c}</Text>
            </Pressable>
          ))}
        </View>

        <Field label="Lots" value={lots} onChangeText={setLots} keyboardType="number-pad" />
        <Field
          label="Bid price"
          value={bidPrice}
          onChangeText={setBidPrice}
          keyboardType="decimal-pad"
          placeholder={selectedIpo?.price_band_max ? String(selectedIpo.price_band_max) : '—'}
          hint="Leave blank to apply at the cut-off price (upper band)."
        />

        {amounts && (
          <View style={styles.total}>
            <Text style={styles.totalLabel}>
              {amounts.shares_applied} shares · blocked
            </Text>
            <Text style={styles.totalValue}>{formatInr(amounts.amount_blocked)}</Text>
          </View>
        )}
      </Card>

      <Card>
        <Text style={styles.section}>Reference (optional)</Text>
        <Field label="Application number" value={applicationNo} onChangeText={setApplicationNo} />
        <Field label="UPI reference" value={upiRef} onChangeText={setUpiRef} autoCapitalize="none" />
      </Card>

      <Button
        title={accountIds.length > 1 ? `Save ${accountIds.length} applications` : 'Save application'}
        onPress={() => {
          setError(null);
          create.mutate();
        }}
        loading={create.isPending}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { ...type.heading, color: colors.text, marginBottom: spacing.md },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionAction: { ...type.label, color: colors.accent, fontSize: 13, marginBottom: spacing.md },
  label: { ...type.label, color: colors.textMuted, marginBottom: spacing.sm },
  chipRow: { flexDirection: 'row', gap: spacing.sm },
  chip: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  chipOn: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  chipOff: { opacity: 0.45 },
  chipText: { ...type.label, color: colors.textMuted, fontSize: 13, letterSpacing: 0.2 },
  chipTextOn: { color: colors.accent },
  chipSub: { ...type.caption, color: colors.textFaint, fontSize: 10, marginTop: 2 },
  detail: { ...type.caption, color: colors.textFaint, marginTop: spacing.md },
  total: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: spacing.lg,
  },
  totalLabel: { ...type.body, color: colors.textMuted, fontSize: 14 },
  totalValue: { ...type.stat, color: colors.text, fontSize: 20 },
});
