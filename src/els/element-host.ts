// ELS-ELEMENT-HOST (대표 11-26) — the ONE tab host for every element kind, generalized from obsidian-tab.ts. Two halves:
//   · createElementHost (the pane process `elanous side element host <kind> [key]`): watches the server's overlay stack,
//     draws ITS layer (kind + key) full-pane with the element's own renderer, and turns keys into the same overlay acts the
//     attach view sends (update · close · frame). It holds no state of its own: the layer's props on the server are the
//     state, so a frame switch (tab → popup → tile) never loses anything. It ends when its layer leaves the tab frame or
//     closes. No mouse reporting is turned on (keys only — no mouse-mode escapes anywhere in this file).
//   · createTabHostSync (server side): a layer that entered the tab frame gets one host pane; a layer that left it loses
//     that pane. Panes are found by their command (restart-proof: a restored host pane is not spawned twice).
// To add an element kind: register its ElementDef in elements/index.ts with 'tab' in `frames` — nothing here changes.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitAnsi } from './attach-view.js';
import { elementKeys, elementRenderers } from './elements/index.js';
import type { OverlayLayer, OverlayStack } from './overlay-stack.js';
import type { PopupStyle } from './popup-style.js';

const ESC = '\u001b';
export const ENTER_HOST = `${ESC}[?1049h${ESC}[?25l${ESC}[2J${ESC}[H`;
export const LEAVE_HOST = `${ESC}[?25h${ESC}[?1049l`;
/** ctrl+t — the frame switch key (popup → tile → tab → popup), the same in the attach view and in a tab host. */
export const FRAME_KEY = '\u0014';

export type HostAct =
  | { readonly action: 'update'; readonly id: string; readonly props: unknown }
  | { readonly action: 'close'; readonly id: string }
  | { readonly action: 'frame'; readonly id: string; readonly frame: 'next' };

export interface ElementHostDeps {
  readonly kind: string;
  readonly key: string;
  readonly write: (text: string) => void;
  readonly size: () => { readonly cols: number; readonly rows: number };
  readonly act: (act: HostAct) => void;
  /** ELS-POPUP-STYLE: the same popup style switch as the attach view (simple | fancy) — the host draws its element dressed
   *  the same way, full-pane. Absent = simple. */
  readonly style?: () => PopupStyle;
}

/** One key per item: CSI / SS3 sequences whole, everything else one code point (a terminal read can carry several). */
export const splitKeys = (bytes: string): string[] => bytes.match(/\u001b\[[0-9;?<>]*[ -\/]*[@-~]|\u001bO[@-~]|[\s\S]/gu) ?? [];

/** The pane side. `stack` feeds every pushed stack; it returns true once the host should end (layer gone or not a tab). */
export function createElementHost(deps: ElementHostDeps): { readonly stack: (stack: OverlayStack) => boolean; readonly key: (bytes: string) => void; readonly paint: () => void; readonly layer: () => OverlayLayer | undefined } {
  const renderers = elementRenderers(deps.style ?? (() => 'simple'));
  const keys = elementKeys();
  let layer: OverlayLayer | undefined;
  let waiting = true;
  const paint = (): void => {
    const { cols, rows } = deps.size();
    if (!layer) { deps.write(`${ESC}[H${fitAnsi(waiting ? `Waiting for ${deps.kind}…` : `${deps.kind} closed`, cols)}${ESC}[K`); return; }
    const render = renderers[layer.kind];
    const lines = render ? render(layer, { w: cols, h: rows }, true) : [];
    const out: string[] = [];
    for (let at = 0; at < rows; at++) out.push(fitAnsi(lines[at] ?? '', cols));
    deps.write(`${ESC}[H${out.join('\r\n')}`);
  };
  return {
    paint,
    layer: () => layer,
    stack: (stack) => {
      const mine = stack.layers.find((one) => one.kind === deps.kind && one.key === deps.key);
      if (!mine || mine.frame !== 'tab') { layer = undefined; waiting = false; return true; }
      layer = mine;
      paint();
      return false;
    },
    key: (bytes) => {
      let changed = false;
      for (const key of splitKeys(bytes)) {
        if (!layer) return;
        if (key === FRAME_KEY) { deps.act({ action: 'frame', id: layer.id, frame: 'next' }); continue; }
        if (key === '\u0003') { deps.act({ action: 'close', id: layer.id }); return; }
        const handled = keys[layer.kind]?.(layer, key) ?? 'pass';
        // ELS-FILES «open elsewhere» needs the attach view (new tab · tile · attach to a pane): a tab host keeps the key.
        if (typeof handled === 'object' && 'open' in handled) continue;
        if (typeof handled === 'object') {
          // Optimistic, the attach view's rule: the update merged over the shown props (a dropped `note` field goes).
          const props = { ...(layer.props && typeof layer.props === 'object' ? layer.props as object : {}), ...(handled.update && typeof handled.update === 'object' ? handled.update as object : {}) };
          if (!('note' in (handled.update as object))) delete (props as { note?: unknown }).note;
          layer = { ...layer, props };
          changed = true;
          deps.act({ action: 'update', id: layer.id, props: handled.update });
        } else if (key === ESC) { deps.act({ action: 'close', id: layer.id }); return; }   // Esc closes, as in a popup
      }
      if (changed) paint();
    },
  };
}

/** The argv of a host pane for one element (the tree's own entry: a test-universe server spawns the tree, not an install). */
export function hostCommand(kind: string, key: string, execPath = process.execPath, entry = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'elanous.mjs')): string[] {
  return [execPath, entry, 'side', 'element', 'host', kind, key];
}
/** Does this argv run the host of kind/key? (it ends with `side element host <kind> <key>`) */
export function runsHost(command: readonly string[] | undefined, kind: string, key: string): boolean {
  if (!command || command.length < 5) return false;
  const tail = command.slice(-5);
  return tail[0] === 'side' && tail[1] === 'element' && tail[2] === 'host' && tail[3] === kind && tail[4] === key;
}

