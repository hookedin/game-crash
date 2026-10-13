import { keccak256 } from 'ethers';
import type { PublicDeveloperBet } from '@hookedin/play/sdk/developer';
import { Room } from '../server/room.ts';
import type { RoomDeps, RoomState } from '../server/room.ts';
import { hashed } from '../src/rules.ts';
import type { Chain, FlightProof, FlightView } from '../src/rules.ts';

export const TOKEN = '0x' + 'a'.repeat(64);
/** The server key of the tests and the local preview, and its chain: the end `npm run chain` prints for it, with a salt
 * and a block that only stand in for an Ethereum block's. */
export const KEY = '0x' + '1'.repeat(64);
export const CHAIN: Chain = {
  end: '0x0eefc6aacb5f0146a005332b371b93f0e02df6f31dc1640b4da1c70cc7aa97ae',
  salt: '0x' + 'c'.repeat(64),
  block: 1,
};
/** Flight 1024's secret on KEY's chain: the room's tests take the flights below it from it, without computing the
 * chain. */
const FLIGHT_1024 = '0x66514be5a1522e430cbbfd6bc39b839b1ffd6c8ef6614a70a74cbb02e4310b71';
export const secretOf = (number: number) => hashed(FLIGHT_1024, 1024 - number);
/** Flight 1's secret. */
export const SECRET = secretOf(1);

export function fixture(salt = CHAIN.salt) {
  let now = 1_000_000,
    saved: RoomState | undefined;
  let loseReply = false,
    // The game's bank: enough for every seat the tests take, unless a test says otherwise.
    bank = 10n ** 30n,
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
    chain: { ...CHAIN, salt },
    secret: secretOf,
    now: () => now,
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
      bank: async () => bank,
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
        // As the casino does: a bet that rides on a round is settled only with the secret that hashes to it.
        for (const p of payments) {
          const { round } = bets.get(p.bet)!;
          if (round ? !p.secret || keccak256(p.secret) !== round : p.secret !== undefined)
            throw new Error("A settlement brings the secret of its bet's round");
        }
        const results = payments.map(p => {
          const bet = bets.get(p.bet)!;
          if (bet.status === 'open') {
            bet.status = 'settled';
            bet.settlement = {
              player: p.player,
              casino: p.casino,
              ...(p.secret ? { secret: p.secret } : {}),
              signature: 'signature',
            };
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
    /** The game's bank holds `value`. */
    fund: (value: bigint) => {
      bank = value;
    },
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
      const view = await room.view(),
        group = 'group' in overrides ? overrides.group : view.id;
      const bet: PublicDeveloperBet = {
        bet: '0x' + (bets.size + 1).toString(16).padStart(64, '0'),
        game: 'game',
        group: view.id,
        ...(group ? { round: '0x' + group } : {}),
        uname: `pilot-${bets.size + 1}`,
        discordUsername: null,
        stake: 10000n,
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
