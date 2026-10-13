import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commitment,
  crashPoint,
  hashed,
  MAX_MULTIPLIER,
  payoutAt,
  terms,
  timeTo,
  multiplierAt,
  verifyFlight,
} from '../src/rules.ts';
import { CHAIN, SECRET } from './fixture.ts';

test('crash points mix the salt into the secret: 1.00× one flight in 50, 100× one in 100, half below 1.98×', () => {
  // `cast keccak $(cast abi-encode 'f(bytes32,bytes32)' $SECRET $SALT)` begins with u, 0xa8aec90df8d33741: 2.90×.
  assert.equal(crashPoint(SECRET, CHAIN.salt), Number((99n << 64n) / ((1n << 64n) - 0xa8aec90df8d33741n)));
  assert.equal(crashPoint(SECRET, CHAIN.salt), 290);
  assert.notEqual(crashPoint(SECRET, '0x' + 'd'.repeat(64)), crashPoint(SECRET, CHAIN.salt));
  const points: number[] = [];
  for (let secret = SECRET; points.length < 20_000; secret = hashed(secret, 1))
    points.push(crashPoint(secret, CHAIN.salt));
  const share = (test: (point: number) => boolean) => points.filter(test).length / points.length;
  assert.ok(points.every(point => Number.isSafeInteger(point) && point >= 100 && point <= MAX_MULTIPLIER));
  assert.ok(Math.abs(share(point => point === 100) - 2 / 101) < 0.004);
  assert.ok(Math.abs(share(point => point === MAX_MULTIPLIER) - 0.0099) < 0.003);
  assert.ok(Math.abs(share(point => point < 198) - 0.5) < 0.015);
  assert.throws(() => crashPoint(SECRET, 'salt'));
});

test('payouts use integer amounts; auto targets and secrets are strictly validated', () => {
  assert.equal(payoutAt(123456789012345678901n, 257), 317283947761728394775n);
  assert.equal(payoutAt(1n, 101), 1n);
  for (const auto of [0, 100, 10001, 200.5, '200', NaN, undefined])
    assert.equal(terms({ escapeHash: SECRET, auto }), null);
  assert.deepEqual(terms({ escapeHash: SECRET, auto: 200 }), { escapeHash: SECRET, auto: 200 });
  assert.equal(terms({ escapeHash: 'secret', auto: null }), null);
  // A ticket's meta is exactly its escape hash and its target: nothing missing, nothing riding along.
  assert.equal(terms({ escapeHash: SECRET }), null);
  assert.equal(terms({ escapeHash: SECRET, auto: null, note: 'extra' }), null);
  assert.throws(() => commitment('bad'));
});

test('each target is reached at its scheduled millisecond, never a millisecond early', () => {
  for (let target = 101; target <= MAX_MULTIPLIER; target++) {
    const at = timeTo(target);
    assert.ok(multiplierAt(at) >= target);
    assert.ok(multiplierAt(at - 1) < target);
  }
});

test('proof checking binds the secret, and with the salt the crash point, to the flight the player chose', () => {
  const proof = {
    number: 1,
    id: commitment(SECRET),
    secret: SECRET,
    point: crashPoint(SECRET, CHAIN.salt),
    startsAt: 0,
    tickets: [],
  };
  assert.equal('0x' + proof.id, CHAIN.end, 'flight 1’s ID is the chain’s end');
  assert.ok(verifyFlight(proof, proof.id, CHAIN.salt));
  assert.ok(!verifyFlight({ ...proof, point: proof.point + 1 }, proof.id, CHAIN.salt));
  assert.ok(!verifyFlight({ ...proof, secret: '0x' + 'd'.repeat(64) }, proof.id, CHAIN.salt));
  assert.ok(!verifyFlight(proof, 'f'.repeat(64), CHAIN.salt));
  assert.ok(!verifyFlight(proof, proof.id, '0x' + 'd'.repeat(64)));
});
