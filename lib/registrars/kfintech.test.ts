/**
 * checkKfintechAllotment talks to an undocumented third-party endpoint, so the
 * only thing worth testing here is that the response shape gets translated
 * correctly and that a definitive "no" is never confused with "couldn't tell."
 */
import { jest } from '@jest/globals';

import { checkKfintechAllotment } from './kfintech';

function mockFetchOnce(status: number, body?: unknown) {
  const mock = jest.fn(async (_url: string, _init?: { headers: Record<string, string> }) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  }));
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

describe('checkKfintechAllotment', () => {
  it('sends the PAN and company id as headers, not a body', async () => {
    const mock = mockFetchOnce(200, { data: [] });
    await checkKfintechAllotment('44065980180', 'ABCDE1234F');

    const [url, init] = mock.mock.calls[0];
    expect(url).toContain('type=pan');
    expect(init?.headers.reqparam).toBe('ABCDE1234F');
    expect(init?.headers.client_id).toBe('44065980180');
  });

  it('maps a found application to a match', async () => {
    mockFetchOnce(200, {
      data: [
        { App_Shares: '34', All_Shares: '0', Appln_No: '2607302122365474', DP_CLID: 'X', Name: 'A NAME' },
      ],
    });
    const result = await checkKfintechAllotment('44065980180', 'ABCDE1234F');
    expect(result).toEqual({
      found: true,
      matches: [
        {
          applicationNo: '2607302122365474',
          dpClientId: 'X',
          applicantName: 'A NAME',
          sharesApplied: 34,
          sharesAllotted: 0,
        },
      ],
    });
  });

  it('treats a 404 as a clean "not found", not an error', async () => {
    mockFetchOnce(404);
    await expect(checkKfintechAllotment('44065980180', 'ABCDE1234F')).resolves.toEqual({
      found: false,
    });
  });

  it('treats an empty data array the same as a 404', async () => {
    mockFetchOnce(200, { data: [] });
    await expect(checkKfintechAllotment('44065980180', 'ABCDE1234F')).resolves.toEqual({
      found: false,
    });
  });

  it('throws rather than silently returning "not found" when rate-limited', async () => {
    mockFetchOnce(429);
    await expect(checkKfintechAllotment('44065980180', 'ABCDE1234F')).rejects.toThrow(/rate/i);
  });

  it('throws on a server error instead of guessing an outcome', async () => {
    mockFetchOnce(500);
    await expect(checkKfintechAllotment('44065980180', 'ABCDE1234F')).rejects.toThrow(/500/);
  });
});
