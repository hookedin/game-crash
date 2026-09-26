import { keccak256 } from 'ethers';
import { HookedIn } from '@hookedin/play/sdk/sdk';
import type { GameReceipt } from '@hookedin/play/sdk/sdk';
import { mountBank } from '@hookedin/play/sdk/bank';
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
import type { FlightProof, FlightView, PublicTicket } from './rules.ts';
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
const action = $<HTMLButtonElement>('action');
const bank = mountBank($('bank')),
  sound = createSynth('afterburn:sound');
const sky = createSky($<HTMLCanvasElement>('sky'), matchMedia('(prefers-reduced-motion: reduce)').matches);
let ready = false,
  working = false,
  finishing = false,
  scope = '',
  asset = 'ETH',
  /** The wallet practices, and a seat is a developer bet, placed with ETH: the flight is watched, not boarded. */
  practice = false,
  uname: string | null = null;
let view: FlightView | null = null,
  saved: Saved | null = null,
  arrivedAt = 0,
  net = 0n,
  proofFault = false;
let lastPhase = '',
  lastFlight = '',
  lastTick = -1,
  toastUntil = 0,
  lastRender = 0;
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

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`./api${path}`, {
    ...(body === undefined
      ? {}
      : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    signal: AbortSignal.timeout(8_000),
    cache: 'no-store',
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Flight control is unavailable.');
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
    $('escape-toast').hidden = true;
  }
  if (next.phase === 'ended' && next.secret) {
    const valid = verifyFlight({ ...next, secret: next.secret, point: next.point!, startsAt: next.startsAt! }, next.id);
    if (!valid) {
      proofFault = true;
      message('Flight proof does not match its commitment. Betting is paused.', true);
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
        `${ticket.uname === uname ? 'You' : ticket.alias ? '@' + ticket.alias : '~' + ticket.uname} escaped at ${multiplierText(ticket.multiplier!)}.`,
      );
  }
  renderCrew();
  renderHistory();
  render();
}

function toast(text: string) {
  $('escape-toast').textContent = text;
  $('escape-toast').hidden = false;
  toastUntil = performance.now() + 3_200;
}

function renderCrew() {
  if (!view) return;
  const tickets = view.tickets;
  $('crew-count').textContent = String(tickets.length);
  $('escaped-count').textContent = String(tickets.filter(t => t.status === 'escaped').length);
  $('total-staked').textContent = amount(tickets.reduce((sum, t) => sum + BigInt(t.stake), 0n));
  if (!tickets.length) {
    $('crew').innerHTML =
      '<div class="empty-crew"><span class="empty-orbit">◎</span><strong>The launch pad is open.</strong><p>Be the first aboard. Invite a friend to join the same flight.</p></div>';
    return;
  }
  $('crew').replaceChildren(
    ...tickets.map(ticket => {
      const row = document.createElement('div');
      row.className = 'crew-row';
      row.dataset.state = ticket.status;
      const pilot = document.createElement('span');
      pilot.className = 'pilot';
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.textContent = (ticket.alias ?? ticket.uname).slice(0, 1).toUpperCase();
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = ticket.alias ? '@' + ticket.alias : '~' + ticket.uname;
      pilot.append(avatar, name);
      if (ticket.uname === uname) {
        const you = document.createElement('small');
        you.textContent = 'YOU';
        pilot.append(you);
      }
      const staked = document.createElement('span');
      staked.textContent = amount(ticket.stake);
      const status = document.createElement('span');
      status.className = 'crew-state';
      status.textContent =
        ticket.status === 'escaped'
          ? `${multiplierText(ticket.multiplier!)} ESCAPED`
          : ticket.status === 'lost'
            ? 'FLIGHT LOST'
            : view!.phase === 'boarding'
              ? 'BOARDED'
              : 'IN FLIGHT';
      const payout = document.createElement('span');
      payout.textContent = ticket.payout === null ? '—' : `${amount(ticket.payout)}${ticket.paid ? '' : ' · pending'}`;
      row.append(pilot, staked, status, payout);
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
      button.title = `Check flight ${flight.id.slice(0, 8)}`;
      button.addEventListener('click', () => {
        void showProof(flight.id);
      });
      return button;
    }),
  );
}

