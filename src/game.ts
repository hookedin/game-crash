import { keccak256 } from 'ethers';
import { HookedIn } from '@hookedin/play/sdk/sdk';
import type { GameReceipt } from '@hookedin/play/sdk/sdk';
import { mountAllowance } from '@hookedin/play/sdk/allowance';
import { createSynth } from '@hookedin/play/sdk/synth';
import {
  BOARDING_MS,
  MAX_CREW,
  MAX_MULTIPLIER,
  multiplierAt,
  multiplierText,
  payoutAt,
  verifyFlight,
} from './rules.ts';
import type { FlightProof, FlightSummary, FlightView, PublicTicket } from './rules.ts';
import { createSky } from './sky.ts';

interface Saved {
  id: string;
  flight: string;
  stake: string;
  auto: number | null;
  token: string;
  bet?: string;
  escapeRequested?: boolean;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const stake = $<HTMLInputElement>('stake'),
  target = $<HTMLInputElement>('auto-target'),
  auto = $<HTMLInputElement>('auto-enabled');
const action = $<HTMLButtonElement>('action'),
  stage = $('stage'),
  toastBox = $('toast');
const allowance = mountAllowance($('allowance')),
  sound = createSynth('afterburn:sound');
const sky = createSky($<HTMLCanvasElement>('sky'), matchMedia('(prefers-reduced-motion: reduce)').matches);
let ready = false,
  working = false,
  finishing = false,
  scope = '',
  uname: string | null = null;
let view: FlightView | null = null,
  saved: Saved | null = null,
  arrivedAt = 0,
  proofFault = false;
let lastPhase = '',
  lastFlight = '',
  lastTick = -1,
  toastUntil = 0,
  lastRender = 0,
  shownMultiplier = '';
const announced = new Set<string>();
const message = (text: string, error = false) => {
  $('status').textContent = text;
  $('status').dataset.error = String(error);
};
const persist = () => (saved ? localStorage.setItem(scope, JSON.stringify(saved)) : localStorage.removeItem(scope));
const amount = (value: string | bigint) => HookedIn.formatAmount(value, 6);
const ownTicket = () => view?.tickets.find(t => t.bet === saved?.bet || t.uname === uname);
const fresh = () => Boolean(view) && performance.now() - arrivedAt < 1_800;
const serverNow = () => (view?.now ?? Date.now()) + Math.min(performance.now() - arrivedAt, 1_800);
/** The multiplier on screen: the room's, carried forward between its updates. */
const multiplierNow = () =>
  view?.phase === 'flying' ? multiplierAt(serverNow() - view.startsAt) : view?.phase === 'ended' ? view.point! : 100;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`./api${path}`, {
    ...(body === undefined
      ? {}
      : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    signal: AbortSignal.timeout(8_000),
    cache: 'no-store',
  });
  const value = await response.json().catch(() => null);
  if (!response.ok || !value)
    throw Object.assign(new Error(value?.error || 'The room is unavailable.'), { status: response.status });
  return value;
}

function setView(next: FlightView) {
  view = next;
  arrivedAt = performance.now();
  if (next.id !== lastFlight) {
    announced.clear();
    lastPhase = '';
    lastFlight = next.id;
    lastTick = -1;
    toastUntil = 0;
    toastBox.hidden = true;
  }
  if (next.phase === 'ended' && next.secret) {
    const valid = verifyFlight({ id: next.id, secret: next.secret, point: next.point! }, next.id);
    if (!valid) {
      proofFault = true;
      message('This flight’s secret does not match its ID. Betting is paused.', true);
    }
  }
  if (lastPhase !== next.phase) {
    if (next.phase === 'flying') {
      sound.tone(140, 0, 0.45, { type: 'triangle', to: 600, gain: 0.07 });
      sound.noise(0, 0.5, 0.045, 900);
    }
    if (next.phase === 'ended') sound.tone(110, 0, 0.5, { to: 45, gain: 0.06 });
    lastPhase = next.phase;
  }
  for (const ticket of next.tickets) {
    if (ticket.status !== 'escaped' || announced.has(ticket.bet)) continue;
    announced.add(ticket.bet);
    if (next.phase === 'flying')
      toast(
        `${ticket.uname === uname ? 'You' : ticket.alias ? '@' + ticket.alias : '~' + ticket.uname} escaped at ${multiplierText(ticket.multiplier!)}`,
      );
  }
  renderCrew();
  renderHistory();
  render();
}

