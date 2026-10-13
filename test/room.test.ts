import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toBeHex } from 'ethers';
import { json } from '@hookedin/play/sdk/json';
import { HEARTBEAT_MS } from '../server/room.ts';
import {
  BOARDING_MS,
  COOLDOWN_MS,
  MAX_CREW,
  MAX_MULTIPLIER,
  crashPoint,
  hashed,
  multiplierAt,
  timeTo,
  verifyFlight,
  verifyView,
} from '../src/rules.ts';
import type { FlightSummary } from '../src/rules.ts';
import { fixture, secretOf, CHAIN, TOKEN, SECRET } from './fixture.ts';

/** Flight 1's crash point. */
const POINT = crashPoint(SECRET, CHAIN.salt);
/** A salt that crashes flight 1 at `point`. */
function saltFor(point: number) {
  for (let i = 1n; ; i++) if (crashPoint(SECRET, toBeHex(i, 32)) === point) return toBeHex(i, 32);
}

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
  assert.ok(!json(board).includes(SECRET));
  assert.ok(!json(board).includes('escapeHash'));
  assert.equal(await x.room.kept(board.id), undefined);
});

test('flights nobody boards fly on the clock without an alarm, and each can be checked from the history', async () => {
  const x = fixture(),
    empty = await x.room.view(),
    end = empty.startsAt + timeTo(POINT);
  x.at(end - 1);
  assert.equal((await x.room.view()).phase, 'flying');
  x.at(end);
  const ended = await x.room.view();
  assert.deepEqual([ended.phase, ended.point, ended.secret], ['ended', POINT, SECRET]);
  x.at(end + COOLDOWN_MS);
  const next = await x.room.view();
  assert.notEqual(next.id, empty.id);
  assert.equal(next.startsAt, x.now() + BOARDING_MS, 'the next flight boards at once');
  assert.deepEqual(next.history, [{ number: 1, id: empty.id, point: POINT, secret: SECRET }]);
  assert.ok(verifyFlight(next.history[0]!, empty.id, CHAIN.salt), 'its secret checks out against its ID');
  assert.equal(await x.room.kept(empty.id), undefined, 'a flight nobody boarded is not kept');
  // Nobody looked for an hour: the flight the clock left behind lands in the history, and the next one boards.
  x.at(next.startsAt + 3_600_000);
  const later = await x.room.view();
  assert.deepEqual([later.phase, later.startsAt, later.history[0]!.id], ['boarding', x.now() + BOARDING_MS, next.id]);
  assert.deepEqual(x.wakes, [], 'and nothing woke the room');
});

test('each flight’s ID is the secret of the flight before it, back to the chain’s end, and each view checks out', async () => {
  const x = fixture();
  let view = await x.room.view();
  assert.deepEqual([view.number, view.id, view.chain], [1, CHAIN.end.slice(2), CHAIN]);
  for (let number = 1; number <= 3; number++) {
    assert.ok(verifyView(view));
    x.at(view.startsAt + timeTo(crashPoint(secretOf(number), CHAIN.salt)));
    const ended = await x.room.view();
    assert.ok(verifyView(ended));
    assert.equal(
      hashed(ended.secret!, number),
      CHAIN.end,
      'its secret, hashed as many times as its number, is the end',
    );
    x.advance(COOLDOWN_MS);
    view = await x.room.view();
    assert.deepEqual([view.number, view.id], [number + 1, ended.secret!.slice(2)]);
  }
  assert.deepEqual(
    view.history.map(f => f.number),
    [3, 2, 1],
  );
  assert.ok(verifyView(view));
  // A flight off the chain, a history that skips one or shows another crash point, or another chain's end or salt.
  const [third, second, first] = view.history as [FlightSummary, FlightSummary, FlightSummary];
  for (const changed of [
    { id: 'f'.repeat(64) },
    { history: [third, first] },
    { history: [{ ...third, point: third.point + 1 }, second, first] },
    { chain: { ...CHAIN, end: '0x' + 'f'.repeat(64) } },
    { chain: { ...CHAIN, salt: '0x' + 'f'.repeat(64) } },
  ])
    assert.ok(!verifyView({ ...view, ...changed }), json(changed));
});

