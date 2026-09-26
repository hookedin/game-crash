/** Local preview and browser-test host. Each visitor gets an SDK wallet fixture against an in-memory casino stub.
 * Their developer feeds are combined into one real Room. No keys, balances or endpoints here belong to a deployment. */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { gameWallet } from '@hookedin/play/testing/game-wallet.ts';
import type { GameReceipt } from '@hookedin/play/sdk/sdk';
import type { PublicDeveloperBet } from '@hookedin/play/sdk/developer';
import type { FlightProof } from '../src/rules.ts';
import { Room } from '../server/room.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
type Fixture = Awaited<ReturnType<typeof gameWallet>>;
interface Pilot {
  fixture: Fixture;
  name: string;
  events: GameReceipt[];
  queue: Promise<unknown>;
}

export async function startHarness({
  port = 0,
  secret,
  clock = Date.now,
}: { port?: number; secret?: string; clock?: () => number } = {}) {
  const pilots = new Map<string, Pilot>(),
    owner = new Map<string, Pilot>(),
    proofs = new Map<string, FlightProof>();
  let offset = 0,
    nextSecret = 0;
  const now = () => clock() + offset;
  const room = new Room({
    now,
    secret: () =>
      secret
        ? secret.slice(0, 50) + (nextSecret++).toString(16).padStart(16, '0')
        : '0x' + randomBytes(32).toString('hex'),
    save: async () => {},
    keep: async proof => {
      proofs.set(proof.id, structuredClone(proof));
    },
    kept: async id => proofs.get(id),
    wake: async () => {},
    developer: {
      async bets({ after = '', limit = 100 } = {}) {
        const all: PublicDeveloperBet[] = [];
        for (const pilot of pilots.values()) {
          const page = await pilot.fixture.developer.bets();
          for (const bet of page.bets) {
            owner.set(bet.bet, pilot);
            all.push({ ...bet, alias: pilot.name });
          }
        }
        all.sort((a, b) => a.bet.localeCompare(b.bet));
        const eligible = all.filter(bet => bet.bet > after),
          bets = eligible.slice(0, limit);
        return { bets, cursor: bets.at(-1)?.bet ?? after, more: eligible.length > limit };
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
      .view()
      .then(() => room.sync())
      .catch(console.error);
  }, 150);
  const hostScript = `
    const frame = document.querySelector('iframe');
    const endpoint = '/bridge/' + location.pathname.split('/').pop();
    function push(data) {
      frame.contentWindow.postMessage({hookedin:true,event:'game.balance',...data.balance}, location.origin);
      for (const receipt of data.receipts || []) frame.contentWindow.postMessage({hookedin:true,event:'game.receipt',receipt}, location.origin);
    }
    addEventListener('message', async event => {
      if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.hookedin !== true || !event.data.method) return;
      const {id,method,params} = event.data;
      try {
        const response = await fetch(endpoint, {method:'POST',body:JSON.stringify({method,params})});
        const data = await response.json();
        frame.contentWindow.postMessage({hookedin:true,id,...(data.error ? {error:data.error} : {result:data.result})}, location.origin);
        if(data.balance) push(data);
      } catch (error) { frame.contentWindow.postMessage({hookedin:true,id,error:{code:'failed',message:error.message}},location.origin); }
    });
    setInterval(async () => { try { const data=await (await fetch(endpoint)).json(); if(data.balance) push(data); } catch {} }, 500);
  `;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const json = (value: unknown, status = 200) =>
      res
        .writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify(value));
    try {
      if (url.pathname === '/') {
        const fixture = await gameWallet(),
          id = randomBytes(8).toString('hex');
        const name =
          ['nova', 'orbit', 'comet', 'luna', 'cosmo'][pilots.size % 5]! + (pilots.size >= 5 ? pilots.size : '');
        fixture.wallet.openGame(fixture.identity());
        fixture.wallet.alias = name;
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
            `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Afterburn · Local preview</title><style>body{margin:0;background:#101219}header{height:30px;display:flex;align-items:center;justify-content:center;gap:16px;background:#282c27;color:#c6d6ba;font:10px system-ui}a{color:#c6f9a7}iframe{display:block;width:100%;height:calc(100dvh - 30px);border:0}</style></head><body><header>LOCAL PREVIEW · SIMULATED FUNDS <a href="/" target="_blank" rel="noopener">Join as another pilot ↗</a></header><iframe title="Afterburn" sandbox="allow-scripts allow-same-origin" src="/game/"></iframe><script src="/preview.js"></script></body></html>`,
          );
      }
      if (url.pathname === '/preview.js')
        return void res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(hostScript);
      if (url.pathname.startsWith('/bridge/')) {
        const pilot = pilots.get(url.pathname.slice(8));
        if (!pilot)
          return void json(
            { error: { code: 'missing', message: 'This preview session ended. Reload the preview.' } },
            404,
          );
        const invoke = async () => {
          await pilot.fixture.wallet.collectPayouts();
          let result: unknown;
          if (req.method === 'POST') {
            let text = '';
            for await (const chunk of req) text += chunk;
            const { method, params } = JSON.parse(text);
            result = await pilot.fixture.bridge.call(method, params);
            if (method === 'wallet.hello') result = { ...(result as object), asset: { symbol: 'DEMO', decimals: 4 } };
            if (method === 'wallet.info') result = { ...(result as object), recommendedStake: '10000' };
          }
          return { result, balance: await pilot.fixture.bridge.balance(), receipts: pilot.events.splice(0) };
        };
        const pending = pilot.queue.then(invoke);
        pilot.queue = pending.catch(() => {});
        try {
          return void json(await pending);
        } catch (error: any) {
          return void json({ error: { code: error.code ?? 'failed', message: error.message } }, 400);
        }
      }
      if (url.pathname.startsWith('/game/api/')) {
        const route = url.pathname.slice('/game/api'.length);
        if (route === '/flight') {
          const view = await room.view();
          void room.sync().catch(console.error);
          return void json(view);
        }
        if (route === '/placed' && req.method === 'POST') {
          await room.sync(true);
          return void json(await room.view());
        }
        if (route === '/cashout' && req.method === 'POST') {
          let text = '';
          for await (const chunk of req) text += chunk;
          const body = JSON.parse(text),
            result = await room.cashout(body.flight, body.bet, body.token);
          void room.sync(true).catch(console.error);
          return void json(result);
        }
        if (route.startsWith('/flights/')) {
          const proof = await room.kept(route.slice(9));
          return void json(proof ?? { error: 'Flight not revealed.' }, proof ? 200 : 404);
        }
      }
      if (url.pathname.startsWith('/game/')) {
        const name = decodeURIComponent(url.pathname.slice(6)) || 'index.html';
        if (name.split('/').some(part => part.startsWith('.')) || name.includes('\\')) throw new Error('Not found');
        const types: Record<string, string> = {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.svg': 'image/svg+xml',
          '.json': 'application/json',
        };
        const type = types[path.extname(name)];
        if (!type) throw new Error('Not found');
        const data = await fs.readFile(path.join(root, 'dist', name));
        return void res
          .writeHead(200, {
            'Content-Type': type,
            'Cache-Control': 'no-store',
            'Content-Security-Policy':
              "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'",
          })
          .end(data);
      }
      res.writeHead(404).end();
    } catch (error: any) {
      json({ error: error.message }, error.status ?? 500);
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
      await room.view();
      await room.sync(true);
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
  console.log(
    `Afterburn local preview: ${local.url}\nSimulated funds only. Open the link in another tab to add a player.`,
  );
  const stop = () => {
    void local.close().then(() => process.exit());
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