/** Server door: may `pane` (a hand pane) send this overlay act? Only a host pane, only for the tab-frame layer it draws
 *  (named by id), only update · close · frame. Everything else goes through the normal act-view tier. */
export function hostPaneMayAct(panes: readonly { readonly id: string; readonly command?: readonly string[] }[], pane: string, stack: OverlayStack | undefined,
  request: { readonly action?: string; readonly id?: string }): boolean {
  if (!pane || !request.id || !stack || (request.action !== 'update' && request.action !== 'close' && request.action !== 'frame')) return false;
  const layer = stack.layers.find((one) => one.id === request.id);
  if (!layer || layer.frame !== 'tab') return false;
  return panes.some((row) => row.id === pane && runsHost(row.command, layer.kind, layer.key));
}

export interface TabHostDeps {
  /** The journal's panes (id · command · state · ptyId: '' = no live PTY, e.g. after a restart without its holder). */
  readonly panes: () => readonly { readonly id: string; readonly command?: readonly string[]; readonly state?: string; readonly ptyId?: string }[];
  readonly newPane: (input: { ws: string; cwd: string; command: string[]; title: string }) => { exitCode: number; message: string };
  readonly close: (pane: string) => void;
  readonly cwd: string;
  readonly command?: (kind: string, key: string) => string[];
  /** Where a host pane opens when the layer names no workspace. */
  readonly defaultWs?: string;
}

// 출처: 대표 11-26 element host — host tabs of layers with no owner workspace gather in one space.
export const ELEMENT_HOST_WS = 'elements';

/** layer id → the host pane that draws it (spawned now, or the live one already there). */
export type TabHosts = ReadonlyMap<string, string>;
export interface TabHostSync {
  /** Spawn / close host panes as layers enter / leave the tab frame; answers which pane draws each entered layer. */
  (change: { readonly entered: readonly OverlayLayer[]; readonly left: readonly OverlayLayer[] }): TabHosts;
  /** ELS-ELEMENT-HOST-FU ② (server start): every tab layer gets a LIVE host — a host pane that came back without its PTY
   *  (no holder survived) is closed and the element is drawn again from the persisted layer; a host pane whose layer is
   *  gone or no longer a tab is closed, and so is an exited host row. Panes that do not run a host (plain shells) are never touched. */
  readonly restore: (layers: readonly OverlayLayer[]) => TabHosts;
}

/** Server side: the host panes of tab-frame layers. */
export function createTabHostSync(deps: TabHostDeps): TabHostSync {
  const command = deps.command ?? ((kind: string, key: string) => hostCommand(kind, key));
  const hostsOf = (layer: Pick<OverlayLayer, 'kind' | 'key'>) => deps.panes().filter((pane) => pane.state !== 'exited' && runsHost(pane.command, layer.kind, layer.key));
  const isLive = (pane: { readonly ptyId?: string }): boolean => pane.ptyId === undefined || pane.ptyId !== '';
  const close = (pane: string): void => { try { deps.close(pane); } catch { /* already gone */ } };
  const spawn = (layer: OverlayLayer): string | undefined => {
    const answer = deps.newPane({ ws: layer.ownerWorkspace ?? deps.defaultWs ?? ELEMENT_HOST_WS, cwd: deps.cwd, command: command(layer.kind, layer.key), title: `◫ ${layer.kind}` });
    if (answer.exitCode !== 0) return undefined;
    try { const pane = (JSON.parse(answer.message) as { pane?: unknown }).pane; return typeof pane === 'string' ? pane : undefined; } catch { return undefined; }
  };
  const ensure = (layer: OverlayLayer, into: Map<string, string>): void => {
    const hosts = hostsOf(layer);
    for (const dead of hosts.filter((pane) => !isLive(pane))) close(dead.id);
    const live = hosts.find(isLive);
    const pane = live?.id ?? spawn(layer);
    if (pane) into.set(layer.id, pane);
  };
  const sync = (change: { readonly entered: readonly OverlayLayer[]; readonly left: readonly OverlayLayer[] }): TabHosts => {
    const out = new Map<string, string>();
    for (const layer of change.left) for (const pane of hostsOf(layer)) close(pane.id);
    for (const layer of change.entered) ensure(layer, out);
    return out;
  };
  const restore = (layers: readonly OverlayLayer[]): TabHosts => {
    const out = new Map<string, string>();
    const tabs = layers.filter((layer) => layer.frame === 'tab');
    for (const pane of [...deps.panes()]) {
      const tail = pane.command?.slice(-5);
      if (!tail || tail[0] !== 'side' || tail[1] !== 'element' || tail[2] !== 'host') continue;     // plain panes: never touched
      // An exited host row is a view that ended with the old server (a fresh host replaces it); a live host whose layer
      // left the tab frame has nothing to draw.
      if (pane.state === 'exited' || !tabs.some((layer) => runsHost(pane.command, layer.kind, layer.key))) close(pane.id);
    }
    for (const layer of tabs) ensure(layer, out);
    return out;
  };
  return Object.assign(sync, { restore });
}