function toast(text: string) {
  toastBox.textContent = text;
  toastBox.hidden = false;
  toastUntil = performance.now() + 3_200;
}

function renderCrew() {
  if (!view) return;
  const tickets = view.tickets;
  $('crew-count').textContent = String(tickets.length);
  $('escaped-count').textContent = String(tickets.filter(t => t.status === 'escaped').length);
  $('total-staked').textContent = amount(tickets.reduce((sum, t) => sum + BigInt(t.stake), 0n));
  $('flight-id').textContent = `Flight ${view.id.slice(0, 8).toUpperCase()}`;
  if (!tickets.length) {
    $('crew').innerHTML = '<p class="empty-crew">No one aboard this flight.</p>';
    return;
  }
  const cell = (text: string, className = '') => {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    return span;
  };
  $('crew').replaceChildren(
    ...tickets.map(ticket => {
      const row = document.createElement('div');
      row.className = 'crew-row';
      row.dataset.state = ticket.status;
      const pilot = cell('', 'pilot');
      pilot.append(cell(ticket.alias ? '@' + ticket.alias : '~' + ticket.uname, 'name'));
      if (ticket.uname === uname) pilot.append(cell('YOU', 'you'));
      row.append(
        pilot,
        cell(amount(ticket.stake)),
        cell(
          ticket.status === 'escaped'
            ? multiplierText(ticket.multiplier!)
            : ticket.status === 'lost'
              ? 'Crashed'
              : view!.phase === 'boarding'
                ? 'Aboard'
                : 'Flying',
        ),
        cell(ticket.payout === null ? '—' : `${amount(ticket.payout)}${ticket.paid ? '' : ' · pending'}`),
      );
      return row;
    }),
  );
}

function renderHistory() {
  if (!view?.history.length) return;
  const ids = view.history.map(f => f.id).join(':');
  if ($('history').dataset.ids === ids) return;
  $('history').dataset.ids = ids;
  $('history').replaceChildren(
    ...view.history.map(flight => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = multiplierText(flight.point);
      button.dataset.high = String(flight.point >= 200);
      button.title = `Check flight ${flight.id.slice(0, 8).toUpperCase()}`;
      button.addEventListener('click', () => showProof(flight));
      return button;
    }),
  );
}

/** A recent flight, checked here from its revealed secret. */
function showProof(flight: FlightSummary) {
  const dialog = $<HTMLDialogElement>('proof-dialog'),
    valid = verifyFlight(flight, flight.id);
  $('proof-title').textContent =
    `${multiplierText(flight.point)} · ${flight.point === MAX_MULTIPLIER ? 'everyone escaped' : 'crash point'}`;
  $('proof-id').textContent = flight.id;
  $('proof-secret').textContent = flight.secret;
  $('proof-status').textContent = valid
    ? 'Match: this secret gives this flight ID and this crash point.'
    : 'Mismatch: the revealed secret does not give this flight.';
  $('proof-status').dataset.valid = String(valid);
  if (!dialog.open) dialog.showModal();
}

/** What joining now wins at the auto escape, before anyone boards. */
function plan() {
  if (!auto.checked) return 'Escape by hand in flight';
  try {
    const value = HookedIn.parseAmount(stake.value),
      at = Math.round(Number(target.value) * 100);
    if (!(at >= 101 && at <= MAX_MULTIPLIER)) return '';
    return `Profit ${amount(payoutAt(value, at) - BigInt(value))} ETH at ${multiplierText(at)}`;
  } catch {
    return '';
  }
}

/** The escape button follows the rocket: the multiplier, and what escaping now pays. */
function showEscape(multiplier: number) {
  $('action-label').textContent = `Escape ${multiplierText(multiplier)}`;
  $('action-detail').textContent = `${amount(payoutAt(saved!.stake, multiplier))} ETH`;
}

