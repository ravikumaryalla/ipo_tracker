import {
  chunkMessages,
  deviceIsGone,
  EXPO_PUSH_CHUNK,
  type ExpoPushTicket,
  parseSendTickets,
} from './expoPush.ts';

describe('chunkMessages', () => {
  it('returns a single chunk when under the limit', () => {
    expect(chunkMessages([1, 2, 3])).toEqual([[1, 2, 3]]);
  });

  it('splits exactly on the 100-message boundary', () => {
    const msgs = Array.from({ length: 250 }, (_, i) => i);
    const chunks = chunkMessages(msgs);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(chunks.flat()).toEqual(msgs);
    expect(EXPO_PUSH_CHUNK).toBe(100);
  });

  it('emits nothing for an empty list', () => {
    expect(chunkMessages([])).toEqual([]);
  });

  it('honours a custom size', () => {
    expect(chunkMessages([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('rejects a non-positive size', () => {
    expect(() => chunkMessages([1], 0)).toThrow();
  });
});

describe('parseSendTickets', () => {
  it('pulls the tickets out of a normal response, in order', () => {
    const json = {
      data: [
        { status: 'ok', id: 'a' },
        { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      ],
    };
    expect(parseSendTickets(json)).toHaveLength(2);
    expect(parseSendTickets(json)[0].id).toBe('a');
  });

  it('returns [] for a top-level errors envelope (no data)', () => {
    expect(parseSendTickets({ errors: [{ code: 'PUSH_TOO_MANY_EXPERIENCE_IDS' }] })).toEqual([]);
  });

  it('returns [] for junk', () => {
    expect(parseSendTickets(null)).toEqual([]);
    expect(parseSendTickets('nope')).toEqual([]);
    expect(parseSendTickets({ data: 'nope' })).toEqual([]);
  });

  it('drops malformed ticket entries', () => {
    expect(parseSendTickets({ data: [null, 3, { id: 'no-status' }, { status: 'ok' }] })).toEqual([
      { status: 'ok' },
    ]);
  });
});

describe('deviceIsGone', () => {
  const ticket = (patch: Partial<ExpoPushTicket>): ExpoPushTicket => ({ status: 'error', ...patch });

  it('is true for DeviceNotRegistered', () => {
    expect(deviceIsGone(ticket({ details: { error: 'DeviceNotRegistered' } }))).toBe(true);
  });

  it('is true for InvalidCredentials', () => {
    expect(deviceIsGone(ticket({ details: { error: 'InvalidCredentials' } }))).toBe(true);
  });

  it('is false for a transient MessageRateExceeded error', () => {
    expect(deviceIsGone(ticket({ details: { error: 'MessageRateExceeded' } }))).toBe(false);
  });

  it('is false for an ok ticket', () => {
    expect(deviceIsGone({ status: 'ok', id: 'x' })).toBe(false);
  });

  it('is false when there are no details', () => {
    expect(deviceIsGone(ticket({}))).toBe(false);
  });
});
