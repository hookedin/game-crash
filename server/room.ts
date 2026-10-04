import { keccak256 } from 'ethers';
import type { Developer } from '@hookedin/play/sdk/developer';
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
  startsAt: number;
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
  now(): number;
  secret(): string;
  save(state: RoomState): Promise<void>;
  keep(proof: FlightProof): Promise<void>;
  kept(id: string): Promise<FlightProof | undefined>;
  /** Ask for `tick()` at this time. */
  wake(at: number): Promise<void>;
  /** Shows every watching page the room as it stands. */
  show(view: FlightView): void;
  /** Whether any page is watching. */
  watched(): boolean;
}
/** How often a watched room shows itself when nothing changes, so that its pages know they still hear it. */
export const HEARTBEAT_MS = 3_000;
/** How long the casino holds a read of new bets until one is placed, in seconds. */
const WAIT_S = 25;
/** How soon a casino request that failed is tried again. */
const RETRY_MS = 1_000;

export class GameError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

const publicTicket = ({ escapeHash: _, ...ticket }: Ticket): PublicTicket => ticket;
/** Somebody aboard, or payments still owed: the room has work of its own to do. */
const underWay = ({ flight, outbox }: RoomState) => Boolean(flight?.tickets.length) || outbox.length > 0;
const payment = (ticket: Ticket): Payment => ({
  bet: ticket.bet,
  player: ticket.payout!,
  casino: String(casinoShare(ticket.stake)),
});
/** Every payout decided and not yet paid, and every stake to give back. */
const owed = ({ flight, outbox }: RoomState) => [
  ...flight!.tickets.filter(t => t.payout !== null && !t.paid).map(payment),
  ...outbox,
];

/** The actor orders decisions and durable writes. Casino requests run outside that queue so a slow payout cannot
 * hold up a player's escape. An accepted escape is saved before it is acknowledged or sent for settlement. */
export class Room {
  private state: RoomState;
  private queue: Promise<unknown> = Promise.resolve();
  /** Where the room has read the casino's bets up to. A room starts from the oldest open bet and passes over those it
   * took already, by their hash. */
  private cursor = '';
  private following = false;
  private paying: Promise<void> | null = null;
  /** When the room last showed itself to its pages. */
  private shownAt = -Infinity;
  readonly deps: RoomDeps;

  constructor(deps: RoomDeps, saved?: RoomState) {
    this.deps = deps;
    this.state = structuredClone(saved ?? { flight: null, history: [], outbox: [] });
  }

  /** One decision at a time, on a copy saved before it is kept or answered. A change is shown to every watching page
   * (`show` shows the room either way), and the room asks to be woken for what comes next. */
  private edit<T>(work: (draft: RoomState, now: number) => T | Promise<T>, show = false): Promise<T> {
    const next = this.queue.then(async () => {
      const draft = structuredClone(this.state),
        now = this.deps.now();
      await this.advance(draft, now);
      const result = await work(draft, now);
      const changed = JSON.stringify(draft) !== JSON.stringify(this.state);
      if (changed) await this.deps.save(draft);
      this.state = draft;
      if (changed || show) {
        this.deps.show(this.viewOf(draft, now));
        this.shownAt = now;
      }
      const at = this.nextWake(now);
      if (at !== null) await this.deps.wake(at);
      return result;
    });
    this.queue = next.catch(() => {});
    return next;
  }

  /** When the room next needs waking, or null if it does not. While a page watches or somebody is aboard or owed: at
   * the flight's next change by the clock (take-off, an auto escape, the crash or the next flight), and shortly while a
   * payment is owed or the next flight waits for one. While a page watches, a heartbeat after the room last showed
   * itself. */
  private nextWake(now: number) {
    const watched = this.deps.watched();
    if (!watched && !underWay(this.state)) return null;
    const flight = this.state.flight!,
      point = crashPoint(flight.secret),
      end = flight.startsAt + timeTo(point);
    let at =
      flight.phase === 'boarding'
        ? flight.startsAt
        : flight.phase === 'flying'
          ? Math.min(
              end,
              ...flight.tickets
                .filter(t => t.status === 'aboard' && t.auto !== null && (t.auto < point || point === MAX_MULTIPLIER))
                .map(t => flight.startsAt + timeTo(t.auto!)),
            )
          : end + COOLDOWN_MS;
    if (at <= now) at = now + RETRY_MS;
    if (owed(this.state).length) at = Math.min(at, now + RETRY_MS);
    return watched ? Math.min(at, Math.max(this.shownAt + HEARTBEAT_MS, now)) : at;
  }

  /** A flight boards for `BOARDING_MS` and takes off, whether or not anybody boards it. */
  private newFlight(now: number): Flight {
    const secret = this.deps.secret();
    return { id: commitment(secret), secret, phase: 'boarding', startsAt: now + BOARDING_MS, tickets: [] };
  }

  private proof(flight: Flight): FlightProof {
    return {
      id: flight.id,
      secret: flight.secret,
      point: crashPoint(flight.secret),
      startsAt: flight.startsAt,
      tickets: flight.tickets.map(publicTicket),
    };
  }

  private escape(ticket: Ticket, multiplier: number) {
    ticket.status = 'escaped';
    ticket.multiplier = multiplier;
    ticket.payout = String(payoutAt(ticket.stake, multiplier));
  }

