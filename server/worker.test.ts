import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'ethers';
import { DEVELOPER_PROTOCOL } from '@hookedin/play/sdk/developer';
import worker, { CrashRoom } from './worker.ts';
import { HEARTBEAT_MS } from './room.ts';
import type { RoomState } from './room.ts';
import { checkpoints, secretAt, seedOf } from './chain.ts';
import { CHAIN_LENGTH, hashed } from '../src/rules.ts';
import { CHAIN, KEY, secretOf } from '../test/fixture.ts';

/** The tests' server key's chain, as a room keeps it. */
const kept = checkpoints(seedOf(KEY));

/** A room whose storage holds its chain already, with `vars` in place of its own. */
function fixture(t: any, vars: Record<string, string> = {}) {
  let reachable = true,
    configCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (!reachable) throw new Error('Casino unavailable');
    if (String(url).endsWith('/api/config')) {
      configCalls++;
      return Response.json({
        chainId: '31337',
        contractAddress: getAddress('0x' + 'c'.repeat(40)),
        developerProtocol: DEVELOPER_PROTOCOL,
      });
    }
    if (String(url).includes('/api/games/')) return Response.json({ bank: '0' });
    if (String(url).includes('/api/developer-bets?')) {
      // The casino holds a wait until a bet comes; none does.
      if (String(url).includes('&wait=')) await new Promise(resolve => setTimeout(resolve, 20));
      return Response.json({ bets: [], cursor: '', more: false });
    }
    throw new Error(`Unexpected casino request: ${url}`);
  });
  const stored = new Map<string, unknown>([['chain', kept]]),
    background: Promise<unknown>[] = [],
    alarms: number[] = [],
    watching: (() => Promise<void>)[] = [];
  t.after(() => Promise.all(watching.map(stop => stop())));
  const ctx = {
    storage: {
      get: async (key: string) => structuredClone(stored.get(key)),
      put: async (key: string, value: unknown) => {
        stored.set(key, structuredClone(value));
      },
      setAlarm: async (at: number) => {
        alarms.push(at);
      },
    },
    waitUntil: (promise: Promise<unknown>) => {
      background.push(promise);
    },
  } as unknown as DurableObjectState;
  const env = {
    CASINO_URL: 'https://casino.test',
    GAME: '0199a1b2-c3d4-7e5f-8a6b-39393939393a',
    SERVER_KEY: KEY,
    CHAIN_END: CHAIN.end,
    CHAIN_BLOCK: String(CHAIN.block),
    CHAIN_SALT: CHAIN.salt,
    ...vars,
  } as never;
  let room = new CrashRoom(ctx, env);
  return {
    stored,
    alarms,
    background,
    configCalls: () => configCalls,
    reachable: (value: boolean) => {
      reachable = value;
    },
    restart: () => {
      room = new CrashRoom(ctx, env);
    },
    get room() {
      return room;
    },
    get: (path: string) => room.fetch(new Request('https://crash.test' + path)),
    post: (body: string) => room.fetch(new Request('https://crash.test/api/cashout', { method: 'POST', body })),
    /** A page watching the room: its reply, the events it hears, one at a time, and how it stops watching, after
     * which the room has stopped following the casino's bets for it. */
    async watch() {
      const response = await room.fetch(new Request('https://crash.test/api/live')),
        reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let text = '';
      const stop = async () => {
        await reader.cancel().catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 50));
      };
      watching.push(stop);
      return {
        response,
        stop,
        async next() {
          for (let end = text.indexOf('\n\n'); ; end = text.indexOf('\n\n')) {
            if (end < 0) {
              const { value, done } = await reader.read();
              if (done) throw new Error('The room stopped');
              text += value;
              continue;
            }
            const data = /^data: (.*)$/m.exec(text.slice(0, end));
            text = text.slice(end + 2);
            if (data) return JSON.parse(data[1]!);
          }
        },
      };
    },
  };
}

test('the Worker shares startup, publishes no secret, forbids caching and restores its commitment after eviction', async t => {
  const x = fixture(t);
  const [a, b] = await Promise.all([x.watch(), x.watch()]);
  const first = await a.next(),
    second = await b.next();
  assert.equal(first.id, second.id);
  assert.deepEqual([first.number, first.id, first.chain], [1, CHAIN.end.slice(2), CHAIN]);
  assert.equal(first.secret, null);
  assert.equal(x.configCalls(), 1);
  assert.equal(a.response.headers.get('content-type'), 'text/event-stream');
  assert.equal(a.response.headers.get('cache-control'), 'no-store');
  assert.equal((await x.get(`/api/flights/${first.id}`)).status, 404);
  await Promise.all([a.stop(), b.stop()]);
  x.restart();
  const again = await x.watch();
  assert.equal((await again.next()).id, first.id);
  assert.equal((x.stored.get('state') as RoomState).flight!.number, 1);
});

