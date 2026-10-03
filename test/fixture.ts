import { keccak256 } from 'ethers';
import type { PublicDeveloperBet } from '@hookedin/play/sdk/developer';
import { Room } from '../server/room.ts';
import type { RoomDeps, RoomState } from '../server/room.ts';
import type { FlightProof, FlightView } from '../src/rules.ts';

export const TOKEN = '0x' + 'a'.repeat(64);
export const SECRET = '0x' + 'c'.repeat(64);

export function fixture(secret = SECRET) {
  let now = 1_000_000,
    saved: RoomState | undefined,
    serial = 0;
  let loseReply = false,
    failSave = false,
    failRead = false,
    watching = false;
  let pause: Promise<void> | null = null,
    placed = () => {};
  const bets = new Map<string, PublicDeveloperBet>(),
    proofs = new Map<string, FlightProof>(),
    // Where each bet is in the order the casino took them.
    order = new Map<string, number>();
  const settled: string[] = [],
    writes: RoomState[] = [],
    wakes: number[] = [],
    shown: FlightView[] = [],
    reads: { after: string; wait: number }[] = [];
  const deps: RoomDeps = {
    now: () => now,
    secret: () => (serial++ ? '0x' + serial.toString(16).padStart(64, '0') : secret),
    save: async state => {
      if (failSave) throw new Error('Storage unavailable');
      saved = structuredClone(state);
      writes.push(saved);
    },
    keep: async proof => {
      proofs.set(proof.id, structuredClone(proof));
    },
    kept: async id => proofs.get(id),
    wake: async at => {
      wakes.push(at);
    },
    show: view => void shown.push(view),
    watched: () => watching,
    developer: {
      // Open bets in the order they were placed, after the cursor; with `wait`, a read with none waits for the next.
      async bets({ after = '', wait = 0 } = {}) {
        reads.push({ after, wait });
        if (failRead) {
          failRead = false;
          throw new Error('Casino unavailable');
        }
        const page = () => {
          const open = [...bets.values()].filter(b => b.status === 'open' && order.get(b.bet)! > Number(after || '0'));
          return { bets: open, cursor: String(order.get(open.at(-1)?.bet ?? '') ?? (after || '0')), more: false };
        };
        if (wait && !page().bets.length) await new Promise<void>(resolve => (placed = resolve));
        return page();
      },
      settle: async payments => {
        if (pause) await pause;
        const results = payments.map(p => {
          const bet = bets.get(p.bet)!;
          if (bet.status === 'open') {
            bet.status = 'settled';
            bet.settlement = { player: String(p.player), casino: String(p.casino), signature: 'signature' };
            settled.push(bet.bet);
          }
          return structuredClone(bet);
        });
        if (loseReply) throw new Error('Settlement reply lost');
        return results;
      },
    },
  };
  let room = new Room(deps);
  return {
    deps,
    bets,
    settled,
    writes,
    wakes,
    shown,
    reads,
    /** Whether a page watches the room. One that stops watching ends a read the room is waiting on. */
    watch: (value: boolean) => {
      watching = value;
      if (!value) placed();
    },
    /** The casino answers the read the room is waiting on, with no bet: another wait on the game began. */
    answer: () => placed(),
    /** The casino fails the room's next read. */
    failNextRead: () => {
      failRead = true;
    },
    get room() {
      return room;
    },
    get saved() {
      return structuredClone(saved!);
    },
    now: () => now,
    at: (value: number) => {
      now = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    loseReply: (value: boolean) => {
      loseReply = value;
    },
    failSave: (value: boolean) => {
      failSave = value;
    },
    pauseSettlement: (value: Promise<void> | null) => {
      pause = value;
    },
    restart: () => {
      room = new Room(deps, saved);
    },
    async bet(overrides: Partial<PublicDeveloperBet> = {}) {
      const view = await room.view();
      const bet: PublicDeveloperBet = {
        bet: '0x' + (bets.size + 1).toString(16).padStart(64, '0'),
        game: 'game',
        group: view.id,
        uname: `pilot-${bets.size + 1}`,
        alias: null,
        developer: 'developer',
        stake: '10000',
        placedAt: now,
        status: 'open',
        meta: { escapeHash: keccak256(TOKEN), auto: null },
        ...overrides,
      };
      bets.set(bet.bet, bet);
      order.set(bet.bet, order.size + 1);
      placed();
      return bet;
    },
  };
}
