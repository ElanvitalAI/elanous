// ── Sync selector — Yazi-style 3-column with status bar ──
//
// ┌─ header: breadcrumb path + mode ──────────────────────────┐
// │  Skills           │  Servers        │  Services            │
// │  ◉ * ALL (24)     │  ○ node-b         │  ○ hermes            │
// │  ◉ ast-grep       │  ◉ minio        │  ◉ openclaw          │
// │  ...              │  ...            │  ...                 │
// ├─ status bar ──────────────────────────────────────────────┤
// │  3 skills → 1 server × 2 services = 6 ops  [Smart]       │
// └─ keybindings ─────────────────────────────────────────────┘
//
// ALL keys work in ALL panes (no "stuck" state):
//   j/k: navigate    space/*: toggle    a: all    Tab/l/h: switch pane
//   1/2/3: mode      Enter: start       q/Esc: cancel

import { syncServers, SERVICE_NAMES, LOCAL_SKILLS_DIR } from './config.js';
import { getLocalSkills, executeSync } from './sync.js';
import { getAllSnapshots } from './db.js';
import chalk from 'chalk';
import { C, ICONS, ansi, initTui, closeTui, readKey, render, termSize, pad, truncate, visibleWidth, timeSince, hLine, showHelp } from './tui.js';
import { dashboardCanUseTty, dashboardTtyRefusalMessage } from './terminal/tty-required.js';
import type { SyncMode, SkillSnapshot, SyncEntry } from './types.js';

const MODES: { id: SyncMode; label: string; color: (s: string) => string }[] = [
  { id: 'clean', label: 'Clean',  color: C.error },
  { id: 'merge', label: 'Merge',  color: C.success },
  { id: 'smart', label: 'Smart',  color: C.highlight },
];

type Pane = 0 | 1 | 2;  // 0=skills, 1=servers, 2=services
const PANE_NAMES = ['Skills', 'Servers', 'Services'] as const;

export interface SyncFlowResult {
  cancelled: boolean;
  skills: string[];
  servers: string[];
  services: string[];
  mode: SyncMode;
}

