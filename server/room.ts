import { keccak256 } from 'ethers';
import type { AssetId, Developer, PublicDeveloperBet } from '@hookedin/play/sdk/developer';
import {
  BOARDING_MS,
  COOLDOWN_MS,
  MAX_CREW,
  MAX_MULTIPLIER,
  casinoShare,
  commitment,
  crashPoint,
  isSecret,
  multiplierAt,
  payoutAt,
  terms,
  timeTo,
} from '../src/rules.ts';
import type { FlightProof, FlightSummary, FlightView, PublicTicket } from '../src/rules.ts';

interface Ticket extends PublicTicket {
  escapeHash: string;
}
interface Flight {
  id: string;
  secret: string;
  phase: FlightView['phase'];
  startsAt: number | null;
  tickets: Ticket[];
}
interface Payment {
  bet: string;
  player: string;
  casino: string;
}
export interface RoomState {
  flight: Flight | null;
  history: FlightSummary[];
  outbox: Payment[];
}
export interface RoomDeps {
  developer: Pick<Developer, 'bets' | 'settle'>;
  asset: AssetId;
  now(): number;
  secret(): string;
  save(state: RoomState): Promise<void>;
  keep(proof: FlightProof): Promise<void>;
  kept(id: string): Promise<FlightProof | undefined>;
  wake(at: number): Promise<void>;
}

export class GameError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

const publicTicket = ({ escapeHash: _, ...ticket }: Ticket): PublicTicket => ticket;
/** A flight that has started boarding, or payments still owed: the room has work of its own to do. */
const underWay = ({ flight, outbox }: RoomState) => (flight !== null && flight.startsAt !== null) || outbox.length > 0;
const payment = (ticket: Ticket): Payment => ({
  bet: ticket.bet,
  player: ticket.payout!,
  casino: String(casinoShare(ticket.stake)),
});

/** The actor orders decisions and durable writes. Casino requests run outside that queue so a slow payout cannot
 * hold up a player's escape. An accepted escape is saved before it is acknowledged or sent for settlement. */
export class Room {
  private state: RoomState;
  private queue: Promise<unknown> = Promise.resolve();
  private syncing: Promise<void> | null = null;
  private lastSync = -Infinity;
  readonly deps: RoomDeps;

  constructor(deps: RoomDeps, saved?: RoomState) {
    this.deps = deps;
    this.state = structuredClone(saved ?? { flight: null, history: [], outbox: [] });
  }

