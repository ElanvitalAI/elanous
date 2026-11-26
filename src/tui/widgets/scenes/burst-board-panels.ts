/**
 * Burst Board — framed-panel layout for 140..200 columns × 40..60 rows (primary 160×50), in the tui-widgets-demo
 * look: titled boxes, gauges with threshold marks, sparklines, chips. Pure: snapshot + size + frame → toned rows.
 * Every motion comes from the snapshot (B1 rule); the frame only tweens dots and badges between two refreshes.
 */
import { renderFlowLane, renderHandGrid, renderTicker } from '../index.js';
import { besides, chip, fitRow, gaugeSegs, paintRow, panel, rowText, sparkSegs, type Row, type Seg, type Tone } from '../panel.js';
import { cells, clean, num } from '../text.js';
import { BURST_FRAMES, EXIT_STEPS, type BurstBoardSnapshot } from './burst-board.js';

export type PanelOverlay = { readonly kind: 'plan' } | { readonly kind: 'help' } | { readonly kind: 'confirm'; readonly text: string } | { readonly kind: 'note'; readonly text: string };

const KEYS: ReadonlyArray<readonly [string, string]> = [['b', 'burst'], ['p', 'plan'], ['x', 'exit'], ['?', 'help'], ['q', 'quit']];

const clockOf = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
};

function headerBand(s: BurstBoardSnapshot, width: number): Row {
  const busy = s.mode === 'burst' || s.mode === 'exiting';
  const band: Tone = busy ? 'hot' : 'calm';
  const dot = busy ? '●' : s.tick % 2 === 0 ? '●' : '○';
  const left = s.mode === 'calm' ? `${dot} Burst Board · Calm · rhythm ${num(s.rhythmMin)}m`
    : s.mode === 'done' ? `${dot} Burst Board · Burst ended · back to calm`
      : s.mode === 'exiting' ? `${dot} EXIT ${s.exitStep ?? 1}/4 · ${EXIT_STEPS[(s.exitStep ?? 1) - 1]}`
        : `${dot} BURST ${s.preset ?? ''} · ${clockOf(s.elapsedSec)} / ${clockOf(s.totalSec)}${s.trigger ? ` · trigger: ${clean(s.trigger)}` : ''}`;
  const right = `${s.release}${s.source === 'replay' ? ' · replay' : s.source === 'live' ? ' · live' : ''}${s.clock ? ` · ${s.clock}` : ''} `;
  const progress = busy ? Math.round((Math.min(1, s.elapsedSec / Math.max(1, s.totalSec))) * 20) : 0;
  const bar = busy ? ` ${'▰'.repeat(progress)}${'▱'.repeat(20 - progress)} ` : '';
  const used = cells(` ${left}`) + cells(bar) + cells(right);
  return fitRow([[` ${left}`, band], [bar, band], [' '.repeat(Math.max(1, width - used)), band], [right, band]], width, band);
}