export async function showSyncSelector(fromDashboard = false): Promise<SyncFlowResult> {
  if (!dashboardCanUseTty()) {
    throw new Error([
      'elanous sync 선택기는 stdin TTY가 있는 자리에서만 시작할 수 있다.',
      dashboardTtyRefusalMessage(),
    ].join('\n'));
  }

  const allSkills = getLocalSkills();
  let snaps: SkillSnapshot[] = [];
  try { snaps = getAllSnapshots(); } catch { /* ok */ }
  const snapMap = new Map<string, Date>();
  for (const s of snaps) {
    const dt = new Date(s.syncedAt);
    const existing = snapMap.get(s.skillName);
    if (!existing || dt > existing) snapMap.set(s.skillName, dt);
  }

  // State
  let focus: Pane = 0;
  let modeIdx = 2; // smart default
  const cursors = [0, 0, 0];
  const offsets = [0, 0, 0];
  const selected = [new Set<string>(), new Set<string>(), new Set<string>()];
  const lists: string[][] = [
    ['* ALL', ...allSkills],
    syncServers(),
    [...SERVICE_NAMES],
  ];
  const statusLog: string[] = [];

  if (!fromDashboard) initTui(true);

  const draw = () => {
    const { rows: tRows, cols: tCols } = termSize();
    const w = tCols - 1;
    const listH = Math.max(3, tRows - 7); // header(2) + status(3) + keys(1) + border(1)
    const paneW = [
      Math.max(20, Math.floor(w * 0.40)),
      Math.max(14, Math.floor(w * 0.28)),
      0,
    ];
    paneW[2] = w - paneW[0]! - paneW[1]! - 2; // -2 for dividers

    const lines: string[] = [];

    // ── Header: breadcrumb + mode (Yazi-style) ──
    const modeParts = MODES.map((m, i) =>
      i === modeIdx ? m.color(`[${m.label}]`) : C.muted(`${i + 1}:${m.label}`),
    ).join(' ');
    const crumb = `${C.info(LOCAL_SKILLS_DIR)} ${C.muted('›')} ${C.bold('sync')}`;
    lines.push(`  ${crumb}${' '.repeat(Math.max(1, w - 45))}${modeParts}`);

    // ── Pane headers (active pane highlighted) ──
    let headerLine = '';
    for (let p = 0; p < 3; p++) {
      const isActive = p === focus;
      const sel = p === 0 ? selected[0]!.size : selected[p]!.size;
      const total = p === 0 ? allSkills.length : lists[p]!.length;
      const title = `${PANE_NAMES[p]} ${sel}/${total}`;
      const pw = paneW[p]!;

      if (isActive) {
        headerLine += C.bold(` ${title}${' '.repeat(Math.max(0, pw - title.length - 1))}`);
      } else {
        headerLine += C.muted(` ${title}${' '.repeat(Math.max(0, pw - title.length - 1))}`);
      }
      if (p < 2) headerLine += C.dim('│');
    }
    lines.push(headerLine);

    // ── List rows ──
    for (let row = 0; row < listH; row++) {
      let rowLine = '';

      for (let p = 0; p < 3; p++) {
        const pw = paneW[p]!;
        const isActive = p === focus;
        const list = lists[p]!;
        const cursor = cursors[p]!;
        const offset = offsets[p]!;

        // Scroll
        if (cursor < offset) offsets[p] = cursor;
        if (cursor >= offset + listH) offsets[p] = cursor - listH + 1;
        const adjOffset = offsets[p]!;

        const idx = adjOffset + row;
        let cell = '';

        if (idx < list.length) {
          const name = list[idx]!;
          const isCur = idx === cursor;
          const isAllItem = p === 0 && name === '* ALL';
          const allSel = selected[0]!.size === allSkills.length;
          const isSel = isAllItem ? allSel : selected[p]!.has(name);

          // Mark
          const mark = isSel ? C.success('◉') : C.muted('○');

          // Label
          let label: string;
          if (isAllItem) {
            label = `* ALL (${allSkills.length})`;
          } else if (p === 0) {
            const snap = snapMap.get(name);
            const age = snap ? C.muted(' ' + timeSince(snap).replace(' ago', '')) : C.warning(' new');
            label = name + age;
          } else {
            label = name;
          }

          // Build cell content
          const content = ` ${mark} ${label}`;

          if (isCur && isActive) {
            cell = C.cursor(pad(truncate(content, pw - 1), pw));
          } else if (isCur && !isActive) {
            cell = C.muted(pad(truncate(` ▸${label}`, pw - 1), pw));
          } else if (isSel) {
            cell = pad(truncate(` ${mark} ${C.success(isAllItem ? `* ALL (${allSkills.length})` : name)}`, pw - 1), pw);
          } else {
            cell = pad(truncate(content, pw - 1), pw);
          }
        } else {
          cell = ' '.repeat(pw);
        }

        rowLine += cell;
        if (p < 2) {
          // Use absolute cursor positioning for dividers
          const rowNum = lines.length + 1;
          const divCol = p === 0 ? paneW[0]! + 1 : paneW[0]! + paneW[1]! + 2;
          rowLine += ansi.moveTo(rowNum, divCol) + C.dim('│');
        }
      }

      lines.push(rowLine);
    }

    // ── Status bar (Yazi bottom bar style) ──
    lines.push(C.dim('─'.repeat(w)));
    const sk = selected[0]!.size;
    const sv = selected[1]!.size;
    const vc = selected[2]!.size;
    const ops = sk * sv * vc;
    const m = MODES[modeIdx]!;
    const ready = sk > 0 && sv > 0 && vc > 0;

    const statusLeft = `${C.text(`${sk}`)} skill${sk !== 1 ? 's' : ''} ${C.muted('→')} `
      + `${C.text(`${sv}`)} server${sv !== 1 ? 's' : ''} ${C.muted('×')} `
      + `${C.text(`${vc}`)} service${vc !== 1 ? 's' : ''}`;
    const statusRight = ready
      ? `${C.bold(`= ${ops} ops`)}  ${m.color(`[${m.label}]`)}`
      : m.color(`[${m.label}]`);

    lines.push(`  ${statusLeft}  ${statusRight}`);

    // Log line (last message)
    const lastLog = statusLog[statusLog.length - 1] || '';
    lines.push(lastLog ? `  ${lastLog}` : '');

    // ── Keybindings (Yazi footer) ──
    lines.push(
      `  ${C.muted('space')}/${C.muted('*')} select  `
      + `${C.muted('a')} all  `
      + `${C.muted('Tab')}/${C.muted('h/l')} pane  `
      + `${C.muted('1/2/3')} mode  `
      + (ready ? `${C.success('Enter')} ${C.success('sync')}` : `${C.muted('Enter')} ${C.muted('sync')}`)
      + `  ${C.muted('q')} cancel`,
    );

    render(lines);
  };

  try {
    while (true) {
      draw();
      const key = await readKey();

      // ── Mode switch (always available) ──
      if (key.name === '1') { modeIdx = 0; continue; }
      if (key.name === '2') { modeIdx = 1; continue; }
      if (key.name === '3') { modeIdx = 2; continue; }

      // ── Pane switch (always available) ──
      if (key.name === 'tab')   { focus = ((focus + 1) % 3) as Pane; continue; }
      if (key.name === 'l' || key.name === 'right') { focus = (Math.min(focus + 1, 2)) as Pane; continue; }
      if (key.name === 'h' || key.name === 'left')  { focus = (Math.max(focus - 1, 0)) as Pane; continue; }

      // ── Navigation in current pane ──
      const list = lists[focus]!;
      switch (key.name) {
        case 'j': case 'down':
          cursors[focus] = Math.min(cursors[focus]! + 1, list.length - 1); break;
        case 'k': case 'up':
          cursors[focus] = Math.max(cursors[focus]! - 1, 0); break;
        case 'g': case 'home':
          cursors[focus] = 0; offsets[focus] = 0; break;
        case 'G': case 'end':
          cursors[focus] = list.length - 1; break;
        case 'pagedown':
          cursors[focus] = Math.min(cursors[focus]! + 10, list.length - 1); break;
        case 'pageup':
          cursors[focus] = Math.max(cursors[focus]! - 10, 0); break;

        // ── Toggle selection ──
        case 'space': case '*': {
          const idx = cursors[focus]!;
          const name = list[idx]!;
          const sel = selected[focus]!;

          if (focus === 0 && name === '* ALL') {
            if (selected[0]!.size === allSkills.length) selected[0]!.clear();
            else allSkills.forEach(s => selected[0]!.add(s));
          } else if (focus === 0) {
            sel.has(name) ? sel.delete(name) : sel.add(name);
          } else {
            sel.has(name) ? sel.delete(name) : sel.add(name);
          }
          // Auto-advance
          cursors[focus] = Math.min(cursors[focus]! + 1, list.length - 1);
          break;
        }

        // ── Select all ──
        case 'a': {
          const sel = selected[focus]!;
          const real = focus === 0 ? allSkills : list;
          if (sel.size === real.length) sel.clear();
          else real.forEach(s => sel.add(s));
          break;
        }

        // ── Confirm ──
        case 'enter': {
          const sk = selected[0]!.size;
          const sv = selected[1]!.size;
          const vc = selected[2]!.size;
          if (sk > 0 && sv > 0 && vc > 0) {
            return {
              cancelled: false,
              skills: [...selected[0]!],
              servers: [...selected[1]!],
              services: [...selected[2]!],
              mode: MODES[modeIdx]!.id,
            };
          }
          const missing: string[] = [];
          if (!sk) missing.push('skills');
          if (!sv) missing.push('servers');
          if (!vc) missing.push('services');
          statusLog.push(C.warning(`${ICONS.warning} Select ${missing.join(', ')} first`));
          break;
        }

        case '?': case '~':
          await showHelp('select-multi'); break;

        case 'q': case 'escape':
          return { cancelled: true, skills: [], servers: [], services: [], mode: 'merge' };

        case 'c':
          if (key.ctrl) { closeTui(); process.exit(130); }
          break;
      }
    }
  } catch (err) {
    closeTui();
    throw err;
  }
}