async function showProof(id: string) {
  const dialog = $<HTMLDialogElement>('proof-dialog');
  if (!dialog.open) dialog.showModal();
  $('proof-title').textContent = 'Checking flight…';
  $('proof-id').textContent = id;
  $('proof-secret').textContent = 'Loading…';
  $('proof-status').textContent = '';
  try {
    const proof = await api<FlightProof>(`/flights/${id}`),
      valid = verifyFlight(proof, id);
    $('proof-title').textContent =
      `${multiplierText(proof.point)} ${proof.point === MAX_MULTIPLIER ? '· orbit reached' : '· flight ended'}`;
    $('proof-secret').textContent = proof.secret;
    $('proof-status').textContent = valid
      ? 'Commitment matches. This secret produces this crash point.'
      : 'The revealed result does not match the commitment.';
    $('proof-status').dataset.valid = String(valid);
  } catch (error: any) {
    $('proof-title').textContent = 'Recorder unavailable';
    $('proof-status').textContent = error.message;
  }
}

function render() {
  const mine = ownTicket(),
    flying = view?.phase === 'flying',
    live = fresh(),
    locked = working || Boolean(saved) || practice;
  $('connection').textContent = live ? `${practice ? 'WATCHING' : asset} · LIVE ROOM` : 'RECONNECTING';
  $('connection').dataset.live = String(live);
  $('seat-indicator').textContent =
    mine?.status === 'escaped'
      ? 'ESCAPED'
      : mine?.status === 'lost'
        ? 'FLIGHT LOST'
        : mine?.status === 'aboard'
          ? 'ABOARD'
          : saved
            ? 'CONFIRMING'
            : 'STANDBY';
  stake.disabled = $<HTMLButtonElement>('bet-up').disabled = $<HTMLButtonElement>('bet-down').disabled = locked;
  auto.disabled = locked;
  target.disabled = locked || !auto.checked;
  document.querySelectorAll<HTMLButtonElement>('[data-target]').forEach(button => {
    button.disabled = locked;
    button.dataset.selected = String(auto.checked && button.dataset.target === target.value);
  });
  $('auto-note').textContent = auto.checked
    ? 'Your target stays active if you disconnect.'
    : 'Manual flight. Stay connected to escape.';
  let label = 'Join flight ↗',
    detail = 'ONE SHARED FLIGHT',
    disabled = !ready || !live || working || proofFault;
  const escape = flying && mine?.status === 'aboard' && Boolean(saved?.bet);
  if (!ready) label = 'Connecting wallet…';
  else if (practice) {
    label = 'Seats need ETH';
    detail = 'WATCH THE SHARED FLIGHT';
    disabled = true;
  } else if (working) label = saved?.escapeRequested ? 'Confirming escape…' : 'Confirming seat…';
  else if (saved && !saved.bet) {
    label = 'Resume bet request';
    detail = 'RECOVER YOUR SAVED REQUEST';
  } else if (saved && !mine) {
    label = 'Confirming seat…';
    detail = 'WAITING FOR FLIGHT CONTROL';
    disabled = true;
  } else if (escape) {
    label = 'Escape now';
    detail = 'LOCK IN YOUR MULTIPLIER';
  } else if (saved) {
    label =
      mine?.status === 'escaped' ? 'Escape accepted ✓' : mine?.status === 'lost' ? 'Flight ended' : 'You’re aboard ✓';
    detail =
      mine?.payout !== null && mine?.payout !== undefined
        ? 'WAITING FOR WALLET RECEIPT'
        : saved.auto !== null
          ? 'YOUR AUTO ESCAPE IS SET'
          : 'MANUAL ESCAPE · STAY CONNECTED';
    disabled = true;
  } else if (view?.phase !== 'boarding' || mine) {
    label = mine?.status === 'escaped' ? 'Escaped ✓' : 'Next flight soon';
    detail = 'WATCH THE SHARED FLIGHT';
    disabled = true;
  } else if (view.startsAt !== null && view.startsAt - serverNow() < 1_000) {
    label = 'Boarding closed';
    detail = 'GET READY FOR TAKE-OFF';
    disabled = true;
  } else if (view.tickets.length >= MAX_CREW) {
    label = 'Flight is full';
    detail = 'NEXT FLIGHT SOON';
    disabled = true;
  }
  if (!live && ready) {
    label = 'Reconnecting…';
    detail = 'WAITING FOR FLIGHT CONTROL';
  }
  action.disabled = disabled;
  action.dataset.escape = String(escape);
  $('action-label').textContent = label;
  $('action-detail').textContent = detail;
  bank.setBusy(working);
  $('session-net').textContent = `${net > 0n ? '+' : ''}${amount(net)} ${asset}`;
  $('session-net').dataset.positive = String(net > 0n);
  $('sound').textContent = sound.muted ? 'SOUND OFF' : 'SOUND ON';
  $('sound').setAttribute('aria-label', sound.muted ? 'Turn sound on' : 'Turn sound off');
  $('sound').setAttribute('aria-pressed', String(sound.muted));
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
    if (proofFault) throw new Error('The flight proof does not match its commitment. Betting is paused.');
    let ticket = current.id === pending.flight ? current.tickets.find(t => t.bet === pending.bet) : undefined;
    if (current.id !== pending.flight) {
      const proof = await api<FlightProof>(`/flights/${pending.flight}`);
      if (!verifyFlight(proof, pending.flight)) throw new Error('The flight proof does not match your bet.');
      ticket = proof.tickets.find(t => t.bet === pending.bet);
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
      throw new Error(`The wallet received ${amount(paid)} ${asset}; this flight owes ${amount(expected)} ${asset}.`);
    }
    net += paid - BigInt(pending.stake);
    saved = null;
    persist();
    if (!ticket) message(`Your seat was not accepted. ${amount(paid)} ${asset} returned.`);
    else if (ticket.status === 'escaped') {
      message(`Escaped at ${multiplierText(ticket.multiplier!)}. ${amount(paid)} ${asset} received in your wallet.`);
      toast(`ESCAPED ${multiplierText(ticket.multiplier!)} · ${amount(paid)} ${asset} returned`);
      sky.celebrate();
      sound.melody([440, 554, 659, 880], 0.08, { gain: 0.055 });
    } else message(`Flight ended. Your ${amount(pending.stake)} ${asset} stake was lost.`);
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
      ownTicket()
        ? 'Your seat is in. Escape before the rocket burns out.'
        : 'Checking admission. Any unaccepted stake is returned.',
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
  const limit = BigInt((await HookedIn.balance()).balance);
  if (BigInt(value) > limit) {
    const funded = await HookedIn.requestFunds({ amount: BigInt(value) - limit });
    bank.update(funded);
    if (BigInt(funded.balance) < BigInt(value)) throw new Error('Add enough funds for your seat.');
  }
  // A funding dialog can outlast boarding. Read the room again before saving or signing anything.
  setView(await api<FlightView>('/flight'));
  if (view.phase !== 'boarding' || (view.startsAt !== null && view.startsAt - serverNow() < 1_000))
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
  message(`Escape accepted at ${multiplierText(ticket.multiplier!)}. Waiting for your wallet’s receipt.`);
  toast(`ESCAPE ACCEPTED · ${multiplierText(ticket.multiplier!)}`);
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
    now = serverNow();
  const multiplier = phase === 'flying' ? multiplierAt(now - view!.startsAt!) : phase === 'ended' ? view!.point! : 100;
  $('stage').dataset.phase = phase;
  $('flight-id').textContent = `FLIGHT ${view?.id.slice(0, 8).toUpperCase() ?? '—'}`;
  $('multiplier').innerHTML = `${(multiplier / 100).toFixed(2)}<span>×</span>`;
  let title = 'LAUNCH PAD',
    label = 'READY WHEN YOU ARE',
    caption = 'Find your seat. The sky is shared.';
  if (phase === 'boarding' && view?.startsAt) {
    const seconds = Math.max(0, Math.ceil((view.startsAt - now) / 1000));
    label = 'PREPARE FOR TAKE-OFF';
    caption = `Boarding closes in ${seconds}s. Crew, get ready.`;
    title = `BOARDING · ${seconds}s`;
    $('boarding-progress').style.transform = `scaleX(${Math.max(0, (view.startsAt - now) / BOARDING_MS)})`;
    $('boarding-progress').style.width = '100%';
    if (seconds !== lastTick && seconds > 0 && seconds <= 3) {
      lastTick = seconds;
      sound.tone(440, 0, 0.08, { gain: 0.03 });
    }
  } else {
    $('boarding-progress').style.width = '0';
  }
  if (phase === 'flying') {
    title = 'IN FLIGHT';
    label = multiplier >= 500 ? 'INTO THE STRATOSPHERE' : 'THRUST IS BUILDING';
    caption = 'Your exit. Your call.';
  }
  if (phase === 'ended') {
    title = view?.point === MAX_MULTIPLIER ? 'ORBIT REACHED' : 'FLIGHT ENDED';
    label = view?.point === MAX_MULTIPLIER ? 'EVERYONE ABOARD ESCAPED' : 'CRASH POINT';
    caption = 'Flight recorded. Check the result below.';
  }
  if (!fresh() && ready) {
    title = 'SIGNAL INTERRUPTED';
    caption = 'Reconnecting to flight control…';
  }
  $('phase').textContent = title;
  $('readout-label').textContent = label;
  $('flight-caption').textContent = caption;
  $('stage-note').textContent =
    phase === 'flying'
      ? 'Cash-outs use the server’s multiplier.'
      : phase === 'ended'
        ? 'Select a result in the flight recorder to verify.'
        : '8 seconds to board · escape up to 100×';
  if (action.dataset.escape === 'true' && !working && fresh())
    $('action-label').textContent = `Escape ${multiplierText(multiplier)}`;
  if (time > toastUntil) $('escape-toast').hidden = true;
  sky.draw(view, multiplier, time);
  requestAnimationFrame(animate);
}