function topPanels(s: BurstBoardSnapshot, width: number): Row[] {
  const w4 = Math.floor((width - 3) / 4);
  const last = width - 3 - w4 * 3;
  const p = s.pressure;
  const pTone: Tone = p === null ? 'd' : p >= s.pressureAlarm ? 'r' : p >= s.pressureAlarm * 0.8 ? 'a' : 'g';
  const pressure = panel({ title: 'Pressure', right: `alarm ${s.pressureAlarm.toFixed(2)}`, width: w4, height: 5 }, [
    [...gaugeSegs(p, w4 - 12, pTone, s.pressureAlarm), [p === null ? '  no data' : `  ${p.toFixed(2)}`, p === null ? 'd' : pTone]],
    p !== null && p >= s.pressureAlarm ? [chip('PRESSURE', 'r'), [' bottleneck chain stepping', 'd']] : [[p === null ? 'planner had no signals' : 'within target', 'd']],
    [[`lanes ${s.pressures?.filter((x) => x.pressure !== null).length ?? 0}/${s.pressures?.length ?? 0} measured`, 'd']],
  ]);
  const fc = s.forecast === 'no data' ? 'd' : s.forecastOk ? 'g' : 'r';
  const deadline = panel({ title: 'Deadline', right: clean(s.deadline), width: w4, height: 5 }, [
    [['forecast ', 'd'], [clean(s.forecast), fc], [s.forecast === 'no data' ? '' : s.forecastOk ? ' ✓' : ' ✗', fc]],
    s.forecastWas ? [['was ', 'd'], [clean(s.forecastWas), 'r'], [' ✗ before burst', 'd']] : [['no burst running', 'd']],
    [['remaining work ÷ landed/h vs the cut', 'd']],
  ]);
  const ratio = s.ceilingUsd > 0 ? s.spendUsd / s.ceilingUsd : null;
  const spend = panel({ title: 'Spend', right: s.ceilingUsd > 0 ? `ceiling $${num(s.ceilingUsd)}` : 'no burst', width: w4, height: 5 }, [
    [...gaugeSegs(ratio, w4 - 14, ratio !== null && ratio > 0.8 ? 'a' : 'c'), [`  $${s.spendUsd.toFixed(2)}`, 'w']],
    [[s.hosts.some((h) => h.sim) ? 'cloud tiles are sim · no paid VM' : 'local + LAN only', 'd']],
    [[s.burstId ? clean(s.burstId) : '—', 'd']],
  ]);
  const landed = s.landedPerHour.at(-1);
  const thr = panel({ title: 'Throughput', right: `target ${num(s.landTarget)}/h`, width: last, height: 5 }, [
    [['landed/h ', 'd'], ...sparkSegs(s.landedPerHour, s.landTarget), [landed === undefined ? '' : `  ${num(landed)}`, landed !== undefined && landed >= s.landTarget ? 'g' : 'w'],
      [landed !== undefined && landed >= s.landTarget ? ' ✓ above target' : '', 'g']],
    [['green/h  ', 'd'], ...sparkSegs(s.greenPerHour, undefined, s.landTarget), [s.greenPerHour.length ? `  ${num(s.greenPerHour.at(-1)!)}` : '', 'w']],
    [['rolling 1h window · sampled every 8m', 'd']],
  ]);
  return besides([pressure, deadline, spend, thr]);
}

function pipelinePanel(s: BurstBoardSnapshot, width: number, height: number, frame: number): Row[] {
  const flowW = Math.max(16, Math.floor(width * 0.28));
  const head: Row = [[`${'Lane'.padEnd(12)}${'now → plan'.padEnd(13)}${'queue'.padStart(6)}${'wait'.padStart(7)}${'lead'.padStart(6)}${'pressure'.padStart(10)}   `, 'd'], [`flow →${' '.repeat(flowW - 6)}  `, 'd'], ['planner says', 'd']];
  const rows: Row[] = [head];
  const fmt = (v: number | undefined, unit = '') => (v === undefined ? '—' : `${num(v)}${unit}`);
  s.lanes.forEach((lane, i) => {
    const tone: Tone = lane.bottleneck ? 'r' : lane.now === undefined ? 'd' : (lane.plan ?? lane.now) > lane.now ? 'a' : 'g';
    const items = (lane.queue ?? 0) + (s.mode === 'exiting' ? 0 : lane.now ?? 0);
    const flow = renderFlowLane({ items, speed: lane.speed, blocked: lane.bottleneck, tick: s.tick + i, frame }, flowW);
    const flowSegs: Seg[] = [...flow].map((ch) => [ch, ch === '▓' ? 'r' : ch === '•' ? (s.mode === 'burst' ? 'h' : 'c') : 'k'] as Seg);
    const badge: Seg = lane.steppedBy && frame < BURST_FRAMES / 2 ? chip(`▲ +${lane.steppedBy} ${lane.label.toLowerCase()}`, 'a')
      : lane.bottleneck ? chip('▲ bottleneck', 'r') : lane.now === undefined ? ['no data', 'd'] : (lane.plan ?? lane.now) > lane.now ? ['▲ step queued', 'a'] : ['═', 'g'];
    const pr = lane.pressure;
    rows.push([
      [` ${i + 1} `, 'd'], [lane.label.padEnd(9), 'w'],
      [`${fmt(lane.now).padStart(3)} → ${fmt(lane.plan).padEnd(6)}`, tone],
      [fmt(lane.queue).padStart(6), lane.queue !== undefined && lane.queue > 6 ? 'a' : 't'],
      [fmt(lane.waitMin, 'm').padStart(7), 't'], [fmt(lane.leadMin, 'm').padStart(6), 'd'],
      [(pr === undefined || pr === null ? 'no data' : pr.toFixed(2)).padStart(10), pr === undefined || pr === null ? 'd' : pr >= 1.5 ? 'r' : pr >= 1 ? 'a' : 'g'], ['   '],
      ...flowSegs, ['  '], badge, [lane.note ? `  ${clean(lane.note)}` : '', 'd'],
    ]);
    if (lane.widened && rows.length < height - 2) {
      const second = renderFlowLane({ items: Math.ceil(items / 2), speed: lane.speed, tick: s.tick + i + 3, frame }, flowW);
      rows.push([[' '.repeat(57)], ...[...second].map((ch) => [ch, ch === '•' ? 'c' : 'k'] as Seg), ['  widened', 'd']]);
    }
  });
  const stepping = s.plan?.find((d) => d.to > d.from && !d.blocked);
  return panel({ title: 'Pipeline · front → back', right: stepping ? `next step: ${stepping.lane} +${stepping.to - stepping.from}` : s.plan ? 'planner: no step' : 'planner: no data', width, height,
    rightTone: stepping ? 'a' : 'd' }, rows);
}

