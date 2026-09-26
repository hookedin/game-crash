# What would make the next multiplayer game easier

Afterburn fits the existing developer-bet model. Its game server owns the hidden outcome, the clock and its payments.
No casino or contract rule needs to understand a flight. Most of the additional work is coordinating durable game
decisions with wallet requests and asynchronous casino receipts.

## The useful improvements, in order

1. **A shared-casino, multiple-wallet test fixture.** The SDK's `gameWallet` is valuable: this demo uses the actual
   wallet's request validation, signatures, receipt verification and balance accounting. Each fixture owns a separate
   casino stub and developer, however. The preview combines those feeds to exercise a shared room. A fixture exposing
   several independent wallets against one casino and developer bank would make cross-player funding, simultaneous
   settlement and recovery tests simpler and more representative. This is the first SDK improvement I would make.

2. **A small developer-bet client for the page.** Roulette and Afterburn both save an operation before signing, recover
   its receipt, distinguish an open developer bet from a paid result, and deduplicate pushed and polled receipts.
   `RoundClient` serves casino-bet graphs. A similarly focused helper for the common developer-bet request lifecycle
   would remove repeated money-handling code. Game-specific state, such as the escape key and flight ID, should remain
   an ordinary saved payload. It needs no game rules, transport framework or new signing contract.

3. **Room broadcasts when traffic justifies them.** Each connected page requests a room snapshot twice per second;
   the room separately scans open casino bets once per second. Smooth canvas animation already happens locally.
   A Durable Object WebSocket broadcast would reduce repeated room reads and deliver crew updates sooner. A casino
   feed of newly placed developer bets would remove repeated full scans. Measure request volume and escape latency
   before adding either; neither changes the authoritative cash-out clock or the developer's payment responsibility.

## What the implementation needed to get right

An escape decision must be saved before the server acknowledges it. Its payout must be saved before contacting the
casino. Those casino requests must stay outside the queue handling new escapes. The tests cover all three, including
a lost settlement reply, a failed durable write and a casino request held open while another player escapes.

An accepted escape and a wallet-collected payment are distinct states. The interface shows both. Auto targets are
resolved from saved terms and scheduled times, so disconnected pages and delayed alarms do not change their payout.
The browser test exercises two players, a reload during flight and both kinds of escape; a separate SDK wallet test
checks the resulting signed balance.

The commitment has a specific purpose: it lets a player check the revealed crash point against the flight their
wallet signed. It cannot establish unbiased secret selection, timely handling of manual escapes or the developer's
ability to pay. Those remain explicit trust assumptions. Moving them into the casino would expand the product beyond
what this demo needs.

The best next investment is **better multiplayer test support, followed by a reusable developer-bet lifecycle**.
Keep the flight engine in the game and the settlement protocol as it is.
