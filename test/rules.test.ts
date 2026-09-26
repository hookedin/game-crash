import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commitment,
  crashPoint,
  MAX_MULTIPLIER,
  payoutAt,
  terms,
  timeTo,
  multiplierAt,
  verifyFlight,
} from '../src/rules.ts';
import { SECRET } from './fixture.ts';

test('the sample has an instant-crash tail, rises monotonically and caps at 100×', () => {
  let last = 100;
  for (let i = 0n; i < 10_000n; i++) {
    const sample = ((1n << 64n) * i) / 10_000n;
    const secret = '0x' + sample.toString(16).padStart(16, '0') + '0'.repeat(48);
    const point = crashPoint(secret);
    assert.ok(Number.isSafeInteger(point) && point >= last && point <= MAX_MULTIPLIER);
    last = point;
  }
  assert.equal(crashPoint('0x' + '0'.repeat(64)), 100);
  assert.equal(crashPoint('0x' + 'f'.repeat(64)), MAX_MULTIPLIER);
  assert.equal(crashPoint(SECRET), 494);
});

test('payouts use integer amounts; auto targets and secrets are strictly validated', () => {
  assert.equal(payoutAt('123456789012345678901', 257), 317283947761728394775n);
  assert.equal(payoutAt('1', 101), 1n);
  for (const auto of [0, 100, 10001, 200.5, '200', NaN, undefined])
    assert.equal(terms({ escapeHash: SECRET, auto }), null);
  assert.deepEqual(terms({ escapeHash: SECRET, auto: 200 }), { escapeHash: SECRET, auto: 200 });
  assert.equal(terms({ escapeHash: 'secret', auto: null }), null);
  assert.throws(() => commitment('bad'));
});

test('each target is reached at its scheduled millisecond, never a millisecond early', () => {
  for (let target = 101; target <= MAX_MULTIPLIER; target++) {
    const at = timeTo(target);
    assert.ok(multiplierAt(at) >= target);
    assert.ok(multiplierAt(at - 1) < target);
  }
});

test('proof checking binds both the secret and the crash point to the flight the player chose', () => {
  const proof = { id: commitment(SECRET), secret: SECRET, point: crashPoint(SECRET), startsAt: 0, tickets: [] };
  assert.ok(verifyFlight(proof, proof.id));
  assert.ok(!verifyFlight({ ...proof, point: 999 }, proof.id));
  assert.ok(!verifyFlight({ ...proof, secret: '0x' + 'd'.repeat(64) }, proof.id));
  assert.ok(!verifyFlight(proof, 'f'.repeat(64)));
});