function handsPanel(s: BurstBoardSnapshot, width: number, height: number, frame: number): Row[] {
  if (s.handsMeasured === false) return panel({ title: 'Hands', right: 'no data', width, height }, [[['hand pool not readable this refresh — no data', 'd']]]);
  const working = s.hands.filter((h) => h.state === 'busy' || h.state === 'new').length;
  const fresh = s.hands.filter((h) => h.state === 'new').length;
  const body: Row[] = [[['', 't']]];
  const big = height >= 12;
  if (!big) {
    const grid = renderHandGrid({ hands: s.hands, frame, frames: BURST_FRAMES, maxRows: height - 4 }, width - 4);
    for (const line of grid) body.push([[' '], ...[...line].map((ch) => [ch, ch === '▪' ? (s.mode === 'burst' ? 'h' : 'g') : ch === '+' ? 'a' : ch === '·' ? 'k' : 't'] as Seg)]);
  } else {
    const hosts: string[] = [];
    for (const h of s.hands) if (!hosts.includes(h.host)) hosts.push(h.host);
    const perRow = Math.max(4, Math.floor((width - 14) / 4));
    for (const host of hosts) {
      const mine = s.hands.filter((h) => h.host === host);
      for (let i = 0; i < mine.length; i += perRow) {
        const tiles: Seg[] = [[i === 0 ? ` ${host.padEnd(9)}` : ' '.repeat(10), 'w']];
        for (const h of mine.slice(i, i + perRow)) {
          const early = frame < BURST_FRAMES / 2;
          const [glyph, tone]: [string, Tone] = h.state === 'busy' ? ['███', s.mode === 'burst' ? 'h' : 'g'] : h.state === 'new' ? (early ? [' + ', 'a'] : ['███', 'a'])
            : h.state === 'closing' ? (early ? ['░░░', 'k'] : ['   ', 'k']) : ['░░░', 'k'];
          tiles.push([glyph, tone], [' ']);
        }
        const claimed = frame < BURST_FRAMES / 2 ? mine.filter((h) => h.state === 'new' && h.task).map((h) => h.task!).slice(0, 3) : [];
        if (i === 0 && claimed.length) tiles.push([` ${claimed.join(' ')}`, 'a']);
        body.push(tiles);
        if (height >= 30) body.push([[' '.repeat(10)], ...tiles.slice(1).filter(([t]) => t !== ' ' && !t.startsWith(' C-')).flatMap((seg) => [seg, [' '] as Seg])]);
        if (body.length < height - 5) body.push([['']]);
      }
    }
  }
  body.push([['']]);
  body.push([['█ working  ', 'd'], ['+ new  ', 'a'], ['░ idle / closing', 'k']]);
  return panel({ title: 'Hands', right: `${working} working / ${s.hands.length} open${fresh ? ` · +${fresh}` : ''}`, width, height, rightTone: fresh ? 'a' : 'd' }, body);
}

