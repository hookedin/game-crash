import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { DEVELOPER_PROTOCOL, LIMITS } from '@hookedin/play/sdk/developer';
import worker, { CrashRoom } from './worker.ts';

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
        limits: LIMITS,
      });
    }
    if (String(url).includes('/api/developer-bets?')) return Response.json({ bets: [], cursor: '', more: false });
    throw new Error(`Unexpected casino request: ${url}`);
  });
  const stored = new Map<string, unknown>(),
    background: Promise<unknown>[] = [],
    alarms: number[] = [];
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
    get: (path = '/api/flight') => room.fetch(new Request('https://crash.test' + path)),
    post: (body: string) => room.fetch(new Request('https://crash.test/api/cashout', { method: 'POST', body })),
  };
}

test('the Worker shares startup, publishes no secret, forbids caching and restores its commitment after eviction', async t => {
  const x = fixture(t);
  const [a, b] = await Promise.all([x.get(), x.get()]);
  const first = (await a.json()) as any,
    second = (await b.json()) as any;
  assert.equal(first.id, second.id);
  assert.equal(first.secret, null);
  assert.equal(x.configCalls(), 1);
  assert.equal(a.headers.get('cache-control'), 'no-store');
  assert.equal((await x.get(`/api/flights/${first.id}`)).status, 404);
  await Promise.all(x.background);
  x.restart();
  assert.equal(((await (await x.get()).json()) as any).id, first.id);
});

test('startup recovers when the casino returns, and malformed or unauthenticated cash-outs fail', async t => {
  const x = fixture(t);
  x.reachable(false);
  assert.equal((await x.get()).status, 503);
  x.reachable(true);
  assert.equal((await x.get()).status, 200);
  assert.equal((await x.post('{')).status, 400);
  assert.equal((await x.post('{}')).status, 400);
  assert.equal((await x.post(' '.repeat(1025))).status, 413);
  assert.equal((await x.post(JSON.stringify({ flight: 'wrong', bet: 'wrong', token: 'wrong' }))).status, 403);
  await Promise.all(x.background);
});

test('a room with nobody aboard lets its alarm lapse, and an alarm that cannot open the room tries again', async t => {
  const x = fixture(t);
  assert.equal((await x.get()).status, 200);
  await Promise.all(x.background);
  await x.room.alarm();
  assert.deepEqual(x.alarms, [], 'the room has no work, so nothing is scheduled');
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
  await worker.fetch(new Request('https://crash.test/api/flight'), env);
  await worker.fetch(new Request('https://crash.test/api/placed', { method: 'POST' }), env);
  assert.deepEqual(rooms, ['room', 'room']);
});
