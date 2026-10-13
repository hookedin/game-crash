import { concat, keccak256 } from 'ethers';
import { read } from '@hookedin/play/sdk/json';

export const BOARDING_MS = 8_000;
export const COOLDOWN_MS = 5_000;
const RISE_MS = 6_500;
export const MAX_MULTIPLIER = 10_000;
export const MAX_CREW = 64;
/** How many flights one chain has. */
export const CHAIN_LENGTH = 2 ** 20;
const SPACE = 1n << 64n;

export const isSecret = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);

/** The chain the flights' secrets come from, as the room publishes it. Flight i's secret, hashed i times, is the chain's
 * `end`. The end was published with the number of an Ethereum block not yet mined, `block`, whose hash is the `salt` in
 * every crash point. */
export interface Chain {
  end: string;
  salt: string;
  block: number;
}

/** `secret` hashed `times` times over. */
export function hashed(secret: string, times: number) {
  for (let i = 0; i < times; i++) secret = keccak256(secret);
  return secret;
}

/** The flight ID commits to the secret, and is the secret of the flight before it. The ID reveals no crash point. */
export function commitment(secret: string) {
  if (!isSecret(secret)) throw new Error('Expected 32 bytes');
  return keccak256(secret).slice(2);
}

/** Hundredths of a multiplier, drawn from a uniform 64-bit sample: the first 64 bits of
 * keccak256(abi.encode(secret, salt)). At 100× the flight ends in a forced escape. */
export function crashPoint(secret: string, salt: string): number {
  if (!isSecret(secret) || !isSecret(salt)) throw new Error('Expected 32 bytes');
  const sample = BigInt(keccak256(concat([secret, salt])).slice(0, 18));
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
export const payoutAt = (stake: bigint, multiplier: number) => (stake * BigInt(multiplier)) / 100n;
export const casinoShare = (stake: bigint) => stake / 200n;
/** The most a seat takes from the game's bank: its payout at its auto escape, or without one at the forced exit, and
 * the casino's share. The room seats a bet only while the bank can pay this of every seat. */
export const mostOwed = (stake: bigint, auto: number | null) =>
  payoutAt(stake, auto ?? MAX_MULTIPLIER) + casinoShare(stake);

interface TicketTerms {
  escapeHash: string;
  auto: number | null;
}

export function terms(meta: Record<string, unknown>): TicketTerms | null {
  if (Object.keys(meta).length !== 2 || !isSecret(meta.escapeHash) || !Object.hasOwn(meta, 'auto')) return null;
  if (
    meta.auto !== null &&
    (!Number.isSafeInteger(meta.auto) || Number(meta.auto) < 101 || Number(meta.auto) > MAX_MULTIPLIER)
  )
    return null;
  return { escapeHash: meta.escapeHash, auto: meta.auto as number | null };
}

type TicketStatus = 'aboard' | 'escaped' | 'lost';

export interface PublicTicket {
  bet: string;
  uname: string;
  discordUsername: string | null;
  stake: bigint;
  auto: number | null;
  status: TicketStatus;
  multiplier: number | null;
  payout: bigint | null;
  paid: boolean;
}

/** A flight in the recent history: its secret shows anyone that the ID committed to this crash point, and that the
 * chain fixed the ID of the flight after it. */
export interface FlightSummary {
  number: number;
  id: string;
  point: number;
  secret: string;
}

export interface FlightView {
  number: number;
  id: string;
  phase: 'boarding' | 'flying' | 'ended';
  startsAt: number;
  now: number;
  multiplier: number;
  point: number | null;
  secret: string | null;
  tickets: PublicTicket[];
  history: FlightSummary[];
  chain: Chain;
  /** What the game's bank can pay beyond the most the room owes from it, as the room last read the bank: a seat whose
   * most owed, less the stake it brings, is above this gets its stake back. Null until the room has read the bank. */
  cover: bigint | null;
}

/** A flight that had a crew, as the room keeps it: when it took off, and who was aboard. */
export interface FlightProof extends FlightSummary {
  startsAt: number;
  tickets: PublicTicket[];
}

/** Hundredths of a multiplier, as JSON holds them. */
export const readHundredths = read.exactly(
  (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0,
  'Hundredths',
);
export const readFlightId = read.exactly(
  (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
  'A flight',
);
const readSecret = read.exactly(isSecret, 'A secret');
/** A flight's number along its chain. */
const readNumber = read.exactly(
  (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= CHAIN_LENGTH,
  'A flight number',
);
const summary = { number: readNumber, id: readFlightId, point: readHundredths, secret: readSecret };
/** A ticket as the room's JSON holds it. */
export const readTicket = read.object<PublicTicket>({
  bet: read.hash,
  uname: read.text,
  discordUsername: read.nullable(read.text),
  stake: read.whole,
  auto: read.nullable(readHundredths),
  status: read.oneOf('aboard', 'escaped', 'lost'),
  multiplier: read.nullable(readHundredths),
  payout: read.nullable(read.whole),
  paid: read.flag,
});
/** The room as its JSON shows it. */
export const readView = read.object<FlightView>({
  number: readNumber,
  id: readFlightId,
  phase: read.oneOf('boarding', 'flying', 'ended'),
  startsAt: read.time,
  now: read.time,
  multiplier: readHundredths,
  point: read.nullable(readHundredths),
  secret: read.nullable(readSecret),
  tickets: read.list(readTicket, MAX_CREW),
  history: read.list(read.object<FlightSummary>(summary), 12),
  chain: read.object<Chain>({
    end: read.hash,
    salt: read.hash,
    block: read.exactly(
      (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1,
      'A block',
    ),
  }),
  cover: read.nullable(read.whole),
});
/** A flight the room kept, as its JSON shows it. */
export const readProof = read.object<FlightProof>({
  ...summary,
  startsAt: read.time,
  tickets: read.list(readTicket, MAX_CREW),
});

export function verifyFlight(flight: FlightSummary, expectedId: string, salt: string) {
  return (
    isSecret(flight.secret) &&
    flight.id === expectedId &&
    commitment(flight.secret) === expectedId &&
    crashPoint(flight.secret, salt) === flight.point
  );
}

/** Whether a flight's ID is the one its chain fixed: the secret of the flight before it, or for flight 1, which nothing
 * comes before, the chain's end. Undefined when the flight before it is not at hand. */
export function follows(flight: Pick<FlightSummary, 'number' | 'id'>, before: FlightSummary | undefined, end: string) {
  if (flight.number === 1) return !before && flight.id === end.slice(2);
  if (before) return before.number === flight.number - 1 && flight.id === before.secret.slice(2);
}

/** Whether a view hangs together on its chain: each revealed secret gives its flight's ID and, with the salt, its crash
 * point, and each flight follows the one before it, back to the oldest shown. */
export function verifyView(view: FlightView) {
  const { chain, history } = view,
    ended = view.phase === 'ended',
    // Newest first: the flight on show, which an ended view's history leads with, then the flights before it.
    flights = ended ? history : [view, ...history],
    shown = flights[0];
  return (
    shown?.number === view.number &&
    shown.id === view.id &&
    shown.point === view.point &&
    shown.secret === view.secret &&
    history.every(flight => verifyFlight(flight, flight.id, chain.salt)) &&
    flights.every((flight, k) => follows(flight, history[ended ? k + 1 : k], chain.end) !== false)
  );
}
