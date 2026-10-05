# Crash

A multiplayer crash game for [HookedIn](https://hookedin.com). One rocket, one rising multiplier, and a different exit
plan for every player. Page and server ship together as one Cloudflare Worker, with one Durable Object for the room.

The game includes manual and automatic escape, a live crew list, synthesized sound, keyboard controls, reduced motion,
mobile layouts, durable cash-out decisions and recent crash points that each check their revealed secret.

## Try it locally

Node 26 or later:

```sh
npm ci
npm run demo
```

Open **http://127.0.0.1:8791**. Select **Join as another pilot** to open another player in the same room. These are
simulated funds: every visitor gets an SDK wallet fixture and an in-memory casino stub. The real flight engine runs
their shared room; the preview combines the fixtures' developer feeds. Restarting the preview clears its sessions.
The preview harness is in `test/` and is not part of the Worker or its built assets.

## Play

- Choose a stake and optionally an auto-escape target from 1.01× to 100×.
- Join a flight while it boards. Flights leave one after another, eight seconds of boarding each, with or without a
  crew. There are 64 seats, one per player.
- During flight, press **Escape** or **Space** to receive your stake times the server's multiplier.
- Auto escape runs on the server, including while the page is closed. Its target must be **strictly below** the crash
  point. A target at the crash point loses. A flight can crash instantly at 1.00×.
- At 100× everyone still aboard escapes automatically. Amounts round down to whole wei.
- Select a recent crash point to check its secret against the flight ID published before boarding. The history
  carries each secret, so the check runs in the page.

Cash-outs count when the room starts processing them. The animated multiplier is an estimate between server updates;
network delay matters. An **accepted** escape has been saved by the room. A **received** payout has been verified and
collected by the wallet. The page distinguishes them. An unaccepted, malformed, duplicate or late bet gets its stake
back; betting through the wallet alone does not establish that the room accepted a seat.

## Money and trust

Every seat is one `HookedIn.developerBet`. Its stake goes into the game's bank at the casino. The server settles it with
`createDeveloper().settle`; a casino bet does not back this game. Fund the game's bank before offering it to players.
Capacity and payment are the developer's responsibility, as in HookedIn's developer-bet model. The server gives the
casino `stake / 200`, rounded down, on each accepted bet's settlement, from the game's bank.
Returned bets give the casino nothing. This is not an additional player charge.

The server generates a 32-byte secret and saves it before publishing its Keccak-256 hash as the flight ID. Each wallet
signs that ID as its bet's group. With `u` the first 64 bits of the secret and `N = 2^64`, the crash point in hundredths
is `min(10000, max(100, floor(99 × N / (N − u))))`. The multiplier at elapsed milliseconds `t` is
`min(10000, floor(100 × exp(t / 6500)))`. A crash point is reached at
`ceil(6500 × ln(point / 100))` milliseconds. Auto escape at the same instant loses, except at the forced 100× exit.
The point and secret are withheld until the flight ends.

The check proves that a revealed secret matches the flight's commitment and produces its displayed crash point.
**It does not prove unbiased secret selection, cash-out timing or solvency.** The developer knows the secret and
controls timing and payment. The wallet checks each signed settlement; it does not certify the game's wider rules.

## Implementation

| File               | Responsibility                                                                        |
| ------------------ | ------------------------------------------------------------------------------------- |
| `src/rules.ts`     | Crash distribution, timing, integer payouts, terms and proof checking                 |
| `server/room.ts`   | Shared flight, crew admission, escape decisions, durable state and settlement retries |
| `server/worker.ts` | HTTP routes, the room's Durable Object, durable storage and alarms                    |
| `src/game.ts`      | Wallet requests and recovery, live crew, controls, receipt checks and flight checks   |
| `src/sky.ts`       | Rocket, curve and particles; presentation only                                        |
| `src/icon.svg`     | The icon the wallet shows the game by: a square SVG of one symbol                     |
| `test/`            | Rules, recovery, SDK wallet integration, two-browser test and local preview           |

The page saves the operation ID, stake, flight, auto target and a random escape key before asking the wallet to sign.
The bet's meta contains only the key's hash and the auto target. Manual escape proves possession of that key; public
bet records cannot authorize someone else's escape. Reloading restores the request and the key in storage scoped to
the player and chain. A lost cash-out reply can be retried against the same saved decision.

Room changes are serialized and persisted before acknowledgement. A failed write cannot leave an acknowledged
in-memory decision. Casino reads and settlements run outside that queue, so a slow casino request does not block
cash-outs. The room saves payouts before settling them; retries send identical amounts. Alarms resolve auto targets
at their scheduled multiplier even when they wake after the crash. Flights fly on the clock: a flight nobody boarded
costs nothing, and whoever looks next finds the room where the clock has it. While a page watches or somebody is aboard
or owed, the room sets its alarm for the flight's next change (take-off, an auto escape, the crash, the next flight);
otherwise it lets it lapse. The next flight waits until all payouts have been settled. Flights that had a crew remain at
`/api/flights/<id>`.

Pages watch the room at `/api/live`, a stream of server-sent events: the room as it stands, each change as it happens,
and the room every 3 seconds while nothing changes. They animate locally between events. While a page watches, the room
follows the casino's bets: the casino holds each read until a bet on the game is placed, so a seat shows as soon as the
wallet has placed it. A page that hears nothing for 7 seconds pauses its controls and connects again. A page asks its
wallet about its bet once the room shows it paid or given back. Only actual accepted bets appear in the crew; there are
no invented players.

## Run against HookedIn

Publish the game as `crash`, with this Worker's URL, on **Developer** in your wallet: publishing makes your account the
game's developer. A developer bet needs a published game; opening the game by its URL alone does not publish it. The
Worker names the game by its key, `GAME`, which the **Developer** page shows beside it, and signs with the game's server
key, `SERVER_KEY`: a key you make for the Worker and name there, which spends the game's bank on its settlements and
nothing else. Until you name one, the server key is your account's own.

For local Worker development, put `GAME` and `SERVER_KEY` in `.dev.vars`, point `CASINO_URL` in `wrangler.jsonc` at the
chosen casino and run `npm run dev`. The page is served at `http://127.0.0.1:8791/`. Publish that URL in the chosen
wallet and open the published game there.

## Test

```sh
npm test
npm run format:check
npx wrangler deploy --dry-run
```

`npm test` type-checks, builds and runs the rules, room, Worker, actual SDK wallet and two-browser tests. The browser
test uses installed Google Chrome, with no browser download. It checks shared boarding, manual cash-out, automatic
cash-out through reload, wallet receipt collection, proof checking and mobile overflow. Its screenshots are in
`test-results/`. The SDK wallet tests use an in-memory casino stub, not a deployed casino.

## Deploy

1. Set the Worker name and route in `wrangler.jsonc`.
2. Publish the Worker's URL as `crash`, set `GAME` in `wrangler.jsonc` to its key, make a server key, name it beside the
   game on **Developer** and set it with `npx wrangler secret put SERVER_KEY`.
3. In the repository's Actions settings, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. Push to `main`. The workflow tests, builds and deploys, on play's newest `main`, and commits the lockfile it tested;
   play's release runs it whenever its `main` moves.
5. Fund the game's bank on **Developer**.

`npx wrangler deploy` publishes by hand. It is served at `https://crash-game.hookedin.com/`.

[MIT](LICENSE)
