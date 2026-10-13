import { concat, id, keccak256 } from 'ethers';
import { CHAIN_LENGTH, hashed, isSecret } from '../src/rules.ts';

/** How far apart the room keeps the chain's secrets: every flight's is at most this many hashes below one. */
const STRIDE = 1024;

/** The top of a server key's chain, flight 2^20's secret: keccak256(abi.encode(keccak256("HOOKEDIN/CRASH/CHAIN"), key)).
 * Each secret below is the hash of the one above it, down to the chain's end. */
export function seedOf(key: string) {
  if (!isSecret(key)) throw new Error('SERVER_KEY is not 32 bytes of lowercase hex.');
  return keccak256(concat([id('HOOKEDIN/CRASH/CHAIN'), key]));
}

/** Every 1024th secret of the chain, from its end, secret 0, up to its seed: the chain's 2^20 hashes, computed once. */
export function checkpoints(seed: string) {
  const kept = [seed];
  while (kept.length <= CHAIN_LENGTH / STRIDE) kept.push(hashed(kept.at(-1)!, STRIDE));
  return kept.reverse();
}

/** Flight `number`'s secret: the checkpoint at or above it, hashed down. */
export function secretAt(kept: string[], number: number) {
  if (!Number.isSafeInteger(number) || number < 1 || number > CHAIN_LENGTH)
    throw new Error(`The chain has no flight ${number}: start a new chain.`);
  const above = Math.ceil(number / STRIDE);
  return hashed(kept[above]!, above * STRIDE - number);
}