  /** Flights fly on the clock. Nothing wakes the room for one nobody boarded: whoever looks next finds it where the
   * clock has it, or the next one boarding. */
  private async advance(draft: RoomState, now: number) {
    const flight = (draft.flight ??= this.newFlight(now));
    if (now < flight.startsAt) return;
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
    // Keep the result visible, and finish every payment before accepting bets on another flight. A flight with a
    // crew is kept for its players to check; any flight can be checked from the history, which carries its secret.
    if (
      flight.phase === 'ended' &&
      now >= end + COOLDOWN_MS &&
      flight.tickets.every(t => t.paid) &&
      !draft.outbox.length
    ) {
      if (flight.tickets.length) await this.deps.keep(this.proof(flight));
      draft.history = [{ id: flight.id, point, secret: flight.secret }, ...draft.history].slice(0, 12);
      draft.flight = this.newFlight(now);
    }
  }

  /** Whether somebody is aboard or a payment is still owed. Otherwise only a watching page needs the room awake: the
   * next page to open it finds it where the clock has it. */
  underWay() {
    return underWay(this.state);
  }

  /** The room as a page shows it. */
  private viewOf(state: RoomState, now: number): FlightView {
    const flight = state.flight!,
      ended = flight.phase === 'ended';
    return {
      id: flight.id,
      phase: flight.phase,
      startsAt: flight.startsAt,
      now,
      multiplier: ended
        ? crashPoint(flight.secret)
        : flight.phase === 'flying'
          ? multiplierAt(now - flight.startsAt)
          : 100,
      point: ended ? crashPoint(flight.secret) : null,
      secret: ended ? flight.secret : null,
      tickets: flight.tickets.map(publicTicket),
      history: ended
        ? [{ id: flight.id, point: crashPoint(flight.secret), secret: flight.secret }, ...state.history].slice(0, 12)
        : state.history,
    };
  }

  view(): Promise<FlightView> {
    return this.edit((draft, now) => this.viewOf(draft, now));
  }

  /** The room's wake: it comes up to the clock, shows itself to every watching page and pays what it owes. */
  async tick() {
    await this.edit(() => {}, true);
    this.payLater();
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
      this.escape(ticket, multiplierAt(now - flight.startsAt));
      return publicTicket(ticket);
    });
  }

  /** While a page watches, the room follows the casino's bets: the casino holds each read until a bet on the game is
   * placed, so each is seated, or given its stake back, as it comes. */
  async follow() {
    if (this.following) return;
    this.following = true;
    try {
      while (this.deps.watched()) {
        const asked = Date.now();
        try {
          // An empty page long before the wait is up means another server took the game's wait: both back off,
          // rather than answer each other's waits as fast as the network goes.
          if ((await this.read(WAIT_S)) || Date.now() - asked > (WAIT_S * 1000) / 2) continue;
        } catch (error: any) {
          console.error('Flight bets:', error.message);
          // Again from the oldest open bet: the casino may have been away, or restored its records.
          this.cursor = '';
        }
        await new Promise(resolve => setTimeout(resolve, RETRY_MS));
      }
    } finally {
      this.following = false;
    }
  }

  /** The bets placed since the room last read, a page of them, waiting up to `wait` seconds for one: each is seated or
   * given its stake back, and then paid what is owed. The cursor moves on once the page is saved. Resolves with how
   * many bets it read. */
  async read(wait = 0) {
    const page = await this.deps.developer.bets({ after: this.cursor, wait });
    await this.edit(async draft => {
      const flight = draft.flight!;
      for (const bet of page.bets) {
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
        )
          flight.tickets.push({
            bet: bet.bet,
            uname: bet.uname,
            discordUsername: bet.discordUsername,
            stake: bet.stake,
            ...offered,
            status: 'aboard',
            multiplier: null,
            payout: null,
            paid: false,
          });
        else {
          // A stored flight fixes what a retry is paid. Bets outside its accepted crew get their stakes back.
          const proof = bet.group ? await this.deps.kept(bet.group) : undefined,
            known = proof?.tickets.find(t => t.bet === bet.bet);
          draft.outbox.push({
            bet: bet.bet,
            player: known?.payout ?? bet.stake,
            casino: known ? String(casinoShare(bet.stake)) : '0',
          });
        }
      }
    });
    this.cursor = page.cursor;
    this.payLater();
    return page.bets.length;
  }

  /** Pays what is owed without waiting for it: one that fails is tried again when the room next wakes. */
  private payLater() {
    this.pay().catch((error: Error) => console.error('Flight settlement:', error.message));
  }

  /** Settles every payout and stake owed, outside the queue, one settlement at a time: what comes to be owed meanwhile
   * is settled after it. One that fails is tried again when the room next wakes. */
  pay(): Promise<void> {
    return (this.paying ??= (async () => {
      try {
        for (let payments = await this.edit(owed); payments.length; payments = await this.edit(owed)) {
          const settled = await this.deps.developer.settle(payments);
          await this.edit(draft => {
            for (const requested of payments) {
              const result = settled.find(r => r.bet === requested.bet);
              if (
                result?.status !== 'settled' ||
                result.settlement?.player !== requested.player ||
                result.settlement.casino !== requested.casino
              )
                throw new Error('The casino returned a different settlement.');
              const ticket = draft.flight!.tickets.find(t => t.bet === requested.bet);
              if (ticket) ticket.paid = true;
              draft.outbox = draft.outbox.filter(p => p.bet !== requested.bet);
            }
          });
        }
      } finally {
        this.paying = null;
      }
    })());
  }
}
