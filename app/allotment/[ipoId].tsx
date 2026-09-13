/**
 * What the registrar said.
 *
 * Every "check allotment" in the app lands here. The check itself runs on this
 * screen rather than on the one you tapped from, which is what makes the result
 * somewhere you can go back to instead of an alert you dismiss: the outcome
 * lives in the query cache, and when nothing is pending any more the screen
 * shows the stored result rather than asking the registrar again.
 *
 * Accounts are checked one at a time and each result is rendered the moment it
 * lands — see lib/useAllotmentCheck.ts, which owns the run. So the "By account"
 * list is on screen for the whole check, filling in row by row, instead of
 * being hidden behind a single spinner until the slowest account finishes. An
 * account that fails gets a Retry on its own row, because re-checking the whole
 * IPO to fix one unread captcha costs a fresh lookup on every account that
 * already answered.
 */
import { useQuery } from '@tanstack/react-query';
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
import { listApplications } from '../../lib/db/applications';
import { type CheckSummary, describeRow, formatDateTime, summariseCheck } from '../../lib/status';
import { useAllotmentCheck } from '../../lib/useAllotmentCheck';

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

  const applications = useQuery({ queryKey: ['applications'], queryFn: listApplications });
  const mine = (applications.data ?? []).filter((a) => a.ipo_id === ipoId);
  const eligible = mine.filter((a) => a.status === 'APPLIED');
  const first = mine[0];

  const check = useAllotmentCheck({
    ipoId: ipoId!,
    applicationIds: eligible.map((a) => a.id),
    ipo: {
      kfintech_company_id: first?.kfintech_company_id ?? null,
      bigshare_company_id: first?.bigshare_company_id ?? null,
      mufg_company_id: first?.mufg_company_id ?? null,
      registrar: first?.registrar ?? null,
    },
    // Gated on the list having resolved, not just on `mine` being non-empty:
    // reading it mid-load would fire a check with no ids at all. bulk-update
    // has exactly that bug in its lazy `useState` initialiser.
    enabled: !applications.isLoading && eligible.length > 0,
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

  const registrar = first.registrar ?? 'the registrar';
  const progress = check.progress;
  const unmatched = progress && !progress.matched;
  const summary = summariseCheck(mine, progress?.accounts);
  const lastChecked = mine
    .map((a) => a.allotment_checked_at)
    .filter((v): v is string => v !== null)
    .sort()
    .at(-1);

  const rows = mine.map((row) => {
    const outcome = describeRow(
      row,
      progress?.accounts.find((a) => a.id === row.id),
    );
    return {
      ...outcome,
      // Never while something is already in flight: the registrar is asked one
      // account at a time on purpose, and a second run racing the first is the
      // thing the pacing exists to prevent.
      onRetry:
        outcome.retryable && !check.isRunning ? () => check.retry([row.id]) : undefined,
    };
  });

  return (
    <Screen>
      <View style={styles.head}>
        <Text style={styles.title}>{first.company_name}</Text>
        <Text style={styles.subtitle}>
          {first.registrar ?? 'Registrar not known'}
          {lastChecked ? ` · Checked ${formatDateTime(lastChecked)}` : ''}
        </Text>
      </View>

      <ErrorText>{check.error?.message ?? null}</ErrorText>

      {check.isRunning ? (
        <Card>
          <Loading
            label={
              check.total > 0
                ? `Checking with ${registrar}… (${check.done} of ${check.total})`
                : `Checking with ${registrar}…`
            }
          />
        </Card>
      ) : unmatched ? (
        <Banner tone="warning" title="No result yet">
          {progress.message}
        </Banner>
      ) : (
        <Hero summary={summary} />
      )}

      <Card>
        <Text style={styles.section}>By account</Text>
        <AllotmentCheckResults results={rows} />
      </Card>

      {check.failedIds.length > 0 && !check.isRunning && (
        <Button
          title={`Retry all failed (${check.failedIds.length})`}
          variant="secondary"
          onPress={() => check.retry(check.failedIds)}
        />
      )}

      {eligible.length > 0 && (
        <Button
          title="Check again"
          variant="secondary"
          onPress={check.checkAgain}
          loading={check.isRunning}
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