function render() {
  const mine = ownTicket(),
    live = fresh(),
    locked = working || Boolean(saved);
  for (const control of [stake, auto, $<HTMLButtonElement>('half'), $<HTMLButtonElement>('double')])
    control.disabled = locked;
  target.disabled = locked || !auto.checked;
  const escape = view?.phase === 'flying' && mine?.status === 'aboard' && Boolean(saved?.bet);
  let label = 'Join flight',
    detail = plan(),
    disabled = !ready || !live || working || proofFault;
  if (!ready) {
    label = 'Connecting…';
    detail = '';
  } else if (working) {
    label = saved?.escapeRequested ? 'Confirming escape…' : 'Confirming seat…';
    detail = '';
  } else if (saved && !saved.bet) {
    label = 'Resume your bet';
    detail = 'Your seat request is saved';
  } else if (saved && !mine) {
    label = 'Confirming seat…';
    detail = 'Waiting for the room';
    disabled = true;
  } else if (escape) {
    label = detail = '';
  } else if (saved) {
    label = mine?.status === 'escaped' ? 'Escape accepted ✓' : mine?.status === 'lost' ? 'Crashed' : 'Aboard ✓';
    detail =
      mine?.status === 'escaped'
        ? 'Collecting your payout'
        : mine?.status === 'lost'
          ? 'Stake lost'
          : saved.auto !== null
            ? `Auto escape at ${multiplierText(saved.auto)}`
            : 'Escape by hand in flight';
    disabled = true;
  } else if (view?.phase !== 'boarding' || mine) {
    label = mine?.status === 'escaped' ? 'Escaped ✓' : 'Next flight soon';
    detail = view?.phase === 'flying' ? 'Watching this flight' : '';
    disabled = true;
  } else if (view.startsAt - serverNow() < 1_000) {
    label = 'Boarding closed';
    detail = 'Next flight soon';
    disabled = true;
  } else if (view.tickets.length >= MAX_CREW) {
    label = 'Flight is full';
    detail = 'Next flight soon';
    disabled = true;
  }
  if (!live && ready) {
    label = view ? 'Reconnecting…' : 'Connecting…';
    detail = view ? 'Waiting for the room' : '';
  }
  action.disabled = disabled;
  action.dataset.escape = String(escape);
  if (label) {
    $('action-label').textContent = label;
    $('action-detail').textContent = detail;
  } else showEscape(multiplierNow());
  allowance.setBusy(working);
  $('mute').textContent = sound.muted ? 'Sound off' : 'Sound on';
  $('mute').setAttribute('aria-pressed', String(sound.muted));
}

async function receive(receipt: GameReceipt) {
  if (!saved || saved.id !== receipt.id || finishing) return;
  const pending = saved;
  if (receipt.status === 'rejected') {
    saved = null;
    persist();
    message(receipt.reason ?? 'The wallet declined this bet.', true);
    render();
    return;
  }
  if (receipt.kind !== 'developer-bet' || receipt.group !== pending.flight || receipt.stake !== pending.stake) {
    proofFault = true;
    message('The wallet receipt does not match your saved flight bet.', true);
    render();
    return;
  }
  if (receipt.bet && !pending.bet) {
    pending.bet = receipt.bet;
    persist();
  }
  if (receipt.status === 'open') return;
  finishing = true;
  try {
    const current = await api<FlightView>('/flight');
    setView(current);
    if (proofFault) throw new Error('This flight’s secret does not match its ID. Betting is paused.');
    let ticket = current.id === pending.flight ? current.tickets.find(t => t.bet === pending.bet) : undefined;
    if (current.id !== pending.flight) {
      // The room keeps the flights somebody was aboard: one it does not keep never seated this bet.
      const proof = await api<FlightProof>(`/flights/${pending.flight}`).catch(error => {
        if (error.status === 404) return null;
        throw error;
      });
      if (proof && !verifyFlight(proof, pending.flight)) throw new Error('Your flight’s secret does not match its ID.');
      ticket = proof?.tickets.find(t => t.bet === pending.bet);
    }
    if (ticket?.payout === null) throw new Error('The wallet has a payment. Waiting for the flight’s result.');
    const expected = ticket
      ? ticket.status === 'escaped'
        ? payoutAt(pending.stake, ticket.multiplier!)
        : 0n
      : BigInt(pending.stake);
    const paid = BigInt(receipt.payout!);
    if (paid !== expected) {
      proofFault = true;
      throw new Error(`The wallet received ${amount(paid)} ETH; this flight owes ${amount(expected)} ETH.`);
    }
    saved = null;
    persist();
    if (!ticket) message(`Your seat was not accepted. ${amount(paid)} ETH refunded.`);
    else if (ticket.status === 'escaped') {
      message(`Escaped at ${multiplierText(ticket.multiplier!)}. ${amount(paid)} ETH is in your balance.`);
      toast(`Escaped at ${multiplierText(ticket.multiplier!)} · +${amount(paid - BigInt(pending.stake))} ETH`);
      sky.celebrate();
      sound.melody([440, 554, 659, 880], 0.08, { gain: 0.055 });
    } else message(`The rocket crashed before you escaped. ${amount(pending.stake)} ETH lost.`);
  } catch (error: any) {
    message(error.message, true);
  } finally {
    finishing = false;
    render();
  }
}

