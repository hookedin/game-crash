import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'ethers';
import { BOARDING_MS, COOLDOWN_MS, MAX_CREW, MAX_MULTIPLIER, crashPoint, multiplierAt, timeTo } from '../src/rules.ts';
import { fixture, TOKEN, SECRET } from './fixture.ts';

test('players share a saved commitment; the first accepted bet starts boarding and no live response exposes the secret', async () => {
  const x = fixture(),
    empty = await x.room.view();
  assert.equal(empty.startsAt, null);
  assert.equal(x.saved.flight!.id, empty.id);
  const alice = await x.bet(),
    bob = await x.bet();
  await x.room.sync(true);
  const board = await x.room.view();
  assert.equal(board.id, empty.id);
  assert.equal(board.startsAt, x.now() + BOARDING_MS);
  assert.deepEqual(
    board.tickets.map(t => t.bet),
    [alice.bet, bob.bet],
  );
  assert.equal(board.secret, null);
  assert.equal(board.point, null);
  assert.ok(!JSON.stringify(board).includes(SECRET));
  assert.ok(!JSON.stringify(board).includes('escapeHash'));
  assert.equal(await x.room.kept(board.id), undefined);
});

test('the room keeps an alarm only while a flight is under way or a payment is owed', async () => {
  const x = fixture();
  await x.room.view();
  await x.room.sync(true);
  assert.deepEqual(x.wakes, [], 'an empty launch pad sets no alarm');
  await x.bet();
  await x.room.sync(true);
  assert.ok(x.wakes.length, 'the first accepted bet starts boarding, and the alarm with it');
  const board = await x.room.view();
  // After the crash and the cooldown, the lost seat is settled and the next flight opens: nothing is under way.
  x.at(board.startsAt! + timeTo(crashPoint(SECRET)) + COOLDOWN_MS);
  await x.room.sync(true);
  assert.notEqual((await x.room.view()).id, board.id);
  const lapsed = x.wakes.length;
  await x.room.view();
  await x.room.sync(true);
  assert.equal(x.wakes.length, lapsed, 'and the alarm lapses');
});

test('only the holder of the escape key can cash out, and concurrent retries return one durable decision', async () => {
  const x = fixture(),
    bet = await x.bet();
  await x.room.sync(true);
  const board = await x.room.view();
  await assert.rejects(x.room.cashout(board.id, bet.bet, TOKEN), /Wait for take-off/);
  x.at(board.startsAt! + 1_500);
  await assert.rejects(x.room.cashout(board.id, bet.bet, SECRET), /escape key/);
  const results = await Promise.all([
    x.room.cashout(board.id, bet.bet, TOKEN),
    x.room.cashout(board.id, bet.bet, TOKEN),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0]!.multiplier, multiplierAt(1_500));
  assert.equal(results[0]!.paid, false, 'an accepted escape is distinct from a paid receipt');
  assert.equal(x.saved.flight!.tickets[0]!.payout, results[0]!.payout);
  assert.equal(x.settled.length, 0, 'the decision is durable before the casino is called');
  await x.room.sync(true);
  assert.equal(x.settled.length, 1);
  assert.equal(x.bets.get(bet.bet)!.settlement!.player, results[0]!.payout);
  assert.equal(x.bets.get(bet.bet)!.settlement!.casino, '50');
});

test('auto escapes survive a disconnected page and a restart; a target at the crash point loses', async () => {
  const x = fixture(),
    point = crashPoint(SECRET);
  const auto = await x.bet({ meta: { escapeHash: keccak256(TOKEN), auto: 200 } });
  const tied = await x.bet({ meta: { escapeHash: keccak256(TOKEN), auto: point } });
  await x.room.sync(true);
  const board = await x.room.view();
  x.at(board.startsAt! + timeTo(point) + 5_000);
  x.restart();
  await x.room.sync(true);
  assert.equal(x.bets.get(auto.bet)!.settlement!.player, '20000');
  assert.equal(x.bets.get(tied.bet)!.settlement!.player, '0');
});

test('manual cashout succeeds before the crash deadline and fails at the deadline', async () => {
  const x = fixture(),
    early = await x.bet(),
    late = await x.bet();
  await x.room.sync(true);
  const board = await x.room.view(),
    end = board.startsAt! + timeTo(crashPoint(SECRET));
  x.at(end - 1);
  const won = await x.room.cashout(board.id, early.bet, TOKEN);
  assert.equal(won.status, 'escaped');
  assert.ok(won.multiplier! < crashPoint(SECRET));
  x.at(end);
  await assert.rejects(x.room.cashout(board.id, late.bet, TOKEN), /crashed/);
  await x.room.sync(true);
  assert.equal(x.bets.get(late.bet)!.settlement!.player, '0');
});

test('an instant crash offers no escape; at 100× everyone still aboard escapes automatically', async () => {
  for (const [secret, expected] of [
    ['0x' + '0'.repeat(64), '0'],
    ['0x' + 'f'.repeat(64), '1000000'],
  ]) {
    const x = fixture(secret),
      bet = await x.bet();
    await x.room.sync(true);
    x.at((await x.room.view()).startsAt! + timeTo(crashPoint(secret!)));
    await x.room.sync(true);
    assert.equal(x.bets.get(bet.bet)!.settlement!.player, expected);
  }
});

