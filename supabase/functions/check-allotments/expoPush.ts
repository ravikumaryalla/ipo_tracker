/**
 * Mechanical bits of talking to Expo's push API, kept pure so they can be
 * unit-tested without a network or Deno — same split as parse.ts / bigshare.ts
 * / mufg.ts in this folder. index.ts#sendAllotmentPushes does the fetch and the
 * push_tokens cleanup.
 */

export type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  sound?: 'default' | null;
  channelId?: string;
  data?: Record<string, unknown>;
};

/** Expo rejects a /push/send request carrying more than 100 messages. */
export const EXPO_PUSH_CHUNK = 100;

export function chunkMessages<T>(messages: T[], size = EXPO_PUSH_CHUNK): T[][] {
  if (size < 1) throw new Error('chunk size must be >= 1');
  const out: T[][] = [];
  for (let i = 0; i < messages.length; i += size) {
    out.push(messages.slice(i, i + size));
  }
  return out;
}

export type ExpoPushTicket = {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string } & Record<string, unknown>;
};

/**
 * Pull the per-message tickets out of one Expo /push/send response. Expo wraps
 * them in `{ data: [...] }`, one entry per message in request order. A
 * top-level `{ errors: [...] }` (bad auth, malformed body) has no `data` at
 * all — treated here as "no tickets", i.e. nothing delivered, nothing to prune.
 */
export function parseSendTickets(json: unknown): ExpoPushTicket[] {
  if (!json || typeof json !== 'object') return [];
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data.filter(
    (t): t is ExpoPushTicket =>
      !!t && typeof t === 'object' && typeof (t as { status?: unknown }).status === 'string',
  );
}

/**
 * A token Expo will never deliver to again — the device removed the app, or the
 * FCM/APNs credential it was minted against is gone. Its push_tokens row should
 * be dropped so later runs stop wasting a message slot on it.
 */
export function deviceIsGone(ticket: ExpoPushTicket): boolean {
  if (ticket.status !== 'error') return false;
  const code = ticket.details?.error;
  return code === 'DeviceNotRegistered' || code === 'InvalidCredentials';
}
