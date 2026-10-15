/** Local preview and browser-test host. Each visitor gets an SDK wallet fixture against an in-memory casino stub.
 * Their developer feeds are combined into one real Room. No keys, balances or endpoints here belong to a deployment. */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createStaticServer } from '@hookedin/play/sdk/bin/hookedin-game.js';
import { gameWallet } from '@hookedin/play/testing/game-wallet.ts';
import { json, read } from '@hookedin/play/sdk/json';
import type { GameReceipt } from '@hookedin/play/sdk/sdk';
import type { PublicDeveloperBet } from '@hookedin/play/sdk/developer';
import type { FlightProof } from '../src/rules.ts';
import { Room } from '../server/room.ts';
import { checkpoints, secretAt, seedOf } from '../server/chain.ts';
import { CHAIN, KEY } from './fixture.ts';

/** The built page, served as its host serves it, with its `_headers`. */
const built = createStaticServer(fileURLToPath(new URL('../dist', import.meta.url)));
/** The bridge crosses this host as JSON, each of its bigints tagged, and comes out with its bigints again. */
const encode = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? { bigint: String(v) } : v));
const decode = (text: string) =>
  JSON.parse(text, (_, v) =>
    v && typeof v === 'object' && Object.keys(v).length === 1 && Object.hasOwn(v, 'bigint') ? read.whole(v.bigint) : v,
  );
type Fixture = Awaited<ReturnType<typeof gameWallet>>;
interface Pilot {
  fixture: Fixture;
  name: string;
  events: GameReceipt[];
  queue: Promise<unknown>;
}