test('a target at 100× receives the capped payout', async () => {
  const x = fixture('0x' + 'f'.repeat(64));
  const bet = await x.bet({ meta: { escapeHash: keccak256(TOKEN), auto: MAX_MULTIPLIER } });
  await x.room.sync(true);
  x.at((await x.room.view()).startsAt! + timeTo(MAX_MULTIPLIER));
  await x.room.sync(true);
  assert.equal(x.bets.get(bet.bet)!.settlement!.player, '1000000');
});

test('duplicates, malformed terms and late bets are returned without commission', async () => {
  const x = fixture();
  const accepted = await x.bet({ uname: 'alice' });
  const duplicate = await x.bet({ uname: 'alice' });
  const malformed = await x.bet({ meta: { escapeHash: 'wrong', auto: 200 } });
  await x.room.sync(true);
  const board = await x.room.view();
  assert.deepEqual(
    board.tickets.map(t => t.bet),
    [accepted.bet],
  );
  for (const bet of [duplicate, malformed])
    assert.deepEqual(x.bets.get(bet.bet)!.settlement, { player: bet.stake, casino: '0', signature: 'signature' });
  x.at(board.startsAt!);
  const late = await x.bet();
  await x.room.sync(true);
  assert.equal(x.bets.get(late.bet)!.settlement!.player, late.stake);
  assert.equal((await x.room.view()).tickets.length, 1);
});

test('an acknowledged escape survives a lost settlement reply and eviction without a second payout', async () => {
  const x = fixture(),
    bet = await x.bet();
  await x.room.sync(true);
  const board = await x.room.view();
  x.at(board.startsAt! + 1_000);
  const escape = await x.room.cashout(board.id, bet.bet, TOKEN);
  x.loseReply(true);
  await assert.rejects(x.room.sync(true), /reply lost/);
  x.restart();
  x.loseReply(false);
  await x.room.sync(true);
  assert.equal(x.settled.length, 1);
  const ticket = (await x.room.view()).tickets[0]!;
  assert.equal(ticket.paid, true);
  assert.equal(ticket.payout, escape.payout);
});

test('a full flight keeps its 64 accepted seats and returns the additional stake', async () => {
  const x = fixture();
  for (let i = 0; i < MAX_CREW; i++) await x.bet();
  const extra = await x.bet();
  await x.room.sync(true);
  assert.equal((await x.room.view()).tickets.length, MAX_CREW);
  assert.equal(x.bets.get(extra.bet)!.settlement!.player, extra.stake);
  assert.equal(x.bets.get(extra.bet)!.settlement!.casino, '0');
});

test('a failed durable write cannot acknowledge an escape or change its in-memory decision', async () => {
  const x = fixture(),
    bet = await x.bet();
  await x.room.sync(true);
  const board = await x.room.view();
  x.at(board.startsAt! + 1_000);
  x.failSave(true);
  await assert.rejects(x.room.cashout(board.id, bet.bet, TOKEN), /Storage unavailable/);
  assert.equal(x.saved.flight!.tickets[0]!.status, 'aboard');
  x.failSave(false);
  x.at(board.startsAt! + 2_000);
  const escape = await x.room.cashout(board.id, bet.bet, TOKEN);
  assert.equal(escape.multiplier, multiplierAt(2_000));
});

test('a slow casino settlement never holds the queue that accepts another player’s escape', async () => {
  const x = fixture(),
    a = await x.bet(),
    b = await x.bet();
  await x.room.sync(true);
  const board = await x.room.view();
  x.at(board.startsAt! + 1_000);
  await x.room.cashout(board.id, a.bet, TOKEN);
  let release!: () => void;
  x.pauseSettlement(
    new Promise<void>(resolve => {
      release = resolve;
    }),
  );
  const settling = x.room.sync(true);
  const escape = await x.room.cashout(board.id, b.bet, TOKEN);
  assert.equal(escape.status, 'escaped');
  release();
  await settling;
  x.pauseSettlement(null);
  await x.room.sync(true);
  assert.equal(x.settled.length, 2);
});

test('the result stays visible until paid, then a new commitment opens and the proof stays readable', async () => {
  const x = fixture(),
    bet = await x.bet();
  await x.room.sync(true);
  const board = await x.room.view();
  x.at(board.startsAt! + timeTo(crashPoint(SECRET)) + COOLDOWN_MS);
  const ended = await x.room.view();
  assert.equal(ended.phase, 'ended');
  assert.equal(ended.secret, SECRET);
  assert.equal(ended.tickets[0]!.paid, false);
  assert.equal((await x.room.kept(board.id))!.tickets[0]!.bet, bet.bet);
  await x.room.sync(true);
  const next = await x.room.view();
  assert.notEqual(next.id, board.id);
  assert.equal(next.secret, null);
  assert.equal(next.history[0]!.id, board.id);
  x.restart();
  assert.equal((await x.room.kept(board.id))!.secret, SECRET);
  const late = await x.bet({ group: board.id });
  await x.room.sync(true);
  assert.equal(x.bets.get(late.bet)!.settlement!.player, late.stake);
});
