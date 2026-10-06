import { createDeveloper } from '@hookedin/play/sdk/developer';
import { Room, GameError } from './room.ts';
import type { RoomState } from './room.ts';
import type { FlightProof, FlightView } from '../src/rules.ts';

interface Env {
  ASSETS: Fetcher;
  FLIGHTS: DurableObjectNamespace;
  CASINO_URL: string;
  /** The game's ID, which the wallet's Developer page shows beside the game. */
  GAME: string;
  /** The private key of the game's server, which its developer names on the Developer page. A secret. */
  SERVER_KEY: string;
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const encoder = new TextEncoder();
/** How many events a page may fall behind by before it is dropped; it connects again. */
const MAX_BEHIND = 16;

/** One durable room, shared by every player. Its flights fly on the clock, and while somebody is aboard or owed, alarms
 * drive it even when every page disconnects. Every page watching hears each change of the room as it happens. */
export class CrashRoom implements DurableObject {
  private room: Promise<Room> | null = null;
  /** Every page watching: the stream of server-sent events it reads. */
  private readonly pages = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  readonly ctx: DurableObjectState;
  readonly env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  private open() {
    return (this.room ??= (async () =>
      new Room(
        {
          developer: await createDeveloper({
            casinoURL: this.env.CASINO_URL,
            key: this.env.SERVER_KEY,
            game: this.env.GAME,
          }),
          now: () => Date.now(),
          secret: () =>
            '0x' +
            Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join(''),
          save: state => this.ctx.storage.put('state', state),
          keep: proof => this.ctx.storage.put(`flight:${proof.id}`, proof),
          kept: id => this.ctx.storage.get<FlightProof>(`flight:${id}`),
          wake: at => this.ctx.storage.setAlarm(at),
          show: view => this.send(view, this.pages),
          watched: () => this.pages.size > 0,
        },
        await this.ctx.storage.get<RoomState>('state'),
      ))().catch(error => {
      this.room = null;
      throw error;
    }));
  }

  /** The room as an event to `pages`. A page that has fallen too far behind, or gone, is dropped. */
  private send(view: FlightView, pages: Iterable<WritableStreamDefaultWriter<Uint8Array>>) {
    const event = encoder.encode(`data: ${JSON.stringify(view)}\n\n`);
    for (const page of pages) {
      if (page.desiredSize === null || page.desiredSize < -MAX_BEHIND) {
        this.pages.delete(page);
        page.abort().catch(() => {});
      } else page.write(event).catch(() => this.pages.delete(page));
    }
  }

  /** A page watches the room: the room as it stands, then every change, and the room follows the casino's bets. */
  private async watch(room: Room) {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>(),
      page = writable.getWriter();
    page.closed.catch(() => {}).finally(() => this.pages.delete(page));
    void page.write(encoder.encode('retry: 1000\n\n')).catch(() => {});
    this.pages.add(page);
    try {
      this.send(await room.view(), [page]);
    } catch (error) {
      this.pages.delete(page);
      throw error;
    }
    void room.follow();
    return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
  }

  async fetch(request: Request) {
    try {
      const url = new URL(request.url),
        room = await this.open();
      if (url.pathname === '/api/live' && request.method === 'GET') return await this.watch(room);
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
        this.ctx.waitUntil(room.pay().catch(error => console.error('Flight settlement:', error.message)));
        return json(ticket);
      }
      const match = /^\/api\/flights\/([0-9a-f]{64})$/.exec(url.pathname);
      if (match && request.method === 'GET') {
        const proof = await room.kept(match[1]!);
        return proof ? json(proof) : json({ error: 'This flight is not over, or had nobody aboard.' }, 404);
      }
      return json({ error: 'Not found.' }, 404);
    } catch (error: any) {
      return json(
        { error: error.message || 'The flight room is unavailable.' },
        error instanceof GameError ? error.status : 503,
      );
    }
  }

  /** The room asks for its alarm while a page watches or somebody is aboard or owed, and lets it lapse once nobody
   * is. A wake that fails tries again shortly. */
  async alarm() {
    let room: Room | undefined;
    try {
      room = await this.open();
      if (this.pages.size) void room.follow();
      await room.tick();
    } catch (error: any) {
      console.error('Flight alarm:', error.message);
      // A room that cannot start, or that has work, tries again shortly.
      if (!room || room.underWay() || this.pages.size) await this.ctx.storage.setAlarm(Date.now() + 1_000);
    }
  }
}

export default {
  fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    return env.FLIGHTS.get(env.FLIGHTS.idFromName('room')).fetch(request);
  },
};
