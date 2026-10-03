import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'ethers';
import { HEARTBEAT_MS } from '../server/room.ts';
import {
  BOARDING_MS,
  COOLDOWN_MS,
  MAX_CREW,
  MAX_MULTIPLIER,
  crashPoint,
  multiplierAt,
  timeTo,
  verifyFlight,
} from '../src/rules.ts';
import { fixture, TOKEN, SECRET } from './fixture.ts';

test('players share a saved commitment and one countdown; no live response exposes the secret', async () => {
  const x = fixture(),
    empty = await x.room.view();
  assert.equal(empty.startsAt, x.now() + BOARDING_MS, 'boarding counts down with nobody aboard');
  assert.equal(x.saved.flight!.id, empty.id);
  const alice = await x.bet(),
    bob = await x.bet();
  await x.room.read();
  const board = await x.room.view();
  assert.equal(board.id, empty.id);
  assert.equal(board.startsAt, empty.startsAt, 'seats do not move it');
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

test('flights nobody boards fly on the clock without an alarm, and each can be checked from the history', async () => {
  const x = fixture(),
    empty = await x.room.view(),
    end = empty.startsAt + timeTo(crashPoint(SECRET));
  x.at(end - 1);
  assert.equal((await x.room.view()).phase, 'flying');
  x.at(end);
  const ended = await x.room.view();
  assert.deepEqual([ended.phase, ended.point, ended.secret], ['ended', crashPoint(SECRET), SECRET]);
  x.at(end + COOLDOWN_MS);
  const next = await x.room.view();
  assert.notEqual(next.id, empty.id);
  assert.equal(next.startsAt, x.now() + BOARDING_MS, 'the next flight boards at once');
  assert.deepEqual(next.history, [{ id: empty.id, point: crashPoint(SECRET), secret: SECRET }]);
  assert.ok(verifyFlight(next.history[0]!, empty.id), 'its secret checks out against its ID');
  assert.equal(await x.room.kept(empty.id), undefined, 'a flight nobody boarded is not kept');
  // Nobody looked for an hour: the flight the clock left behind lands in the history, and the next one boards.
  x.at(next.startsAt + 3_600_000);
  const later = await x.room.view();
  assert.deepEqual([later.phase, later.startsAt, later.history[0]!.id], ['boarding', x.now() + BOARDING_MS, next.id]);
  assert.deepEqual(x.wakes, [], 'and nothing woke the room');
});

test('the room keeps an alarm only while somebody is aboard or a payment is owed', async () => {
  const x = fixture();
  await x.room.view();
  await x.room.read();
  assert.deepEqual(x.wakes, [], 'an empty flight sets no alarm');
  await x.bet();
  await x.room.read();
  assert.ok(x.wakes.length, 'the first accepted seat starts the alarm');
  const board = await x.room.view();
  // After the crash and the cooldown, the lost seat is settled and the next flight opens: nobody is aboard.
  x.at(board.startsAt + timeTo(crashPoint(SECRET)) + COOLDOWN_MS);
  await x.room.tick();
  await x.room.pay();
  assert.notEqual((await x.room.view()).id, board.id);
  const lapsed = x.wakes.length;
  await x.room.tick();
  await x.room.pay();
  assert.equal(x.wakes.length, lapsed, 'and the alarm lapses');
});

test('the room wakes for its flight’s next change: take-off, each auto escape, the crash and the next flight', async () => {
  const x = fixture(),
    point = crashPoint(SECRET);
  await x.bet({ meta: { escapeHash: keccak256(TOKEN), auto: 150 } });
  await x.room.read();
  const board = await x.room.view(),
    end = board.startsAt + timeTo(point);
  assert.equal(x.wakes.at(-1), board.startsAt, 'take-off');
  x.at(board.startsAt);
  await x.room.tick();
  await x.room.pay();
  assert.equal(x.wakes.at(-1), board.startsAt + timeTo(150), 'the auto escape');
  x.at(board.startsAt + timeTo(150));
  await x.room.tick();
  await x.room.pay();
  assert.equal((await x.room.view()).tickets[0]!.paid, true, 'paid at once');
  assert.equal(x.wakes.at(-1), end, 'the crash');
  x.at(end);
  await x.room.tick();
  await x.room.pay();
  assert.equal(x.wakes.at(-1), end + COOLDOWN_MS, 'the next flight');
});

test('a watching page sees each change as it happens, the room every heartbeat while nothing changes, and the bets it follows', async () => {
  const x = fixture();
  x.watch(true);
  const board = await x.room.view();
  assert.equal(x.wakes.at(-1), x.now() + HEARTBEAT_MS, 'a watched room wakes for its heartbeat');
  const shown = x.shown.length;
  await x.room.view();
  assert.equal(x.shown.length, shown, 'a look changes nothing, so nothing is shown');
  await x.room.tick();
  await x.room.pay();
  assert.equal(x.shown.length, shown + 1, 'the heartbeat shows the room either way');
  // The room follows the casino's bets: a bet placed while it waits is seated at once, and shown.
  const following = x.room.follow();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(x.reads.at(-1), { after: '', wait: 25 }, 'the room waits for a bet');
  const bet = await x.bet();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(
    x.shown.at(-1)!.tickets.map(t => t.bet),
    [bet.bet],
  );
  assert.deepEqual(x.reads.at(-1), { after: '1', wait: 25 }, 'and goes on from it');
  assert.equal(x.shown.at(-1)!.id, board.id);
  x.watch(false);
  await following;
  assert.equal((await x.room.view()).tickets.length, 1, 'a page that stops watching ends the following');
});

test('a watched room’s heartbeat comes a heartbeat after it last showed itself, whatever else asks it meanwhile', async () => {
  const x = fixture();
  x.watch(true);
  await x.room.tick();
  const shown = x.now();
  x.advance(2_000);
  await x.room.view();
  await x.room.kept('0'.repeat(64));
  assert.equal(x.wakes.at(-1), shown + HEARTBEAT_MS, 'looks that show nothing do not put it off');
});

test('a follower whose wait comes back empty early backs off, and after a failed read starts from the oldest open bet', async t => {
  t.mock.method(console, 'error', () => {});
  const x = fixture(),
    pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  x.watch(true);
  await x.bet();
  const following = x.room.follow();
  await pause(20);
  assert.deepEqual(x.reads.at(-1), { after: '1', wait: 25 }, 'it waits on from the bet it read');
  const reads = x.reads.length;
  x.answer();
  await pause(100);
  assert.equal(x.reads.length, reads, 'another server took the wait: it backs off before asking again');
  x.failNextRead();
  await pause(2_200);
  assert.deepEqual(
    x.reads.slice(reads),
    [
      { after: '1', wait: 25 },
      { after: '', wait: 25 },
      { after: '1', wait: 25 },
    ],
    'it reads the open bet again, passes over the seat it holds, and waits on from it',
  );
  assert.equal((await x.room.view()).tickets.length, 1);
  x.watch(false);
  await following;
});

test('only the holder of the escape key can cash out, and concurrent retries return one durable decision', async () => {
  const x = fixture(),
    bet = await x.bet();
  await x.room.read();
  const board = await x.room.view();
  await assert.rejects(x.room.cashout(board.id, bet.bet, TOKEN), /Wait for take-off/);
  x.at(board.startsAt + 1_500);
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
  await x.room.pay();
  assert.equal(x.settled.length, 1);
  assert.equal(x.bets.get(bet.bet)!.settlement!.player, results[0]!.payout);
  assert.equal(x.bets.get(bet.bet)!.settlement!.casino, '50');
});

test('auto escapes survive a disconnected page and a restart; a target at the crash point loses', async () => {
  const x = fixture(),
    point = crashPoint(SECRET);
  const auto = await x.bet({ meta: { escapeHash: keccak256(TOKEN), auto: 200 } });
  const tied = await x.bet({ meta: { escapeHash: keccak256(TOKEN), auto: point } });
  await x.room.read();
  const board = await x.room.view();
  x.at(board.startsAt + timeTo(point) + 5_000);
  x.restart();
  await x.room.tick();
  await x.room.pay();
  assert.equal(x.bets.get(auto.bet)!.settlement!.player, '20000');
  assert.equal(x.bets.get(tied.bet)!.settlement!.player, '0');
});

test('manual cashout succeeds before the crash deadline and fails at the deadline', async () => {
  const x = fixture(),
    early = await x.bet(),
    late = await x.bet();
  await x.room.read();
  const board = await x.room.view(),
    end = board.startsAt + timeTo(crashPoint(SECRET));
  x.at(end - 1);
  const won = await x.room.cashout(board.id, early.bet, TOKEN);
  assert.equal(won.status, 'escaped');
  assert.ok(won.multiplier! < crashPoint(SECRET));
  x.at(end);
  await assert.rejects(x.room.cashout(board.id, late.bet, TOKEN), /crashed/);
  await x.room.tick();
  await x.room.pay();
  assert.equal(x.bets.get(late.bet)!.settlement!.player, '0');
});

test('an instant crash offers no escape; at 100× everyone still aboard escapes automatically', async () => {
  for (const [secret, expected] of [
    ['0x' + '0'.repeat(64), '0'],
    ['0x' + 'f'.repeat(64), '1000000'],
  ]) {
    const x = fixture(secret),
      bet = await x.bet();
    await x.room.read();
    x.at((await x.room.view()).startsAt + timeTo(crashPoint(secret!)));
    await x.room.tick();
    await x.room.pay();
    assert.equal(x.bets.get(bet.bet)!.settlement!.player, expected);
  }
});

test('a target at 100× receives the capped payout', async () => {
  const x = fixture('0x' + 'f'.repeat(64));
  const bet = await x.bet({ meta: { escapeHash: keccak256(TOKEN), auto: MAX_MULTIPLIER } });
  await x.room.read();
  x.at((await x.room.view()).startsAt + timeTo(MAX_MULTIPLIER));
  await x.room.tick();
  await x.room.pay();
  assert.equal(x.bets.get(bet.bet)!.settlement!.player, '1000000');
});

test('duplicates, malformed terms and late bets are returned without commission', async () => {
  const x = fixture();
  const accepted = await x.bet({ uname: 'alice' });
  const duplicate = await x.bet({ uname: 'alice' });
  const malformed = await x.bet({ meta: { escapeHash: 'wrong', auto: 200 } });
  await x.room.read();
  await x.room.pay();
  const board = await x.room.view();
  assert.deepEqual(
    board.tickets.map(t => t.bet),
    [accepted.bet],
  );
  for (const bet of [duplicate, malformed])
    assert.deepEqual(x.bets.get(bet.bet)!.settlement, { player: bet.stake, casino: '0', signature: 'signature' });
  x.at(board.startsAt);
  const late = await x.bet();
  await x.room.read();
  await x.room.pay();
  assert.equal(x.bets.get(late.bet)!.settlement!.player, late.stake);
  assert.equal((await x.room.view()).tickets.length, 1);
});

test('an acknowledged escape survives a lost settlement reply and eviction without a second payout', async () => {
  const x = fixture(),
    bet = await x.bet();
  await x.room.read();
  const board = await x.room.view();
  x.at(board.startsAt + 1_000);
  const escape = await x.room.cashout(board.id, bet.bet, TOKEN);
  x.loseReply(true);
  await assert.rejects(x.room.pay(), /reply lost/);
  x.restart();
  x.loseReply(false);
  await x.room.pay();
  assert.equal(x.settled.length, 1);
  const ticket = (await x.room.view()).tickets[0]!;
  assert.equal(ticket.paid, true);
  assert.equal(ticket.payout, escape.payout);
});

test('a full flight keeps its 64 accepted seats and returns the additional stake', async () => {
  const x = fixture();
  for (let i = 0; i < MAX_CREW; i++) await x.bet();
  const extra = await x.bet();
  await x.room.read();
  await x.room.pay();
  assert.equal((await x.room.view()).tickets.length, MAX_CREW);
  assert.equal(x.bets.get(extra.bet)!.settlement!.player, extra.stake);
  assert.equal(x.bets.get(extra.bet)!.settlement!.casino, '0');
});

test('a failed durable write cannot acknowledge an escape or change its in-memory decision', async () => {
  const x = fixture(),
    bet = await x.bet();
  await x.room.read();
  const board = await x.room.view();
  x.at(board.startsAt + 1_000);
  x.failSave(true);
  await assert.rejects(x.room.cashout(board.id, bet.bet, TOKEN), /Storage unavailable/);
  assert.equal(x.saved.flight!.tickets[0]!.status, 'aboard');
  x.failSave(false);
  x.at(board.startsAt + 2_000);
  const escape = await x.room.cashout(board.id, bet.bet, TOKEN);
  assert.equal(escape.multiplier, multiplierAt(2_000));
});

test('a slow casino settlement never holds the queue that accepts another player’s escape', async () => {
  const x = fixture(),
    a = await x.bet(),
    b = await x.bet();
  await x.room.read();
  const board = await x.room.view();
  x.at(board.startsAt + 1_000);
  await x.room.cashout(board.id, a.bet, TOKEN);
  let release!: () => void;
  x.pauseSettlement(
    new Promise<void>(resolve => {
      release = resolve;
    }),
  );
  const settling = x.room.pay();
  const escape = await x.room.cashout(board.id, b.bet, TOKEN);
  assert.equal(escape.status, 'escaped');
  release();
  await settling;
  assert.equal(x.settled.length, 2, 'the escape accepted meanwhile is settled after the first');
});

test('the result stays visible until paid, then a new commitment opens and the proof stays readable', async () => {
  const x = fixture(),
    bet = await x.bet();
  await x.room.read();
  const board = await x.room.view();
  x.at(board.startsAt + timeTo(crashPoint(SECRET)) + COOLDOWN_MS);
  const ended = await x.room.view();
  assert.equal(ended.phase, 'ended');
  assert.equal(ended.secret, SECRET);
  assert.equal(ended.tickets[0]!.paid, false);
  assert.equal((await x.room.kept(board.id))!.tickets[0]!.bet, bet.bet);
  await x.room.pay();
  const next = await x.room.view();
  assert.notEqual(next.id, board.id);
  assert.equal(next.secret, null);
  assert.equal(next.history[0]!.id, board.id);
  x.restart();
  assert.equal((await x.room.kept(board.id))!.secret, SECRET);
  const late = await x.bet({ group: board.id });
  await x.room.read();
  await x.room.pay();
  assert.equal(x.bets.get(late.bet)!.settlement!.player, late.stake);
});
