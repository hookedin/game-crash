/** The ceremony's first step, in README: the end of the chain SERVER_KEY's flights fly along, for CHAIN_END. */
import { CHAIN_LENGTH, hashed } from '../src/rules.ts';
import { seedOf } from '../server/chain.ts';

console.log(hashed(seedOf(process.env.SERVER_KEY ?? ''), CHAIN_LENGTH));