test('the room keeps its place on the chain through a restart, and flies each number once', async () => {
  const x = fixture(),
    first = await x.room.view();
  x.restart();
  assert.equal((await x.room.view()).id, first.id, 'a restart keeps the boarding flight');
  x.at(first.startsAt + timeTo(POINT) + COOLDOWN_MS);
  const second = await x.room.view();
  x.restart();
  const again = await x.room.view();
  assert.deepEqual([again.number, again.id], [2, second.id]);
  assert.deepEqual([...new Set(x.writes.map(state => state.flight!.number))], [1, 2]);
});

test('on another chain the room starts over at flight 1, and settles the bets still open as late ones', async () => {
  const x = fixture(),
    bet = await x.bet();
  await x.room.read();
  const board = await x.room.view();
  x.at(board.startsAt + timeTo(POINT));
  await x.room.view();
  // A new server key, and its own chain.
  const top = '0x' + 'e'.repeat(64);
  x.deps.chain = { ...CHAIN, end: hashed(top, 8) };
  x.deps.secret = number => hashed(top, 8 - number);
  x.restart();
  const fresh = await x.room.view();
  assert.deepEqual([fresh.number, fresh.id, fresh.history], [1, x.deps.chain.end.slice(2), []]);
  assert.ok(verifyView(fresh));
  await x.room.read();
  await x.room.pay();
  // The lost seat is settled as it landed, with the secret of the flight it rode on, which the room kept as it ended.
  assert.deepEqual([x.bets.get(bet.bet)!.settlement!.player, x.bets.get(bet.bet)!.settlement!.secret], [0n, SECRET]);
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
  x.at(board.startsAt + timeTo(POINT) + COOLDOWN_MS);
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
    point = POINT;
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
  assert.equal((await x.room.view()).tickets[0]!.paid, false, 'paid once the crash is out: its settlement reveals it');
  assert.equal(x.wakes.at(-1), end, 'the crash');
  x.at(end);
  await x.room.tick();
  await x.room.pay();
  assert.equal((await x.room.view()).tickets[0]!.paid, true);
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
  assert.equal(x.settled.length, 0, 'and settled once the flight has crashed, which its settlement reveals');
  x.at(board.startsAt + timeTo(POINT));
  await x.room.pay();
  assert.equal(x.settled.length, 1);
  assert.deepEqual(x.bets.get(bet.bet)!.settlement, {
    player: results[0]!.payout,
    casino: 50n,
    secret: SECRET,
    signature: 'signature',
  });
});

test('auto escapes survive a disconnected page and a restart; a target at the crash point loses', async () => {
  const x = fixture(),
    point = POINT;
  const auto = await x.bet({ meta: { escapeHash: keccak256(TOKEN), auto: 200 } });
  const tied = await x.bet({ meta: { escapeHash: keccak256(TOKEN), auto: point } });
  await x.room.read();
  const board = await x.room.view();
  x.at(board.startsAt + timeTo(point) + 5_000);
  x.restart();
  await x.room.tick();
  await x.room.pay();
  assert.equal(x.bets.get(auto.bet)!.settlement!.player, 20000n);
  assert.equal(x.bets.get(tied.bet)!.settlement!.player, 0n);
});

test('manual cashout succeeds before the crash deadline and fails at the deadline', async () => {
  const x = fixture(),
    early = await x.bet(),
    late = await x.bet();
  await x.room.read();
  const board = await x.room.view(),
    end = board.startsAt + timeTo(POINT);
  x.at(end - 1);
  const won = await x.room.cashout(board.id, early.bet, TOKEN);
  assert.equal(won.status, 'escaped');
  assert.ok(won.multiplier! < POINT);
  x.at(end);
  await assert.rejects(x.room.cashout(board.id, late.bet, TOKEN), /crashed/);
  await x.room.tick();
  await x.room.pay();
  assert.equal(x.bets.get(late.bet)!.settlement!.player, 0n);
});

test('an instant crash offers no escape; at 100× everyone still aboard escapes automatically', async () => {
  for (const [point, expected] of [
    [100, 0n],
    [MAX_MULTIPLIER, 1000000n],
  ] as const) {
    const x = fixture(saltFor(point)),
      bet = await x.bet();
    await x.room.read();
    x.at((await x.room.view()).startsAt + timeTo(point));
    await x.room.tick();
    await x.room.pay();
    assert.equal(x.bets.get(bet.bet)!.settlement!.player, expected);
  }
});

