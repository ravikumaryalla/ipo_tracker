/**
 * Drives the one-account-at-a-time allotment check behind the result screen.
 *
 * Still a `useQuery` rather than a `useMutation`, for the three reasons the
 * screen has always relied on: the run survives you backing out mid-check, the
 * result caches so revisiting does not re-hit a registrar (Bigshare's captcha
 * path is rate-limited and paced), and `refetch()` is "Check again" for free.
 *
 * What is new is that the run publishes as it goes. `runIpoAllotmentCheck`
 * calls back after every transition, and each callback does a `setQueryData`
 * on this query's own key — which react-query treats as a normal data update
 * even while the fetch that produced it is still in flight. So the screen fills
 * in account by account instead of waiting for the slowest one, without any
 * component state that a mid-check navigation would throw away.
 *
 * Retries reuse the same publishing path, so a single failed account re-checks
 * and animates exactly like a full run — just with one id instead of all of
 * them.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

import {
  type IpoCheckProgress,
  type RegistrarLookup,
  retryAllotmentChecks,
  retryableIds,
  runIpoAllotmentCheck,
} from './db/allotment';

export type AllotmentCheck = {
  progress: IpoCheckProgress | undefined;
  /** A run — first pass or retry — is in flight. */
  isRunning: boolean;
  /** Only ever the IPO-level failure; per-account failures live in `progress`. */
  error: Error | null;
  /** Accounts that have reached a verdict, and how many there are in total. */
  done: number;
  total: number;
  /** Accounts worth asking about again, in display order. */
  failedIds: string[];
  checkAgain: () => void;
  retry: (ids: string[]) => void;
};

export function useAllotmentCheck({
  ipoId,
  applicationIds,
  ipo,
  enabled,
}: {
  ipoId: string;
  applicationIds: string[];
  ipo: RegistrarLookup;
  enabled: boolean;
}): AllotmentCheck {
  const queryClient = useQueryClient();
  const [retrying, setRetrying] = useState(false);

  // Which accounts have already had their row refreshed. The registrar result
  // is written server-side by check-allotments, so ['applications'] has to be
  // re-read for the stored columns to catch up — once per account that
  // actually resolved, rather than once at the end, so the list behind the
  // check is right the moment each row settles.
  const refreshed = useRef(new Set<string>());

  const publish = useCallback(
    (progress: IpoCheckProgress) => {
      queryClient.setQueryData(['allotment-check', ipoId], progress);
      for (const account of progress.accounts) {
        if (
          account.phase === 'done' &&
          account.result?.outcome === 'resolved' &&
          !refreshed.current.has(account.id)
        ) {
          refreshed.current.add(account.id);
          void queryClient.invalidateQueries({ queryKey: ['applications'] });
        }
      }
    },
    [queryClient, ipoId],
  );

  const check = useQuery({
    queryKey: ['allotment-check', ipoId],
    enabled,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
    // A registrar failure must not silently cost a second lookup.
    retry: false,
    queryFn: async () => {
      refreshed.current = new Set();
      const progress = await runIpoAllotmentCheck(ipoId, applicationIds, ipo, publish);
      // Inside queryFn on purpose: react-query v5 dropped useQuery's onSuccess,
      // and an effect would never fire if you backed out mid-check — which is
      // exactly when the refreshed rows matter most.
      await queryClient.invalidateQueries({ queryKey: ['applications'] });
      return progress;
    },
  });

  const retry = useCallback(
    (ids: string[]) => {
      const current = queryClient.getQueryData<IpoCheckProgress>(['allotment-check', ipoId]);
      if (!current?.matched || ids.length === 0) return;

      setRetrying(true);
      void (async () => {
        try {
          for (const id of ids) refreshed.current.delete(id);
          await retryAllotmentChecks(current, ids, publish);
          await queryClient.invalidateQueries({ queryKey: ['applications'] });
        } finally {
          setRetrying(false);
        }
      })();
    },
    [queryClient, ipoId, publish],
  );

  const progress = check.data;
  const accounts = progress?.accounts ?? [];

  return {
    progress,
    isRunning: check.isFetching || retrying,
    error: check.error instanceof Error ? check.error : null,
    done: accounts.filter((a) => a.phase === 'done' || a.phase === 'skipped').length,
    total: accounts.length,
    failedIds: progress ? retryableIds(progress) : [],
    checkAgain: () => void check.refetch(),
    retry,
  };
}
