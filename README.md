# Crash

A multiplayer crash game for [HookedIn](https://hookedin.com). One rocket, one rising multiplier, and a different exit
plan for every player. Page and server ship together as one Cloudflare Worker, with one Durable Object for the room.

The game includes manual and automatic escape, a live crew list, synthesized sound, keyboard controls, reduced motion,
mobile layouts, durable cash-out decisions and recent crash points that each check against the flights' hash chain.

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

The Worker itself plays with pretend money against the stand-in casino of `hookedin-game serve`
([trying it](https://hookedin.com/docs/games/developer-bets/#trying-it)): run
`npx hookedin-game serve http://127.0.0.1:8791/`, put the `CASINO_URL`, `GAME` and `SERVER_KEY` it prints in
`.dev.vars` with a chain for that key, as in [Run against HookedIn](#run-against-hookedin), then run `npm run dev` and
play at `http://localhost:4185/`. With the real casino, developer bets take a published game and real ETH.

## Play

- Choose a stake and optionally an auto-escape target from 1.01× to 100×.
- Join a flight while it boards. Flights leave one after another, eight seconds of boarding each, with or without a
  crew. There are 64 seats, one per player.
- During flight, press **Escape** or **Space** to receive your stake times the server's multiplier.
- Auto escape runs on the server, including while the page is closed. Its target must be **strictly below** the crash
  point. A target at the crash point loses. A flight can crash instantly at 1.00×.
- At 100× everyone still aboard escapes automatically. Amounts round down to whole wei.
- Select a recent crash point to check its secret against the flight ID published before boarding, and that ID
  against the flight before it, back to the chain's end. The history carries each secret, so the check runs in the
  page.

Cash-outs count when the room starts processing them. The animated multiplier is an estimate between server updates;
network delay matters. An **accepted** escape has been saved by the room, and is paid once the flight has crashed. A
**received** payout has been verified and collected by the wallet. The page distinguishes them. An unaccepted, malformed, duplicate or late bet gets its stake
back; betting through the wallet alone does not establish that the room accepted a seat.

## Money and trust

Every seat is one `HookedIn.developerBet`. Its stake goes into the game's bank at the casino. Each seat names its
flight as its `round`, `0x` and the flight's ID, the hash of the flight's secret, so the casino settles it only with
that secret. The server settles it with `createDeveloper().settle`, revealing the secret, and so only once the flight
has crashed; a casino bet does not back this game. Fund the game's bank before offering it to players:
the room seats a bet only while the bank, as `createDeveloper().bank` reads it, can pay the most every seat can win (its
stake at its auto escape, or at the forced 100× exit without one, and the casino's share below) beside everything else
the room owes, and gives any other bet its stake back. The room shows what the bank covers beyond that, and the page
says when a seat is too large for it. A bank that can pay every seat never leaves a payout waiting, which would hold
the next flight; one emptied mid-flight still can. The server gives the
casino `stake / 200`, rounded down, on each accepted bet's settlement, from the game's bank.
Returned bets give the casino nothing. This is not an additional player charge.

Every flight's secret comes from one hash chain, fixed before the first flight. Its top, flight 2^20's secret, is
`keccak256(abi.encode(keccak256("HOOKEDIN/CRASH/CHAIN"), SERVER_KEY))`, and each secret below is the hash of the one
above it, `secret(i − 1) = keccak256(secret(i))`, down to `secret(0)`, the chain's end, `CHAIN_END`. Flights take the
secrets in order, `secret(1)`, `secret(2)`, …, each once. A flight's ID, which each wallet signs as its bet's group,
and with `0x` before it as its round, is its secret's Keccak-256 hash: the secret of the flight before it, and for flight 1 the chain's end. The end was
published together with `CHAIN_BLOCK`, the number of an Ethereum block not yet mined, and `CHAIN_SALT` is that block's
hash. With `u` the first 64 bits of `keccak256(abi.encode(secret, CHAIN_SALT))` and `N = 2^64`, the crash point in
hundredths is `min(10000, max(100, floor(99 × N / (N − u))))`. The multiplier at elapsed milliseconds `t` is
`min(10000, floor(100 × exp(t / 6500)))`. A crash point is reached at `ceil(6500 × ln(point / 100))` milliseconds. Auto
escape at the same instant loses, except at the forced 100× exit. The point and secret are withheld until the flight
ends.

So every crash point was fixed before anyone bet: the chain's end fixed every secret, and the salt, which nobody knew
when the end was published, kept the developer from choosing a chain for its crash points. Before you join, the page
checks that the flight's ID is the secret the flight before it revealed. It checks each revealed secret against its
flight's ID and crash point, and on request hashes it back to the chain's end. **It does not prove cash-out timing,
seating or solvency, or that the page you play is this repository's.** The developer knows every crash point ahead,
controls seating, timing and payment, and serves the page. The wallet checks each signed settlement and that it
reveals the secret of the flight its bet named, and shows the player that the flight was fixed before they bet; it
does not certify the game's wider rules.

To check flight `i` yourself from its secret: the first command prints its ID, the second a hash that begins with `u`,
and the last `CHAIN_END`. Then check that the push that set `CHAIN_END` and `CHAIN_BLOCK` to `main` came before
block `CHAIN_BLOCK` was mined, as GitHub's activity log and the Deploy run it started show, and that `CHAIN_SALT` is
that block's hash.

```sh
cast keccak $SECRET
cast keccak $(cast abi-encode 'f(bytes32,bytes32)' $SECRET $CHAIN_SALT)
node -e 'let s = process.argv[1]; for (let k = 0; k < process.argv[2]; k++) s = require("ethers").keccak256(s); console.log(s)' $SECRET $I
```

The last runs in this repository after `npm ci`, up to 2^20 hashes in a few seconds.

## Implementation

| File               | Responsibility                                                                        |
| ------------------ | ------------------------------------------------------------------------------------- |
| `src/rules.ts`     | Crash distribution, timing, integer payouts, terms, proof and chain checking          |
| `server/room.ts`   | Shared flight, crew admission, escape decisions, durable state and settlement retries |
| `server/chain.ts`  | The server key's hash chain: its top, its checkpoints and each flight's secret        |
| `server/worker.ts` | HTTP routes, the room's Durable Object and its chain, durable storage and alarms      |
| `scripts/chain.ts` | `npm run chain`: the server key's chain end, for the ceremony                         |
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
at their scheduled multiplier even when they wake after the crash.

The room computes its chain once, 2^20 hashes in about five seconds, and keeps every 1024th secret in its storage
beside its state, which holds the number of its flight: each flight's secret is then at most 1023 hashes away. A room
that lost its storage would number its flights from 1 again and reveal secrets already published, so it needs a new
chain: a new server key and a new ceremony. On a new chain the room starts over at flight 1 and settles the bets still
open as late ones.

Flights fly on the clock: a flight nobody boarded costs nothing, and whoever looks next finds the room where the clock
has it. While a page watches or somebody is aboard or owed, the room sets its alarm for the flight's next change
(take-off, an auto escape, the crash, the next flight); otherwise it lets it lapse. The next flight waits until all
payouts have been settled. Flights that had a crew remain at `/api/flights/<id>`.

Pages watch the room at `/api/live`, a stream of server-sent events: the room as it stands, each change as it happens,
and the room every 3 seconds while nothing changes; a room that cannot open answers with one `down` event that says why,
which the page shows. They animate locally between events. While a page watches, the room follows the casino's bets: the
casino holds each read until a bet on the game is placed, so a seat shows as soon as the wallet has placed it. A page
that hears nothing for 7 seconds pauses its controls and connects again. A page asks its wallet about its bet once the
room shows it paid or given back. Only actual accepted bets appear in the crew; there are no invented players.

## Run against HookedIn

Publish the game as `crash`, with the URL its Worker runs on, on **Developer** in your wallet, from an account with a
balance, and put money in its bank there: publishing makes your account the game's developer, and the room seats only
what the bank can pay. A developer bet needs a published game; opening the game by its URL alone does not publish it.
The Worker names the game by its ID, `GAME`, which the **Developer** page shows under it, and signs with the game's
server key, `SERVER_KEY`, which spends the game's bank on its settlements and nothing else. In the game's folder, this
makes the key, saves it in `.dev.vars`, which git ignores, and prints only its address, which you name as the game's
server key on **Developer**:

```sh
node -e "const w = require('ethers').Wallet.createRandom(); require('fs').appendFileSync('.dev.vars', 'SERVER_KEY=' + w.privateKey + '\n'); console.log(w.address)"
```

The key goes nowhere but `.dev.vars` and `npx wrangler secret put SERVER_KEY`
([the server key](https://hookedin.com/docs/games/developer-bets/#your-games-server-key-and-bank)).

For local Worker development, add `GAME` and a chain to `.dev.vars`, point `CASINO_URL` in `wrangler.jsonc` at the
chosen casino and run `npm run dev`. A chain for development needs no ceremony: `CHAIN_END` is what `npm run chain`
prints for the key in `.dev.vars`, and any block number and 32-byte hash do for `CHAIN_BLOCK` and `CHAIN_SALT`:

```sh
GAME=<the game's ID>
CHAIN_END=<what npm run chain prints>
CHAIN_BLOCK=1
CHAIN_SALT=0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
```

The page is served at `http://127.0.0.1:8791/`. Publish that URL in the chosen wallet and open the published game
there.

## Test

```sh
npm test
npm run format:check
npx wrangler deploy --dry-run
```

`npm test` type-checks, builds and runs the rules, room, Worker, actual SDK wallet and two-browser tests. The browser
test uses installed Google Chrome, with no browser download. It checks shared boarding, manual cash-out, automatic
cash-out through reload, wallet receipt collection, proof checking, chain checking and mobile overflow. Its screenshots
are in `test-results/`. The SDK wallet tests use an in-memory casino stub, not a deployed casino.

## Deploy

1. Set the Worker name and route in `wrangler.jsonc`.
2. Publish the game's name with the Worker's URL, which keeps its ID and bank, and set `GAME` in `wrangler.jsonc` to
   that ID. Give the Worker a server key no other room has flown on, since a room reveals its chain's secrets as it
   flies: make it as in [Run against HookedIn](#run-against-hookedin), in place of the one in `.dev.vars`, name its
   address on **Developer** and set it with `npx wrangler secret put SERVER_KEY`.
3. In the repository's Actions settings, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. From then on every push
   to `main` tests, builds and deploys, on play's newest `main`, and commits the lockfile it tested; play's release runs
   it whenever its `main` moves.
4. Run the ceremony, which fixes the chain in public. `npm run chain` prints the chain's end of `SERVER_KEY`, from the
   environment or else `.dev.vars`, in a few seconds. Set `CHAIN_END` to it and `CHAIN_BLOCK` to an Ethereum block an hour or so ahead of
   the newest, and push both to `main`: that push is the commitment, so it must come before the block. Once the block
   is mined, set `CHAIN_SALT` to its hash and push again. Until then the room refuses to fly, as it does whenever
   `SERVER_KEY`'s chain does not end at `CHAIN_END`.
5. Fund the game's bank on **Developer**.

`npx wrangler deploy` deploys by hand. It is served at `https://crash-game.hookedin.com/`.

[MIT](LICENSE)
