import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { DEVELOPER_PROTOCOL } from '@hookedin/play/sdk/developer';
import worker, { CrashRoom } from './worker.ts';
import { HEARTBEAT_MS } from './room.ts';

function fixture(t: any) {
  let reachable = true,
    configCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (!reachable) throw new Error('Casino unavailable');
    if (String(url).endsWith('/api/config')) {
      configCalls++;
      return Response.json({
        chainId: '31337',
        contractAddress: '0x' + 'c'.repeat(40),
        developerProtocol: DEVELOPER_PROTOCOL,
      });
    }
    if (String(url).includes('/api/developer-bets?')) {
      // The casino holds a wait until a bet comes; none does.
      if (String(url).includes('&wait=')) await new Promise(resolve => setTimeout(resolve, 20));
      return Response.json({ bets: [], cursor: '0', more: false });
    }
    throw new Error(`Unexpected casino request: ${url}`);
  });
  const stored = new Map<string, unknown>(),
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
    GAME_NAME: 'crash',
    DEVELOPER_KEY: Wallet.createRandom().privateKey,
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
  assert.equal(first.secret, null);
  assert.equal(x.configCalls(), 1);
  assert.equal(a.response.headers.get('content-type'), 'text/event-stream');
  assert.equal(a.response.headers.get('cache-control'), 'no-store');
  assert.equal((await x.get(`/api/flights/${first.id}`)).status, 404);
  await Promise.all([a.stop(), b.stop()]);
  x.restart();
  const again = await x.watch();
  assert.equal((await again.next()).id, first.id);
});

test('startup recovers when the casino returns, and malformed or unauthenticated cash-outs fail', async t => {
  const x = fixture(t);
  x.reachable(false);
  assert.equal((await x.get('/api/live')).status, 503);
  x.reachable(true);
  assert.equal((await x.watch()).response.status, 200);
  assert.equal((await x.post('{')).status, 400);
  assert.equal((await x.post('{}')).status, 400);
  assert.equal((await x.post(' '.repeat(1025))).status, 413);
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