function hostsPanel(s: BurstBoardSnapshot, width: number, height: number): Row[] {
  if (s.hostsMeasured === false || !s.hosts.length) return panel({ title: 'Hosts', right: 'no data', width, height }, [[['RES capacity not readable this refresh — no data', 'd']]]);
  const body: Row[] = [[['local first → LAN → cloud', 'd']]];
  for (const h of s.hosts) {
    const name = `${h.name}${h.sim ? ' sim' : ''}`.padEnd(11);
    const kind = (h.kind === 'cloud' ? 'cloud' : h.kind).padEnd(6);
    if (h.state === 'off') { body.push([[` ${name}`, 'w'], [kind, 'd'], ['○ off', 'k']]); continue; }
    if (h.state === 'card') { body.push([[` ${name}`, 'w'], [kind, 'd'], chip('$? card', 'a'), [' cloud needs CEO money card', 'a']]); continue; }
    const ratio = h.used / Math.max(1, h.cap);
    const tone: Tone = ratio >= 1 ? 'r' : ratio >= 0.75 ? 'a' : 'g';
    body.push([[` ${name}`, 'w'], [kind, 'd'], ...gaugeSegs(ratio, 10, tone), [` ${num(h.used)}/${num(h.cap)}`.padEnd(7), tone], [ratio >= 1 ? 'cap ' : '    ', 'r'],
      [h.load === undefined ? '' : `load ${num(h.load)}  `, 'd'], [h.role ? clean(h.role) : '', 't'], [h.next && s.tick % 2 === 0 ? '  ← next' : '', 'a']]);
  }
  return panel({ title: 'Hosts', right: `${s.hosts.filter((h) => h.state === 'cap' || h.used >= h.cap).length} at cap`, width, height }, body);
}

function hostTile(s: BurstBoardSnapshot, h: BurstBoardSnapshot['hosts'][number], width: number): Row[] {
  const title = `${h.name}${h.sim ? ' · sim' : ''}`;
  const ratio = h.used / Math.max(1, h.cap);
  const tone: Tone = h.state === 'off' ? 'k' : h.state === 'card' ? 'a' : ratio >= 1 ? 'r' : ratio >= 0.75 ? 'a' : 'g';
  const border: Tone = h.next && s.tick % 2 === 0 ? 'a' : h.state === 'card' ? 'a' : 'b';
  if (h.state === 'off') return panel({ title, right: h.kind, width, height: 6, border }, [[['○ off', 'k']], [['']], [[h.kind === 'cloud' ? 'after local + LAN cap' : '', 'd']]]);
  if (h.state === 'card') return panel({ title, right: h.kind, width, height: 6, border }, [[chip('$? card', 'a')], [['cloud needs the CEO money card', 'a']], [['press v (FU 0.3.38)', 'd']]]);
  return panel({ title, right: `${h.kind}${h.next && s.tick % 2 === 0 ? ' · ← next' : ''}`, width, height: 6, border, rightTone: h.next ? 'a' : 'd' }, [
    [...gaugeSegs(ratio, Math.max(4, width - 12), tone), [` ${num(h.used)}/${num(h.cap)}`, tone]],
    [[ratio >= 1 ? 'at cap' : `${num(h.cap - h.used)} free`, ratio >= 1 ? 'r' : 'g'], [h.load === undefined ? '' : ` · load ${num(h.load)}`, 'd']],
    [[h.role ? clean(h.role) : '', 't']],
  ]);
}

function overlayPanel(s: BurstBoardSnapshot, o: PanelOverlay, width: number, height: number, planTitle?: string): Row[] {
  if (o.kind === 'help') {
    return panel({ title: 'Help', width, height, border: 'c' }, [
      [['b', 'c'], ['  start a burst (preset 4h) — test universe only, asks y/n first', 't']],
      [['p', 'c'], ['  plan preview: the planner rows (eln pulse burst plan) — read only', 't']],
      [['x', 'c'], ['  exit the burst: stop launches · close by exact id · receipt — asks y/n first', 't']],
      [['q', 'c'], ['  quit the board (nothing changes)', 't']],
      [['']],
      [['Every number comes from the burst planner, fed-state and RES. «no data» = that source was not readable.', 'd']],
    ]);
  }
  if (o.kind === 'plan') {
    const rows: Row[] = [[['Pressures', 'w']]];
    for (const p of s.pressures ?? []) rows.push([[`  ${p.lane.padEnd(8)}`, 'c'], [(p.pressure === null ? 'no data' : p.pressure.toFixed(2)).padEnd(9), p.pressure === null ? 'd' : p.pressure >= 1.5 ? 'r' : 'g'], [clean(p.why), 'd']]);
    rows.push([['']], [['Plan', 'w']]);
    if (!s.plan?.length) rows.push([['  no step — every lane is inside its target', 'd']]);
    for (const d of s.plan ?? []) rows.push([[`  ${d.lane.padEnd(8)}`, 'c'], [`${d.from} → ${d.to}`.padEnd(9), d.blocked ? 'd' : 'a'], [d.blocked ? `held: ${d.blocked} · ` : '', 'a'], [clean(d.why), 'd']]);
    return planTitle ? panel({ title: planTitle, right: 'eln pulse burst plan', width, height }, rows) : panel({ title: 'Plan preview · eln pulse burst plan', right: 'p / Esc to close', width, height, border: 'c' }, rows);
  }
  return panel({ title: o.kind === 'confirm' ? 'Confirm' : 'Note', width, height, border: 'a' }, [[[clean(o.text), o.kind === 'confirm' ? 'a' : 't']]]);
}

