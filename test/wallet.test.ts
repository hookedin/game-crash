import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'ethers';
import { gameWallet } from '@hookedin/play/testing/game-wallet.ts';
import { Room } from '../server/room.ts';
import { timeTo } from '../src/rules.ts';
import { SECRET, TOKEN } from './fixture.ts';

test('the actual SDK wallet signs a flight bet, verifies the developer’s settlement and credits the exact escape payout', async () => {
  const x = await gameWallet();
  x.wallet.openGame(x.identity());
  await x.wallet.setGameLimit('100000');
  let now = Date.now();
  const room = new Room({
    developer: x.developer,
    now: () => now,
    secret: () => SECRET,
    save: async () => {},
    keep: async () => {},
    kept: async () => undefined,
    wake: async () => {},
  });
  const flight = await room.view();
  const receipt = await x.bridge.call('game.developerBet', {
    id: 'flight-seat',
    stake: '10000',
    group: flight.id,
    meta: { escapeHash: keccak256(TOKEN), auto: 200 },
  });
  assert.equal(receipt.status, 'open');
  assert.equal((await x.bridge.balance()).balance, '90000');
  await room.sync(true);
  now = (await room.view()).startsAt! + timeTo(200);
  await room.sync(true);
  await x.wallet.collectPayouts();
  const paid = await x.bridge.call('game.receipt', { id: 'flight-seat' });
  assert.equal(paid.status, 'settled');
  assert.equal(paid.payout, '20000');
  assert.equal((await x.bridge.balance()).balance, '110000');
  assert.equal(await x.wallet.balance(), 1010000n);
  assert.equal(x.bank(), 10n ** 12n + 10000n - 20000n - 50n);
});
