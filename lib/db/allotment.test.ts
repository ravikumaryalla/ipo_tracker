/**
 * The sequential runner behind "Check status".
 *
 * The property that matters most here is the one the batch used to break: every
 * account is a separate invocation, carrying exactly one id, and its result is
 * published before the next one starts. The rest is about not making a bad
 * situation worse — one unreachable call must not abandon the queue, and a
 * Bigshare that has stopped answering must not be asked N more times.
 */
import { jest } from '@jest/globals';

import {
  type IpoCheckProgress,
  type OnDemandCheckResult,
  type RegistrarLookup,
  isRetryable,
  retryAllotmentChecks,
  retryableIds,
  runIpoAllotmentCheck,
} from './allotment';
import { clearSupabaseStub, setSupabaseStub } from '../testing/supabaseMock';

const KFINTECH_IPO: RegistrarLookup = {
  kfintech_company_id: 'kf-1',
  bigshare_company_id: null,
  mufg_company_id: null,
  registrar: 'KFintech',
};

const BIGSHARE_IPO: RegistrarLookup = {
  kfintech_company_id: null,
  bigshare_company_id: 'bs-1',
  mufg_company_id: null,
  registrar: 'Bigshare',
};

const UNMATCHED_IPO: RegistrarLookup = {
  kfintech_company_id: null,
  bigshare_company_id: null,
  mufg_company_id: null,
  registrar: 'Bigshare',
};

function resolved(id: string): OnDemandCheckResult {
  return { id, outcome: 'resolved', status: 'ALLOTTED', shares_allotted: 15, shares_applied: 15 };
}

function transient(id: string): OnDemandCheckResult {
  return { id, outcome: 'not-yet', message: 'Bigshare captcha could not be read' };
}

/**
 * Records every id the runner asks about, and answers each with whatever
 * `reply` says. Returns the spy so a test can assert on call shape, not just
 * on the ids that came back.
 */
function stubInvoke(reply: (id: string) => OnDemandCheckResult) {
  const invoke = jest.fn(async (_name: string, options: { body: { applicationIds: string[] } }) => {
    const ids = options.body.applicationIds;
    return { data: { ok: true, results: ids.map(reply) }, error: null };
  });
  setSupabaseStub({ functions: { invoke } });
  return invoke;
}

/** The ids each invocation carried, in call order. */
function idsPerCall(invoke: { mock: { calls: unknown[][] } }): string[][] {
  return invoke.mock.calls.map(
    (call) => (call[1] as { body: { applicationIds: string[] } }).body.applicationIds,
  );
}

afterEach(() => {
  clearSupabaseStub();
  jest.useRealTimers();
});

describe('isRetryable', () => {
  it('offers a retry for an outright error', () => {
    expect(isRetryable({ id: 'a', outcome: 'error', message: 'boom' })).toBe(true);
  });

  it('offers a retry for a not-yet that carries a transient message', () => {
    expect(isRetryable(transient('a'))).toBe(true);
  });

  it('does not offer a retry for a bare not-yet — results simply are not out', () => {
    expect(isRetryable({ id: 'a', outcome: 'not-yet' })).toBe(false);
  });

  it.each(['resolved', 'no-match', 'no-pan'] as const)('does not offer a retry for %s', (outcome) => {
    expect(isRetryable({ id: 'a', outcome, message: 'anything' })).toBe(false);
  });
});

describe('retryableIds', () => {
  it('picks failed and skipped accounts, and leaves settled ones alone', () => {
    const progress: IpoCheckProgress = {
      matched: true,
      provider: 'BIGSHARE',
      accounts: [
        { id: 'a', phase: 'done', result: resolved('a') },
        { id: 'b', phase: 'done', result: transient('b') },
        { id: 'c', phase: 'done', result: { id: 'c', outcome: 'not-yet' } },
        { id: 'd', phase: 'skipped', message: 'never asked' },
        { id: 'e', phase: 'done', result: { id: 'e', outcome: 'no-pan', message: 'no PAN saved' } },
      ],
    };
    expect(retryableIds(progress)).toEqual(['b', 'd']);
  });
});