test('a target at 100× receives the capped payout', async () => {
  const x = fixture(saltFor(MAX_MULTIPLIER));
  const bet = await x.bet({ meta: { escapeHash: keccak256(TOKEN), auto: MAX_MULTIPLIER } });
  await x.room.read();
  x.at((await x.room.view()).startsAt + timeTo(MAX_MULTIPLIER));
  await x.room.tick();
  await x.room.pay();
  assert.equal(x.bets.get(bet.bet)!.settlement!.player, 1000000n);
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
  x.at(board.startsAt);
  const late = await x.bet();
  await x.room.read();
  await x.room.pay();
  assert.equal((await x.room.view()).tickets.length, 1);
  // Each stake comes back once the flight has crashed: its settlement reveals the flight's secret.
  assert.deepEqual(x.settled, []);
  x.at(board.startsAt + timeTo(POINT));
  await x.room.pay();
  for (const bet of [duplicate, malformed, late])
    assert.deepEqual(x.bets.get(bet.bet)!.settlement, {
      player: bet.stake,
      casino: 0n,
      secret: SECRET,
      signature: 'signature',
    });
});

test('an acknowledged escape survives a lost settlement reply and eviction without a second payout', async () => {
  const x = fixture(),
    bet = await x.bet();
  await x.room.read();
  const board = await x.room.view();
  x.at(board.startsAt + 1_000);
  const escape = await x.room.cashout(board.id, bet.bet, TOKEN);
  x.at(board.startsAt + timeTo(POINT));
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

test('the room seats a bet only while the game’s bank can pay the most every seat can win, and shows what it covers', async () => {
  const x = fixture();
  // The bank holds both stakes, and what the first can win beyond its own escaping by hand, at 100×.
  const most = 10000n * 100n + 10000n / 200n;
  x.fund(most + 10000n);
  const first = await x.bet(),
    second = await x.bet();
  await x.room.read();
  await x.room.pay();
  let board = await x.room.view();
  assert.deepEqual(
    board.tickets.map(t => t.bet),
    [first.bet],
  );
  assert.deepEqual(x.saved.outbox, [{ bet: second.bet, player: second.stake, casino: 0n, secret: SECRET }]);
  assert.equal(board.cover, 0n);
  // Its developer puts in what a seat escaping at 2× can win beyond its stake, beside the stake the room still owes back
  // until the flight lands: the next one is seated.
  x.fund(most + 10000n + second.stake + 10000n + 50n);
  const third = await x.bet({ meta: { escapeHash: keccak256(TOKEN), auto: 200 } });
  await x.room.read();
  board = await x.room.view();
  assert.deepEqual(
    board.tickets.map(t => t.bet),
    [first.bet, third.bet],
  );
  assert.equal(board.cover, 0n);
});

test('a full flight keeps its 64 accepted seats and returns the additional stake', async () => {
  const x = fixture();
  for (let i = 0; i < MAX_CREW; i++) await x.bet();
  const extra = await x.bet();
  await x.room.read();
  const board = await x.room.view();
  assert.equal(board.tickets.length, MAX_CREW);
  x.at(board.startsAt + timeTo(POINT));
  await x.room.pay();
  assert.equal(x.bets.get(extra.bet)!.settlement!.player, extra.stake);
  assert.equal(x.bets.get(extra.bet)!.settlement!.casino, 0n);
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
    b = await x.bet(),
    // A bet that rides on no round is given its stake back at once: its settlement reveals nothing.
    stray = await x.bet({ round: undefined });
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
  assert.deepEqual(x.settled, [stray.bet]);
  x.at(board.startsAt + timeTo(POINT));
  await x.room.pay();
  assert.deepEqual(x.settled, [stray.bet, a.bet, b.bet], 'the escape accepted meanwhile is settled with the first');
});

test('the result stays visible until paid, then a new commitment opens and the proof stays readable', async () => {
  const x = fixture(),
    bet = await x.bet();
  await x.room.read();
  const board = await x.room.view();
  x.at(board.startsAt + timeTo(POINT) + COOLDOWN_MS);
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