  private edit<T>(work: (draft: RoomState, now: number) => T | Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const draft = structuredClone(this.state),
        now = this.deps.now();
      // While a flight is under way, the alarm is durable even if saving a decision or answering the request fails.
      if (underWay(this.state)) await this.deps.wake(now + 1_000);
      await this.advance(draft, now);
      const result = await work(draft, now);
      if (JSON.stringify(draft) !== JSON.stringify(this.state)) await this.deps.save(draft);
      // The first accepted bet starts boarding, and the alarm with it.
      if (!underWay(this.state) && underWay(draft)) await this.deps.wake(now + 1_000);
      this.state = draft;
      return result;
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private newFlight(): Flight {
    const secret = this.deps.secret();
    return { id: commitment(secret), secret, phase: 'boarding', startsAt: null, tickets: [] };
  }

  private proof(flight: Flight): FlightProof {
    return {
      id: flight.id,
      secret: flight.secret,
      point: crashPoint(flight.secret),
      startsAt: flight.startsAt!,
      tickets: flight.tickets.map(publicTicket),
    };
  }

  private escape(ticket: Ticket, multiplier: number) {
    ticket.status = 'escaped';
    ticket.multiplier = multiplier;
    ticket.payout = String(payoutAt(ticket.stake, multiplier));
  }

  private async advance(draft: RoomState, now: number) {
    const flight = (draft.flight ??= this.newFlight());
    if (flight.startsAt === null || now < flight.startsAt) return;
    const point = crashPoint(flight.secret),
      end = flight.startsAt + timeTo(point);
    flight.phase = now < end ? 'flying' : 'ended';
    for (const ticket of flight.tickets) {
      if (ticket.status !== 'aboard') continue;
      // Auto escapes are decided at their target time even if the alarm runs late or the player disconnects.
      if (
        ticket.auto !== null &&
        (ticket.auto < point || point === MAX_MULTIPLIER) &&
        now >= flight.startsAt + timeTo(ticket.auto)
      )
        this.escape(ticket, ticket.auto);
      else if (now >= end) {
        if (point === MAX_MULTIPLIER) this.escape(ticket, MAX_MULTIPLIER);
        else {
          ticket.status = 'lost';
          ticket.payout = '0';
        }
      }
    }
    // Keep the result visible, and finish every payment before accepting bets on another flight.
    if (
      flight.phase === 'ended' &&
      now >= end + COOLDOWN_MS &&
      flight.tickets.every(t => t.paid) &&
      !draft.outbox.length
    ) {
      await this.deps.keep(this.proof(flight));
      draft.history = [{ id: flight.id, point }, ...draft.history].slice(0, 12);
      draft.flight = this.newFlight();
    }
  }

  /** Whether a flight has started boarding or a payment is still owed. An idle room needs no alarm: the next page to
   * open it, or the bet a page reports, wakes it. */
  underWay() {
    return underWay(this.state);
  }

  view(): Promise<FlightView> {
    return this.edit((draft, now) => {
      const flight = draft.flight!,
        ended = flight.phase === 'ended';
      return {
        id: flight.id,
        phase: flight.phase,
        startsAt: flight.startsAt,
        now,
        multiplier: ended
          ? crashPoint(flight.secret)
          : flight.phase === 'flying'
            ? multiplierAt(now - flight.startsAt!)
            : 100,
        point: ended ? crashPoint(flight.secret) : null,
        secret: ended ? flight.secret : null,
        tickets: flight.tickets.map(publicTicket),
        history: ended
          ? [{ id: flight.id, point: crashPoint(flight.secret) }, ...draft.history].slice(0, 12)
          : draft.history,
      };
    });
  }

  async kept(id: string) {
    return this.edit(async draft => {
      if (draft.flight!.id === id) return draft.flight!.phase === 'ended' ? this.proof(draft.flight!) : undefined;
      return this.deps.kept(id);
    });
  }

  cashout(id: string, bet: string, token: string): Promise<PublicTicket> {
    return this.edit((draft, now) => {
      const flight = draft.flight!,
        ticket = flight.id === id && flight.tickets.find(t => t.bet === bet);
      if (!ticket || !isSecret(token) || keccak256(token) !== ticket.escapeHash)
        throw new GameError('This escape key does not belong to that bet.', 403);
      // Retrying a saved escape returns the same decision, including when its first reply was lost.
      if (ticket.status === 'escaped') return publicTicket(ticket);
      if (flight.phase === 'boarding') throw new GameError('Wait for take-off.');
      if (ticket.status !== 'aboard' || flight.phase !== 'flying') throw new GameError('The flight has crashed.');
      this.escape(ticket, multiplierAt(now - flight.startsAt!));
      return publicTicket(ticket);
    });
  }

  /** Refresh from the casino at most once per second. Calls during a refresh share it; cash-outs never wait for it. */
  sync(force = false): Promise<void> {
    if (this.syncing) return this.syncing;
    if (!force && this.deps.now() - this.lastSync < 1_000) return Promise.resolve();
    this.lastSync = this.deps.now();
    this.syncing = this.refresh().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async refresh() {
    try {
      const bets: PublicDeveloperBet[] = [];
      for (let after = ''; ;) {
        const page = await this.deps.developer.bets({ status: 'open', after });
        bets.push(...page.bets.filter(bet => bet.asset === this.deps.asset));
        if (!page.more) break;
        after = page.cursor;
      }
      bets.sort((a, b) => a.placedAt - b.placedAt || a.bet.localeCompare(b.bet));
      await this.edit(async (draft, now) => {
        const flight = draft.flight!;
        for (const bet of bets) {
          if (flight.tickets.some(t => t.bet === bet.bet) || draft.outbox.some(t => t.bet === bet.bet)) continue;
          const offered = terms(bet.meta);
          if (
            bet.group === flight.id &&
            flight.phase === 'boarding' &&
            offered &&
            bet.uname &&
            /^[1-9]\d*$/.test(bet.stake) &&
            flight.tickets.length < MAX_CREW &&
            !flight.tickets.some(t => t.uname === bet.uname)
          ) {
            flight.tickets.push({
              bet: bet.bet,
              uname: bet.uname,
              alias: bet.alias,
              stake: bet.stake,
              ...offered,
              status: 'aboard',
              multiplier: null,
              payout: null,
              paid: false,
            });
            flight.startsAt ??= now + BOARDING_MS;
          } else {
            // A stored flight fixes what a retry is paid. Bets outside its accepted crew get their stakes back.
            const proof = bet.group ? await this.deps.kept(bet.group) : undefined;
            const known = proof?.tickets.find(t => t.bet === bet.bet);
            draft.outbox.push({
              bet: bet.bet,
              player: known?.payout ?? bet.stake,
              casino: known ? String(casinoShare(bet.stake)) : '0',
            });
          }
        }
      });
      const payments = await this.edit(draft => [
        ...draft.flight!.tickets.filter(t => t.payout !== null && !t.paid).map(payment),
        ...draft.outbox,
      ]);
      if (!payments.length) return;
      const settled = await this.deps.developer.settle(payments);
      await this.edit(draft => {
        for (const result of settled) {
          const requested = payments.find(p => p.bet === result.bet);
          if (
            !requested ||
            result.status !== 'settled' ||
            result.settlement?.player !== requested.player ||
            result.settlement.casino !== requested.casino
          )
            throw new Error('The casino returned a different settlement.');
          const ticket = draft.flight!.tickets.find(t => t.bet === result.bet);
          if (ticket) ticket.paid = true;
          draft.outbox = draft.outbox.filter(p => p.bet !== result.bet);
        }
      });
    } finally {
      // A failed settlement is tried again shortly.
      if (underWay(this.state)) await this.deps.wake(this.deps.now() + 1_000);
    }
  }
}