function receiptRows(s: BurstBoardSnapshot): Row[] {
  const r = s.receipt!;
  return [
    [chip('RECEIPT', 'g'), [`  burst ${clean(r.durationLabel)} · forecast ${clean(r.forecast)}`, 'w']],
    [[`  landed ${num(r.landed)} · spend ${clean(r.spend)} · launches closed ${num(r.handsClosed)} · VMs off ${r.vmsOff.length ? r.vmsOff.map(clean).join(', ') : 'none'}`, 't']],
    [['  every launched resource released ✓', 'g']],
  ];
}

/** Full framed board: exactly `height` rows of `width` cells. */
export function renderBurstPanels(s: BurstBoardSnapshot, width: number, height: number, frame = 0, overlay?: PanelOverlay): Row[] {
  const f = Math.max(0, Math.min(BURST_FRAMES - 1, Math.floor(frame)));
  const out: Row[] = [headerBand(s, width), ...topPanels(s, width)];
  const pipeH = Math.min(height >= 70 ? 18 : 14, 3 + s.lanes.length + s.lanes.filter((l) => l.widened).length);
  out.push(...pipelinePanel(s, width, pipeH, f));
  const eventsH = s.receipt ? 6 : 4;
  const midH = height - out.length - eventsH - 1;
  const leftW = Math.floor((width - 1) * 0.5);
  if (overlay) out.push(...overlayPanel(s, overlay, width, midH));
  else if (height >= 70 && s.hosts.length) {
    const n = s.hosts.length;
    const tw = Math.floor((width - (n - 1)) / n);
    const tiles = s.hosts.map((h, i) => hostTile(s, h, i === n - 1 ? width - (n - 1) - tw * (n - 1) : tw));
    out.push(...besides(tiles));
    const hw = Math.floor((width - 1) * 0.58);
    out.push(...besides([handsPanel(s, hw, midH - 6, f), overlayPanel(s, { kind: 'plan' }, width - 1 - hw, midH - 6, 'Planner · live rows')]));
  } else out.push(...besides([handsPanel(s, leftW, midH, f), hostsPanel(s, width - 1 - leftW, midH)]));
  const ticker = renderTicker({ events: s.events, fresh: s.freshEvent, frame: f, frames: BURST_FRAMES }, width - 4);
  const evBody: Row[] = [[[ticker || 'no events yet', ticker ? 't' : 'd']]];
  if (s.gaps?.length) evBody.push([['no data: ', 'a'], [s.gaps.map(clean).join(' · '), 'd']]);
  if (s.receipt) evBody.unshift(...receiptRows(s));
  out.push(...panel({ title: 'Events', right: s.freshEvent ? 'new' : '', width, height: eventsH, rightTone: 'a' }, evBody));
  const keys: Seg[] = [[' ']];
  for (const [k, label] of KEYS) keys.push([k, 'c'], [` ${label}   `, 'd']);
  out.push(fitRow([...keys, [overlay?.kind === 'confirm' ? `  ${clean(overlay.text)}` : '', 'a']], width, 't'));
  return out.slice(0, height).map((r) => fitRow(r, width));
}

export const paintBoard = (rows: readonly Row[], color: boolean): string[] => rows.map((r) => paintRow(r, color));
export const plainBoard = (rows: readonly Row[]): string[] => rows.map(rowText);