async function start() {
  try {
    const startup = await HookedIn.initializeGame({
      stakeInput: stake,
      assetLabels: document.querySelectorAll('[data-asset]'),
    });
    asset = startup.asset;
    practice = startup.practice;
    uname = startup.wallet.uname;
    scope = startup.scope;
    bank.update(startup.state);
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
    } else
      message(
        practice
          ? 'The rocket flies with ETH. Watch the shared flight here, and set up your wallet with ETH to take a seat.'
          : 'Choose your stake and an exit plan. Everyone shares the flight.',
      );
  } catch (error: any) {
    message(error.message, true);
  }
  render();
  void watch();
}

action.addEventListener('click', () => {
  void act(saved ? (saved.bet ? escape : ask) : join);
});
$('bet-up').addEventListener('click', () => HookedIn.stepStake(stake, true));
$('bet-down').addEventListener('click', () => HookedIn.stepStake(stake, false));
$('sound').addEventListener('click', () => {
  sound.unlock();
  sound.setMuted(!sound.muted);
  render();
});
$('close-proof').addEventListener('click', () => $<HTMLDialogElement>('proof-dialog').close());
auto.addEventListener('change', render);
target.addEventListener('input', render);
document.querySelectorAll<HTMLButtonElement>('[data-target]').forEach(button =>
  button.addEventListener('click', () => {
    target.value = button.dataset.target!;
    auto.checked = true;
    render();
  }),
);
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