async function ask() {
  const pending = saved!;
  await receive(
    await HookedIn.developerBet({
      id: pending.id,
      stake: pending.stake,
      group: pending.flight,
      meta: { escapeHash: keccak256(pending.token), auto: pending.auto },
    }),
  );
  if (saved?.id === pending.id && saved.bet) {
    setView(await api<FlightView>('/placed', {}));
    message(
      !ownTicket()
        ? 'Checking your seat. A seat the room does not accept is refunded.'
        : pending.auto !== null
          ? `You’re aboard. Auto escape at ${multiplierText(pending.auto)} holds even if you close the page.`
          : 'You’re aboard. Press Escape before the crash.',
    );
  }
}

async function join() {
  if (!view || view.phase !== 'boarding' || !fresh()) throw new Error('Wait for an open flight.');
  const value = HookedIn.parseAmount(stake.value);
  if (BigInt(value) <= 0n) throw new Error('Choose a positive stake.');
  const chosen = auto.checked ? Math.round(Number(target.value) * 100) : null;
  if (
    chosen !== null &&
    (!/^\d+(\.\d{1,2})?$/.test(target.value) ||
      !Number.isSafeInteger(chosen) ||
      chosen < 101 ||
      chosen > MAX_MULTIPLIER)
  )
    throw new Error('Choose an auto escape from 1.01× to 100×, with up to two decimal places.');
  const current = BigInt((await HookedIn.allowance()).allowance);
  if (BigInt(value) > current) {
    const answer = await HookedIn.requestAllowance({ amount: BigInt(value) - current });
    allowance.update(answer);
    if (BigInt(answer.allowance) < BigInt(value)) throw new Error('Increase your game allowance to cover this seat.');
  }
  // The wallet's dialog can outlast boarding. Read the room again before saving or signing anything.
  setView(await api<FlightView>('/flight'));
  if (view.phase !== 'boarding' || view.startsAt - serverNow() < 1_000)
    throw new Error('Boarding closed while your wallet was open. Join the next flight.');
  saved = {
    id: crypto.randomUUID(),
    flight: view.id,
    stake: value,
    auto: chosen,
    token: '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''),
  };
  persist();
  await ask();
}

async function escape() {
  if (!saved?.bet) return;
  const pending = saved;
  pending.escapeRequested = true;
  persist();
  render();
  const ticket = await api<PublicTicket>('/cashout', {
    flight: pending.flight,
    bet: pending.bet,
    token: pending.token,
  });
  // The wallet's pushed settlement can beat this HTTP reply. Keep the verified receipt's result on screen.
  if (saved?.id !== pending.id) return;
  if (view?.id === pending.flight) {
    view.tickets = view.tickets.map(t => (t.bet === ticket.bet ? ticket : t));
    renderCrew();
  }
  message(`Escape accepted at ${multiplierText(ticket.multiplier!)}. Your wallet is collecting the payout.`);
  toast(`Escape accepted at ${multiplierText(ticket.multiplier!)}`);
}

async function act(work: () => Promise<void>) {
  if (working || proofFault) return;
  working = true;
  sound.unlock();
  render();
  try {
    await work();
  } catch (error: any) {
    message(error.message, true);
  } finally {
    working = false;
    render();
  }
}

async function watch() {
  try {
    setView(await api<FlightView>('/flight'));
    if (saved?.bet && !working && !finishing) {
      const id = saved.id;
      if (saved.escapeRequested && ownTicket()?.status === 'aboard' && view!.phase === 'flying') await act(escape);
      const receipt = await HookedIn.receipt(id);
      if (receipt) await receive(receipt);
    }
  } catch (error: any) {
    if (!fresh())
      message(`Connection interrupted.${saved?.auto ? ' Auto escape remains active.' : ''} ${error.message}`, true);
  }
  render();
  setTimeout(() => {
    void watch();
  }, 500);
}

