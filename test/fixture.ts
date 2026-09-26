import { keccak256 } from 'ethers';
import type { PublicDeveloperBet } from '@hookedin/play/sdk/developer';
import { Room } from '../server/room.ts';
import type { RoomDeps, RoomState } from '../server/room.ts';
import type { FlightProof } from '../src/rules.ts';

export const TOKEN = '0x' + 'a'.repeat(64);
export const SECRET = '0x' + 'c'.repeat(64);

export function fixture(secret = SECRET) {
  let now = 1_000_000,
    saved: RoomState | undefined,
    serial = 0;
  let loseReply = false,
    failSave = false;
  let pause: Promise<void> | null = null;
  const bets = new Map<string, PublicDeveloperBet>(),
    proofs = new Map<string, FlightProof>();
  const settled: string[] = [],
    writes: RoomState[] = [];
  const deps: RoomDeps = {
    asset: 'test',
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
    wake: async () => {},
    developer: {
      bets: async () => ({ bets: [...bets.values()].filter(b => b.status === 'open'), cursor: '', more: false }),
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
        asset: 'test',
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
      return bet;
    },
  };
}