// ── Sync progress (stays in alt screen) ──
export async function showSyncProgress(
  result: SyncFlowResult,
  onSync: (opts: { servers: string[]; services: string[]; skills: string[]; mode: SyncMode }) => Promise<SyncEntry[]>,
): Promise<void> {
  const mode = MODES.find(m => m.id === result.mode)!;
  const statusLines: string[] = [];

  const drawProgress = () => {
    const { rows: tRows, cols: tCols } = termSize();
    const w = tCols - 1;
    const lines: string[] = [];

    // Header
    lines.push(
      `  ${ICONS.sync} ${C.bold('Syncing')}  `
      + `${result.skills.length} skills ${C.muted('→')} `
      + `${result.servers.length} servers ${C.muted('×')} `
      + `${result.services.length} services  `
      + mode.color(`[${mode.label}]`),
    );
    lines.push(C.dim('─'.repeat(w)));

    // Log lines
    const maxLines = tRows - 4;
    const visible = statusLines.slice(Math.max(0, statusLines.length - maxLines));
    for (const sl of visible) lines.push(`  ${sl}`);
    while (lines.length < tRows - 1) lines.push('');

    lines.push(`  ${C.muted('Syncing...')}`);
    render(lines);
  };

  // Capture console output
  const origLog = console.log;
  console.log = (...args: any[]) => {
    statusLines.push(args.map(a => typeof a === 'string' ? a : String(a)).join(' ').replace(/^\s{2,}/, ' '));
    drawProgress();
  };

  drawProgress();
  statusLines.push(C.muted('Starting...'));
  drawProgress();

  try {
    const entries = await onSync({
      servers: result.servers,
      services: result.services,
      skills: result.skills,
      mode: result.mode,
    });

    const synced = entries.filter(e => e.status === 'synced').length;
    const failed = entries.filter(e => e.status === 'failed').length;
    statusLines.push('');
    statusLines.push(
      C.success(`${ICONS.check} Done: ${synced} synced`)
      + (failed ? C.error(` ${failed} failed`) : ''),
    );
    statusLines.push(C.muted('Press any key to return'));
    drawProgress();
    await readKey();
  } catch (err: any) {
    statusLines.push(C.error(`${ICONS.cross} ${err.message || err}`));
    statusLines.push(C.muted('Press any key to return'));
    drawProgress();
    await readKey();
  } finally {
    console.log = origLog;
  }
}

// Legacy CLI-flag exports
export async function selectServers(): Promise<string[]> {
  const r = await showSyncSelector();
  if (r.cancelled) { closeTui(); process.exit(0); }
  closeTui(); return r.servers;
}
export async function selectServices(): Promise<string[]> { return SERVICE_NAMES; }
export async function selectSkills(): Promise<string[]> { return getLocalSkills(); }
export async function selectSyncMode(): Promise<SyncMode> { return 'merge'; }