test('the room computes SERVER_KEY’s chain once and keeps it, and refuses to fly unless it ends at CHAIN_END', async t => {
  // Every flight's secret, hashed as many times as its number, is the end `npm run chain` prints.
  assert.equal(kept[0], CHAIN.end);
  assert.equal(secretAt(kept, CHAIN_LENGTH), seedOf(KEY));
  for (const number of [1, 2, 1023, 1024, 1025, 2048, 5000])
    assert.equal(hashed(secretAt(kept, number), number), CHAIN.end);
  assert.deepEqual([secretAt(kept, 1), secretAt(kept, 1024)], [secretOf(1), secretOf(1024)]);
  for (const number of [0, 1.5, CHAIN_LENGTH + 1]) assert.throws(() => secretAt(kept, number), /new chain/);
  const x = fixture(t);
  x.stored.delete('chain');
  assert.equal((await x.get(`/api/flights/${'0'.repeat(64)}`)).status, 404, 'the room opens');
  assert.deepEqual(x.stored.get('chain'), kept);
  for (const [vars, error] of [
    [{ CHAIN_SALT: '' }, /^Set CHAIN_END, CHAIN_BLOCK and CHAIN_SALT/],
    [{ CHAIN_BLOCK: '01' }, /^Set CHAIN_END/],
    [{ CHAIN_END: CHAIN.end.toUpperCase().replace('0X', '0x') }, /^Set CHAIN_END/],
    [{ CHAIN_END: '0x' + 'f'.repeat(64) }, /^SERVER_KEY’s chain does not end at CHAIN_END/],
    [{ SERVER_KEY: KEY.slice(2) }, /^SERVER_KEY is not 32 bytes/],
  ] as const) {
    // The page's event stream hears why, and the Worker's log has it.
    const logged = t.mock.method(console, 'error', () => {}),
      refused = await fixture(t, vars).get('/api/live');
    assert.equal(refused.headers.get('content-type'), 'text/event-stream');
    const down = /^event: down\ndata: (.*)\n\n$/.exec(await refused.text());
    assert.match((JSON.parse(down![1]!) as { error: string }).error, error);
    assert.match(String(logged.mock.calls.at(-1)!.arguments[1]), error);
    logged.mock.restore();
  }
});

test('startup recovers when the casino returns, and malformed or unauthenticated cash-outs fail', async t => {
  const x = fixture(t);
  x.reachable(false);
  t.mock.method(console, 'error', () => {});
  assert.match(await (await x.get('/api/live')).text(), /^event: down\n/);
  x.reachable(true);
  assert.equal((await x.watch()).response.status, 200);
  assert.equal((await x.post('{')).status, 400);
  assert.equal((await x.post('{}')).status, 400);
  assert.equal((await x.post(' '.repeat(1025))).status, 413);
  assert.equal(
    (await x.post(JSON.stringify({ flight: 'wrong', bet: 'wrong', token: 'wrong', more: 'riding along' }))).status,
    400,
  );
  assert.equal((await x.post(JSON.stringify({ flight: 'wrong', bet: 'wrong', token: 'wrong' }))).status, 403);
  await Promise.all(x.background);
});

test('a room nobody watches or boards lets its alarm lapse, a watched one keeps its heartbeat, and an alarm that cannot open the room tries again', async t => {
  const x = fixture(t);
  assert.equal((await x.get(`/api/flights/${'0'.repeat(64)}`)).status, 404);
  await x.room.alarm();
  assert.deepEqual(x.alarms, [], 'the room has no work, so nothing is scheduled');
  const page = await x.watch();
  await page.next();
  assert.ok(x.alarms.at(-1)! <= Date.now() + HEARTBEAT_MS, 'a watched room wakes for its heartbeat');
  await x.room.alarm();
  await page.next();
  await page.stop();
  const lapsed = x.alarms.length;
  await x.room.alarm();
  assert.equal(x.alarms.length, lapsed, 'and lets it lapse once nobody watches');
  x.reachable(false);
  x.restart();
  await x.room.alarm();
  assert.ok(x.alarms.at(-1)! > Date.now(), 'a room that cannot start tries again shortly');
});

test('the Worker routes every player to the one room and serves the built page through ASSETS', async () => {
  const rooms: string[] = [];
  const env = {
    ASSETS: { fetch: () => new Response('page') },
    FLIGHTS: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: () => {
          rooms.push(name);
          return new Response(name);
        },
      }),
    },
  } as never;
  assert.equal(await (await worker.fetch(new Request('https://crash.test/'), env)).text(), 'page');
  await worker.fetch(new Request('https://crash.test/api/live'), env);
  await worker.fetch(new Request('https://crash.test/api/cashout', { method: 'POST' }), env);
  assert.deepEqual(rooms, ['room', 'room']);
});