describe('runIpoAllotmentCheck', () => {
  it('invokes once per account, one id at a time, in order', async () => {
    const invoke = stubInvoke(resolved);

    const progress = await runIpoAllotmentCheck('ipo-1', ['a', 'b', 'c'], KFINTECH_IPO, () => {});

    expect(idsPerCall(invoke)).toEqual([['a'], ['b'], ['c']]);
    expect(invoke.mock.calls[0][0]).toBe('check-allotments');
    expect(progress.accounts.map((s) => s.phase)).toEqual(['done', 'done', 'done']);
  });

  it('publishes each account as checking, then done, before starting the next', async () => {
    stubInvoke(resolved);
    const seen: string[] = [];

    await runIpoAllotmentCheck('ipo-1', ['a', 'b'], KFINTECH_IPO, (p) => {
      seen.push(p.accounts.map((s) => `${s.id}:${s.phase}`).join(','));
    });

    expect(seen).toEqual([
      'a:queued,b:queued',
      'a:checking,b:queued',
      'a:done,b:queued',
      'a:done,b:checking',
      'a:done,b:done',
    ]);
  });

  it('turns an unreachable invocation into that one account failing, not the run', async () => {
    const invoke = jest.fn(async (_name: string, options: { body: { applicationIds: string[] } }) =>
      options.body.applicationIds[0] === 'a'
        ? { data: null, error: new Error('network') }
        : { data: { results: [resolved('b')] }, error: null },
    );
    setSupabaseStub({ functions: { invoke } });

    const progress = await runIpoAllotmentCheck('ipo-1', ['a', 'b'], KFINTECH_IPO, () => {});

    expect(progress.accounts[0].result?.outcome).toBe('error');
    expect(progress.accounts[1].result?.outcome).toBe('resolved');
    expect(retryableIds(progress)).toEqual(['a']);
  });

  it('fails just that account when the service answers without a result for it', async () => {
    setSupabaseStub({
      functions: { invoke: jest.fn(async () => ({ data: { ok: true, results: [] }, error: null })) },
    });

    const progress = await runIpoAllotmentCheck('ipo-1', ['a'], KFINTECH_IPO, () => {});

    expect(progress.accounts[0].result?.outcome).toBe('error');
  });

  it('stops asking Bigshare after two consecutive failures and skips the rest', async () => {
    // Bigshare rows are paced 1.5s apart (BIGSHARE_INTER_CHECK_MS); faking the
    // clock keeps the test about the breaker rather than about the wait.
    jest.useFakeTimers();
    const invoke = stubInvoke(transient);

    const run = runIpoAllotmentCheck('ipo-1', ['a', 'b', 'c', 'd'], BIGSHARE_IPO, () => {});
    await jest.advanceTimersByTimeAsync(10_000);
    const progress = await run;

    expect(idsPerCall(invoke)).toEqual([['a'], ['b']]);
    expect(progress.accounts.map((s) => s.phase)).toEqual(['done', 'done', 'skipped', 'skipped']);
    // Skipped accounts carry no verdict, so all four are worth asking again.
    expect(retryableIds(progress)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not trip the breaker on a registrar it was not written for', async () => {
    // KFintech's own permanent per-row failure (two applications on one PAN)
    // must not make healthy accounts behind it look unavailable.
    const invoke = stubInvoke((id) => ({ id, outcome: 'error', message: 'more than one application' }));

    const progress = await runIpoAllotmentCheck('ipo-1', ['a', 'b', 'c'], KFINTECH_IPO, () => {});

    expect(idsPerCall(invoke)).toEqual([['a'], ['b'], ['c']]);
    expect(progress.accounts.every((s) => s.phase === 'done')).toBe(true);
  });

  it('records the attempt and asks nobody when the IPO still has no registrar match', async () => {
    const update = jest.fn((_patch: Record<string, unknown>) => ({
      in: async (_column: string, _ids: string[]) => ({ error: null }),
    }));
    const invoke = jest.fn(async (_name: string, _options: unknown) => ({
      data: null,
      error: null,
    }));
    setSupabaseStub({
      functions: { invoke },
      from: (_table: string) => ({
        update,
        select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }),
      }),
    });

    const progress = await runIpoAllotmentCheck('ipo-1', ['a', 'b'], UNMATCHED_IPO, () => {});

    expect(progress).toEqual({
      matched: false,
      message: 'allotment not released yet',
      provider: null,
      accounts: [],
    });
    // sync-ipos was asked to match; check-allotments never was.
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(['sync-ipos']);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ allotment_checked_at: expect.any(String) }),
    );
  });
});

describe('retryAllotmentChecks', () => {
  it('re-checks only the accounts named and leaves the others untouched', async () => {
    const before: IpoCheckProgress = {
      matched: true,
      provider: 'KFINTECH',
      accounts: [
        { id: 'a', phase: 'done', result: resolved('a') },
        { id: 'b', phase: 'done', result: transient('b') },
        { id: 'c', phase: 'skipped', message: 'never asked' },
      ],
    };
    const invoke = stubInvoke(resolved);

    const after = await retryAllotmentChecks(before, ['b', 'c'], () => {});

    expect(idsPerCall(invoke)).toEqual([['b'], ['c']]);
    expect(after.accounts[0]).toEqual(before.accounts[0]);
    expect(after.accounts[1].result?.outcome).toBe('resolved');
    expect(after.accounts[2].result?.outcome).toBe('resolved');
    expect(retryableIds(after)).toEqual([]);
  });
});
