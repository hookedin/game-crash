import { createDeveloper } from '@hookedin/play/sdk/developer';
import { Room, GameError } from './room.ts';
import type { RoomState } from './room.ts';
import type { FlightProof } from '../src/rules.ts';

interface Env {
  ASSETS: Fetcher;
  FLIGHTS: DurableObjectNamespace;
  CASINO_URL: string;
  GAME_NAME: string;
  DEVELOPER_KEY: string;
}
const assetOf = (url: URL) => (url.searchParams.get('asset') === 'test' ? 'test' : 'eth');
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

/** One durable room per asset, shared by every player and driven by alarms even when every page disconnects. */
export class CrashRoom implements DurableObject {
  private room: Promise<Room> | null = null;
  readonly ctx: DurableObjectState;
  readonly env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  private open(asset: 'eth' | 'test') {
    return (this.room ??= (async () => {
      await this.ctx.storage.put('asset', asset);
      return new Room(
        {
          developer: await createDeveloper({
            casinoURL: this.env.CASINO_URL,
            key: this.env.DEVELOPER_KEY,
            name: this.env.GAME_NAME,
          }),
          asset,
          now: () => Date.now(),
          secret: () =>
            '0x' +
            Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join(''),
          save: state => this.ctx.storage.put('state', state),
          keep: proof => this.ctx.storage.put(`flight:${proof.id}`, proof),
          kept: id => this.ctx.storage.get<FlightProof>(`flight:${id}`),
          wake: at => this.ctx.storage.setAlarm(at),
        },
        await this.ctx.storage.get<RoomState>('state'),
      );
    })().catch(error => {
      this.room = null;
      throw error;
    }));
  }

  private sync(room: Room, force = false) {
    this.ctx.waitUntil(room.sync(force).catch(error => console.error('Flight settlement:', error.message)));
  }

  async fetch(request: Request) {
    try {
      const url = new URL(request.url),
        room = await this.open(assetOf(url));
      if (url.pathname === '/api/flight' && request.method === 'GET') {
        const flight = await room.view();
        this.sync(room);
        return json(flight);
      }
      if (url.pathname === '/api/placed' && request.method === 'POST') {
        await room.sync(true);
        return json(await room.view());
      }
      if (url.pathname === '/api/cashout' && request.method === 'POST') {
        const text = await request.text();
        if (text.length > 1024) throw new GameError('Request too large.', 413);
        let body: any;
        try {
          body = JSON.parse(text);
        } catch {
          throw new GameError('Invalid JSON.', 400);
        }
        if (!body || typeof body.flight !== 'string' || typeof body.bet !== 'string' || typeof body.token !== 'string')
          throw new GameError('Name the flight, bet and escape key.', 400);
        const ticket = await room.cashout(body.flight, body.bet, body.token);
        this.sync(room, true);
        return json(ticket);
      }
      const match = /^\/api\/flights\/([0-9a-f]{64})$/.exec(url.pathname);
      if (match && request.method === 'GET') {
        const proof = await room.kept(match[1]!);
        return proof ? json(proof) : json({ error: 'The flight has not revealed its secret.' }, 404);
      }
      return json({ error: 'Not found.' }, 404);
    } catch (error: any) {
      return json(
        { error: error.message || 'The flight room is unavailable.' },
        error instanceof GameError ? error.status : 503,
      );
    }
  }

  /** The room sets its alarm while a flight is under way, and lets it lapse once everything is paid. */
  async alarm() {
    let room: Room | undefined;
    try {
      room = await (this.room ?? this.open((await this.ctx.storage.get<'eth' | 'test'>('asset')) ?? 'eth'));
      await room.view();
      await room.sync(true);
    } catch (error: any) {
      console.error('Flight alarm:', error.message);
      // A room that cannot start, or that has a flight under way, tries again shortly.
      if (!room || room.underWay()) await this.ctx.storage.setAlarm(Date.now() + 1_000);
    }
  }
}

export default {
  fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    return env.FLIGHTS.get(env.FLIGHTS.idFromName(assetOf(url))).fetch(request);
  },
};