function animate(time: number) {
  if (time - lastRender > 200) {
    render();
    lastRender = time;
  }
  const phase = view?.phase ?? 'boarding',
    now = serverNow(),
    multiplier = multiplierNow(),
    mine = ownTicket(),
    orbit = phase === 'ended' && multiplier === MAX_MULTIPLIER;
  let title = phase === 'flying' ? 'In flight' : phase === 'ended' ? (orbit ? 'Orbit' : 'Crashed') : 'Boarding',
    caption = '',
    tone = '',
    left = 0;
  if (phase === 'boarding' && view) {
    const seconds = Math.max(0, Math.ceil((view.startsAt - now) / 1000));
    caption = `Take-off in ${seconds}s`;
    left = Math.max(0, (view.startsAt - now) / BOARDING_MS);
    if (seconds !== lastTick && seconds > 0 && seconds <= 3) {
      lastTick = seconds;
      sound.tone(440, 0, 0.08, { gain: 0.03 });
    }
  } else if (mine?.status === 'escaped') {
    caption = `You escaped at ${multiplierText(mine.multiplier!)}`;
    tone = 'win';
  } else if (phase === 'flying' && mine)
    caption = mine.auto === null ? 'Escape before the crash' : `Auto escape at ${multiplierText(mine.auto)}`;
  else if (orbit) caption = 'Everyone aboard escaped';
  else if (phase === 'ended' && mine) {
    caption = 'You didn’t escape';
    tone = 'loss';
  } else if (phase === 'ended') caption = 'Next flight soon';
  if (!fresh()) {
    title = view ? 'Reconnecting' : 'Connecting';
    caption = view ? 'Reconnecting to the room…' : '';
    tone = '';
  }
  stage.dataset.phase = fresh() ? (orbit ? 'orbit' : phase) : 'stale';
  $('phase').textContent = title;
  $('caption').textContent = caption;
  $('caption').dataset.tone = tone;
  $('countdown').style.transform = `scaleX(${left})`;
  const shown = (multiplier / 100).toFixed(2);
  if (shown !== shownMultiplier) {
    $('multiplier').innerHTML = `${shown}<span>×</span>`;
    shownMultiplier = shown;
  }
  if (action.dataset.escape === 'true' && saved && !working && fresh()) showEscape(multiplier);
  if (time > toastUntil) toastBox.hidden = true;
  sky.draw(view, multiplier, time);
  requestAnimationFrame(animate);
}

async function start() {
  try {
    const startup = await HookedIn.initializeGame({ stakeInput: stake });
    uname = startup.wallet.uname;
    scope = startup.scope;
    allowance.update(startup.allowance);
    saved = JSON.parse(localStorage.getItem(scope) ?? 'null');
    ready = true;
    HookedIn.onReceipt(receipt => {
      void receive(receipt);
    });
    if (saved) {
      stake.value = HookedIn.exactAmount(saved.stake);
      auto.checked = saved.auto !== null;
      if (saved.auto !== null) target.value = (saved.auto / 100).toFixed(2);
      const receipt = await HookedIn.receipt(saved.id);
      if (receipt) await receive(receipt);
      else await act(ask);
      if (saved?.bet) setView(await api<FlightView>('/placed', {}));
    } else message('Everyone rides the same rocket. Join, then escape before it crashes.');
  } catch (error: any) {
    message(error.message, true);
  }
  render();
  void watch();
}

/** Halve or double the stake exactly, down to one unit; an unreadable stake is left for the player to fix. */
function scaleStake(up: boolean) {
  try {
    const units = BigInt(HookedIn.parseAmount(stake.value));
    stake.value = HookedIn.exactAmount(up ? units * 2n : units / 2n || 1n);
  } catch {}
  render();
}

action.addEventListener('click', () => {
  void act(saved ? (saved.bet ? escape : ask) : join);
});
$('half').addEventListener('click', () => scaleStake(false));
$('double').addEventListener('click', () => scaleStake(true));
$('mute').addEventListener('click', () => {
  sound.unlock();
  sound.setMuted(!sound.muted);
  render();
});
$('close-proof').addEventListener('click', () => $<HTMLDialogElement>('proof-dialog').close());
for (const input of [stake, target, auto]) input.addEventListener('input', render);
document.addEventListener('keydown', event => {
  if (
    event.code !== 'Space' ||
    event.repeat ||
    (event.target as HTMLElement).closest('input,button,summary,dialog') ||
    action.disabled ||
    action.dataset.escape !== 'true'
  )
    return;
  event.preventDefault();
  void act(escape);
});
render();
requestAnimationFrame(animate);
void start();
