/**
 * What the registrar said.
 *
 * Every "check allotment" in the app lands here. The check itself runs on this
 * screen rather than on the one you tapped from, which is what makes the result
 * somewhere you can go back to instead of an alert you dismiss: the outcome
 * lives in the query cache, and when nothing is pending any more the screen
 * shows the stored result rather than asking the registrar again.
 *
 * It is a `useQuery`, not a `useMutation`, for three reasons — it survives you
 * backing out mid-check, it caches so revisiting does not re-hit a registrar
 * (Bigshare's captcha path is rate-limited and paced behind a serial gate), and
 * `refetch()` is "Check again" for free.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  AllotmentCheckResults,
  Banner,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Icon,
  type IconName,
  Loading,
  Screen,
} from '../../components/ui';
import { colors, formatInr, radius, spacing, type } from '../../constants/theme';
import { checkAllotmentsForIpo } from '../../lib/db/allotment';
import { listApplications } from '../../lib/db/applications';
import { type CheckSummary, describeRow, formatDateTime, summariseCheck } from '../../lib/status';

/** [pale ring, solid glyph fill, text on the ring]. */
const HERO_TONE = {
  success: [colors.successSoft, colors.success, colors.successText],
  warning: [colors.warningSoft, colors.warning, colors.warningText],
  neutral: [colors.surfaceAlt, colors.textFaint, colors.textMuted],
} as const;

const HERO_ICON: Record<CheckSummary['tone'], IconName> = {
  success: 'check',
  warning: 'clock',
  neutral: 'info',
};

function headlineFor(s: CheckSummary): string {
  if (s.allottedAccounts > 0) {
    return s.totalAccounts === 1 ? 'Allotted' : `${s.allottedAccounts} of ${s.totalAccounts} allotted`;
  }
  return s.pending ? 'No result yet' : 'Not allotted';
}

function Hero({ summary }: { summary: CheckSummary }) {
  const [ring, fill, ink] = HERO_TONE[summary.tone];

  return (
    <Card style={styles.hero}>
      <View style={styles.markWrap}>
        <View style={[styles.ring, { backgroundColor: ring }]} pointerEvents="none" />
        <View style={[styles.mark, { backgroundColor: fill }]}>
          <Icon name={HERO_ICON[summary.tone]} size={24} color={colors.onAccent} />
        </View>
      </View>

      <Text style={[styles.headline, { color: ink }]}>{headlineFor(summary)}</Text>
      <Text style={styles.heroSub}>
        {summary.allottedAccounts > 0
          ? `${summary.sharesAllotted} shares · ${formatInr(summary.amountInvested)} invested`
          : `Across ${summary.totalAccounts} account${summary.totalAccounts === 1 ? '' : 's'}`}
      </Text>
    </Card>
  );
}

export default function AllotmentResult() {
  const { ipoId } = useLocalSearchParams<{ ipoId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  const applications = useQuery({ queryKey: ['applications'], queryFn: listApplications });
  const mine = (applications.data ?? []).filter((a) => a.ipo_id === ipoId);
  const eligible = mine.filter((a) => a.status === 'APPLIED');

  const check = useQuery({
    queryKey: ['allotment-check', ipoId],
    // Gated on the list having resolved, not just on `mine` being non-empty:
    // reading it mid-load would fire a check with no ids at all. bulk-update
    // has exactly that bug in its lazy `useState` initialiser.
    enabled: !applications.isLoading && eligible.length > 0,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
    // A registrar failure must not silently cost a second lookup.
    retry: false,
    queryFn: async () => {
      const first = mine[0];
      const outcome = await checkAllotmentsForIpo(
        ipoId!,
        eligible.map((a) => a.id),
        {
          kfintech_company_id: first.kfintech_company_id,
          bigshare_company_id: first.bigshare_company_id,
          mufg_company_id: first.mufg_company_id,
          registrar: first.registrar,
        },
      );
      // Inside queryFn on purpose: react-query v5 dropped useQuery's onSuccess,
      // and an effect would never fire if you backed out mid-check — which is
      // exactly when the refreshed rows matter most.
      await queryClient.invalidateQueries({ queryKey: ['applications'] });
      return outcome;
    },
  });

  if (applications.isLoading) return <Loading label="Loading applications…" />;

  if (mine.length === 0) {
    return (
      <Screen>
        <EmptyState
          icon="applications"
          title="Nothing to check"
          body="No applications are recorded against this IPO."
        />
      </Screen>
    );
  }

  const first = mine[0];
  const registrar = first.registrar ?? 'the registrar';
  const bulk = check.data;
  const live = bulk?.matched ? bulk.results : undefined;
  const summary = summariseCheck(mine, live);
  const lastChecked = mine
    .map((a) => a.allotment_checked_at)
    .filter((v): v is string => v !== null)
    .sort()
    .at(-1);

  return (
    <Screen>
      <View style={styles.head}>
        <Text style={styles.title}>{first.company_name}</Text>
        <Text style={styles.subtitle}>
          {first.registrar ?? 'Registrar not known'}
          {lastChecked ? ` · Checked ${formatDateTime(lastChecked)}` : ''}
        </Text>
      </View>

      <ErrorText>{check.error instanceof Error ? check.error.message : null}</ErrorText>

      {check.isFetching ? (
        <Card>
          <Loading label={`Checking with ${registrar}…`} />
        </Card>
      ) : (
        <>
          {bulk && !bulk.matched ? (
            <Banner tone="warning" title="No result yet">
              {bulk.message}
            </Banner>
          ) : (
            <Hero summary={summary} />
          )}

          <Card>
            <Text style={styles.section}>By account</Text>
            <AllotmentCheckResults
              results={mine.map((row) => describeRow(row, live?.find((l) => l.id === row.id)))}
            />
          </Card>

          {eligible.length > 0 && (
            <Button
              title="Check again"
              variant="secondary"
              onPress={() => check.refetch()}
              loading={check.isFetching}
            />
          )}

          <Button
            title="Record outcome manually"
            variant="ghost"
            onPress={() =>
              router.push(
                mine.length > 1
                  ? `/applications/bulk-update?ipoId=${ipoId}`
                  : `/applications/${first.id}`,
              )
            }
          />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { marginBottom: spacing.lg },
  title: { ...type.title, color: colors.text },
  subtitle: { ...type.body, color: colors.textMuted, marginTop: 2 },
  section: { ...type.heading, color: colors.text, marginBottom: spacing.md },
  hero: { alignItems: 'center', paddingVertical: spacing.xl },
  markWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  ring: { position: 'absolute', width: 92, height: 92, borderRadius: 46 },
  mark: {
    width: 56,
    height: 56,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The one big line on this screen — see the note beside `type.hero`.
  headline: { ...type.hero, textAlign: 'center' },
  heroSub: { ...type.body, color: colors.textMuted, marginTop: spacing.sm, textAlign: 'center' },
});
