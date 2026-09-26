import { keccak256 } from 'ethers';

export const BOARDING_MS = 8_000;
export const COOLDOWN_MS = 5_000;
export const RISE_MS = 6_500;
export const MAX_MULTIPLIER = 10_000;
export const MAX_CREW = 64;
const SPACE = 1n << 64n;

export const isSecret = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);

/** The flight ID commits to the secret. The secret itself supplies the sample, so the ID reveals no crash point. */
export function commitment(secret: string) {
  if (!isSecret(secret)) throw new Error('Expected 32 bytes');
  return keccak256(secret).slice(2);
}

/** Hundredths of a multiplier, drawn from a uniform 64-bit sample. At 100× the flight ends in a forced escape. */
export function crashPoint(secret: string): number {
  if (!isSecret(secret)) throw new Error('Expected 32 bytes');
  const sample = BigInt(secret.slice(0, 18));
  const point = (99n * SPACE) / (SPACE - sample);
  return Number(point < 100n ? 100n : point > BigInt(MAX_MULTIPLIER) ? BigInt(MAX_MULTIPLIER) : point);
}

export function timeTo(multiplier: number) {
  return Math.ceil(Math.log(multiplier / 100) * RISE_MS);
}

export function multiplierAt(elapsed: number) {
  return Math.min(MAX_MULTIPLIER, Math.max(100, Math.floor(100 * Math.exp(Math.max(0, elapsed) / RISE_MS))));
}

export const multiplierText = (multiplier: number) => `${(multiplier / 100).toFixed(2)}×`;
export const payoutAt = (stake: string, multiplier: number) => (BigInt(stake) * BigInt(multiplier)) / 100n;
export const casinoShare = (stake: string) => BigInt(stake) / 200n;

export interface TicketTerms {
  escapeHash: string;
  auto: number | null;
}

export function terms(meta: Record<string, unknown>): TicketTerms | null {
  if (!isSecret(meta.escapeHash)) return null;
  if (
    meta.auto !== null &&
    (!Number.isSafeInteger(meta.auto) || Number(meta.auto) < 101 || Number(meta.auto) > MAX_MULTIPLIER)
  )
    return null;
  return { escapeHash: meta.escapeHash, auto: meta.auto as number | null };
}

export type TicketStatus = 'aboard' | 'escaped' | 'lost';

export interface PublicTicket {
  bet: string;
  uname: string;
  alias: string | null;
  stake: string;
  auto: number | null;
  status: TicketStatus;
  multiplier: number | null;
  payout: string | null;
  paid: boolean;
}

export interface FlightSummary {
  id: string;
  point: number;
}

export interface FlightView {
  id: string;
  phase: 'boarding' | 'flying' | 'ended';
  startsAt: number | null;
  now: number;
  multiplier: number;
  point: number | null;
  secret: string | null;
  tickets: PublicTicket[];
  history: FlightSummary[];
}

export interface FlightProof {
  id: string;
  secret: string;
  point: number;
  startsAt: number;
  tickets: PublicTicket[];
}

export function verifyFlight(proof: FlightProof, expectedId: string) {
  return (
    isSecret(proof.secret) &&
    proof.id === expectedId &&
    commitment(proof.secret) === expectedId &&
    crashPoint(proof.secret) === proof.point
  );
}