export async function startHarness({ port = 0, clock = Date.now }: { port?: number; clock?: () => number } = {}) {
  const pilots = new Map<string, Pilot>(),
    owner = new Map<string, Pilot>(),
    proofs = new Map<string, FlightProof>(),
    // Every bet in the order this host first saw it, as the casino orders the bets it took, and every page watching.
    order = new Map<string, number>(),
    pages = new Set<http.ServerResponse>();
  let offset = 0;
  const now = () => clock() + offset;
  // The flights fly along the tests' chain, which the host computes as a room does.
  const kept = checkpoints(seedOf(KEY));
  const room = new Room({
    chain: CHAIN,
    secret: number => secretAt(kept, number),
    now,
    save: async () => {},
    keep: async proof => {
      proofs.set(proof.id, structuredClone(proof));
    },
    kept: async id => proofs.get(id),
    // The host ticks the room itself, and reads the bets each time.
    wake: async () => {},
    show: view => {
      for (const page of pages) page.write(`data: ${json(view)}\n\n`);
    },
    watched: () => pages.size > 0,
    developer: {
      // Each pilot's own stub casino pays its settlements: the preview's bank is all of theirs.
      bank: async () => [...pilots.values()].reduce((sum, pilot) => sum + pilot.fixture.bank(), 0n),
      async bets({ after = '' } = {}) {
        const all: PublicDeveloperBet[] = [];
        for (const pilot of pilots.values()) {
          const page = await pilot.fixture.developer.bets();
          for (const bet of page.bets) {
            owner.set(bet.bet, pilot);
            if (!order.has(bet.bet)) order.set(bet.bet, order.size + 1);
            all.push({ ...bet, discordUsername: pilot.name });
          }
        }
        const eligible = all
            .filter(bet => order.get(bet.bet)! > Number(after || '0'))
            .sort((a, b) => order.get(a.bet)! - order.get(b.bet)!),
          bets = eligible.slice(0, 100);
        return {
          bets,
          cursor: String(bets.length ? order.get(bets.at(-1)!.bet) : after || '0'),
          more: eligible.length > 100,
        };
      },
      async settle(payments) {
        const results: PublicDeveloperBet[] = [];
        for (const pilot of pilots.values()) {
          const own = payments.filter(p => owner.get(p.bet) === pilot);
          if (own.length) results.push(...(await pilot.fixture.developer.settle(own)));
        }
        return results;
      },
    },
  });
  const timer = setInterval(() => {
    void room
      .read()
      .then(() => room.tick())
      .catch(console.error);
  }, 150);
  const hostScript = `
    const frame = document.querySelector('iframe');
    const whole = text => {
      if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error('A whole number is not in its one form');
      return BigInt(text);
    };
    const encode = value => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? { bigint: String(v) } : v));
    const decode = text => JSON.parse(text, (_, v) =>
      v && typeof v === 'object' && Object.keys(v).length === 1 && Object.hasOwn(v, 'bigint') ? whole(v.bigint) : v);
    const endpoint = '/bridge/' + location.pathname.split('/').pop();
    function push(data) {
      for (const receipt of data.receipts || []) frame.contentWindow.postMessage({hookedin:true,event:'game.receipt',receipt}, location.origin);
    }
    addEventListener('message', async event => {
      if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.hookedin !== true || !event.data.method) return;
      const {id,method,params} = event.data;
      try {
        const response = await fetch(endpoint, {method:'POST',body:encode({method,params})});
        const data = decode(await response.text());
        frame.contentWindow.postMessage({hookedin:true,id,...(data.error ? {error:data.error} : {result:data.result})}, location.origin);
        push(data);
      } catch (error) { frame.contentWindow.postMessage({hookedin:true,id,error:{code:'failed',message:error.message}},location.origin); }
    });
    setInterval(async () => { try { push(decode(await (await fetch(endpoint)).text())); } catch {} }, 500);
  `;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const respond = (body: string, status = 200) =>
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(body);
    try {
      if (url.pathname === '/') {
        const fixture = await gameWallet({ deposit: 10n ** 18n, bank: 10n ** 18n }),
          id = randomBytes(8).toString('hex');
        const name =
          ['nova', 'orbit', 'comet', 'luna', 'cosmo'][pilots.size % 5]! + (pilots.size >= 5 ? pilots.size : '');
        fixture.wallet.openGame(fixture.identity());
        // The pilot allows the game the whole balance, developer bets included, as a player does in the top bar.
        await fixture.wallet.setGameAllowance(fixture.wallet.playableBalance(), true);
        fixture.wallet.discordUsername = name;
        const pilot: Pilot = { fixture, name, events: [], queue: Promise.resolve() };
        fixture.bridge.onReceipt(receipt => {
          pilot.events.push(receipt);
        });
        pilots.set(id, pilot);
        return void res.writeHead(302, { Location: `/pilot/${id}` }).end();
      }
      if (url.pathname.startsWith('/pilot/')) {
        if (!pilots.has(url.pathname.slice(7))) return void res.writeHead(302, { Location: '/' }).end();
        return void res
          .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(
            `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Crash · Local preview</title><style>body{margin:0;background:#101219}header{height:30px;display:flex;align-items:center;justify-content:center;gap:16px;background:#282c27;color:#c6d6ba;font:10px system-ui}a{color:#c6f9a7}iframe{display:block;width:100%;height:calc(100dvh - 30px);border:0}</style></head><body><header>LOCAL PREVIEW · SIMULATED FUNDS <a href="/" target="_blank" rel="noopener">Join as another pilot ↗</a></header><iframe title="Crash" sandbox="allow-scripts allow-same-origin" src="/game/"></iframe><script src="/preview.js"></script></body></html>`,
          );
      }
      if (url.pathname === '/preview.js')
        return void res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(hostScript);
      if (url.pathname.startsWith('/bridge/')) {
        const pilot = pilots.get(url.pathname.slice(8));
        if (!pilot)
          return void respond(
            encode({ error: { code: 'missing', message: 'This preview session ended. Reload the preview.' } }),
            404,
          );
        const invoke = async () => {
          await pilot.fixture.wallet.collectPayouts();
          let result: unknown;
          if (req.method === 'POST') {
            let text = '';
            for await (const chunk of req) text += chunk;
            const { method, params } = decode(text);
            result = await pilot.fixture.bridge.call(method, params);
            if (method === 'wallet.info') result = { ...(result as object), recommendedStake: 10n ** 15n };
          }
          return { result, receipts: pilot.events.splice(0) };
        };
        const pending = pilot.queue.then(invoke);
        pilot.queue = pending.catch(() => {});
        try {
          return void respond(encode(await pending));
        } catch (error: any) {
          return void respond(encode({ error: { code: error.code ?? 'failed', message: error.message } }), 400);
        }
      }
      if (url.pathname.startsWith('/game/api/')) {
        const route = url.pathname.slice('/game/api'.length);
        if (route === '/live') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
          res.write('retry: 1000\n\n');
          pages.add(res);
          req.once('close', () => pages.delete(res));
          return void res.write(`data: ${json(await room.view())}\n\n`);
        }
        if (route === '/cashout' && req.method === 'POST') {
          let text = '';
          for await (const chunk of req) text += chunk;
          const body = JSON.parse(text),
            result = await room.cashout(body.flight, body.bet, body.token);
          void room.pay().catch(console.error);
          return void respond(json(result));
        }
        if (route.startsWith('/flights/')) {
          const proof = await room.kept(route.slice(9));
          return void respond(json(proof ?? { error: 'Flight not revealed.' }), proof ? 200 : 404);
        }
      }
      if (url.pathname.startsWith('/game/')) {
        req.url = req.url!.slice('/game'.length);
        return void built.emit('request', req, res);
      }
      res.writeHead(404).end();
    } catch (error: any) {
      respond(json({ error: error.message }), error.status ?? 500);
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    clearInterval(timer);
    throw error;
  }
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    room,
    pilots,
    async advance(ms: number) {
      offset += ms;
      await room.read();
      await room.tick();
    },
    async close() {
      clearInterval(timer);
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const local = await startHarness({ port: 8791 });
  console.log(`Crash local preview: ${local.url}\nSimulated funds only. Open the link in another tab to add a player.`);
  const stop = () => {
    void local.close().then(() => process.exit());
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
