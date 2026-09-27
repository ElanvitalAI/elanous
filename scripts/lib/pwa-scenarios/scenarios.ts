import { randomBytes } from 'node:crypto';
import { readTerminalReplay } from './acp-replay.js';

export type Surface = 'terminal' | 'chat' | 'intake';
export type Step =
  | { kind: 'goto' }
  | { kind: 'waitFor'; selector?: string; jsPredicate?: string; timeoutMs: number; intervalMs?: number; measureChip?: true; withinChipMs?: true }
  | { kind: 'capture'; key: string; js: string; timeoutMs: number }
  | { kind: 'type'; text: string }
  | { kind: 'press'; key: string }
  | { kind: 'click'; selector?: string };

export interface Check {
  /** Expression evaluated in the page; any truthy value passes. */
  js: string;
  expected: string;
  timeoutMs?: number;
  intervalMs?: number;
}

export interface HostCheck {
  js: string;
  expected: string;
  timeoutMs: number;
  intervalMs?: number;
  predicate: (value: unknown, baseUrl: string, captured: Readonly<Record<string, unknown>>) => Promise<boolean>;
}

export interface Scenario {
  id: string;
  surface: Surface;
  path: string;
  title: string;
  steps: Step[];
  expect: Check[];
  hostCheck?: HostCheck[];
  /** Calls a real model (costs a turn). Runs only when named in `--only`. */
  costly?: true;
}

const selector = (css: string): string => `Boolean(document.querySelector(${JSON.stringify(css)}))`;
const tab = 'button[aria-label^="switch to "]';
const terminal = '.xterm';
const connected = '[aria-live="polite"]';
// ChatInput 의 입력창(`apps/pwa/src/components/chat/ChatInput.tsx` placeholder) — testid 가 없어 placeholder 로 고른다.
const chatInput = 'textarea[placeholder^="message"]';
const intakeField = '[data-testid="intake-front-door-field"]';
const terminalIdentity = `(() => { const sessionId = localStorage.getItem('elanous.daemon.sessionId'); const terminalId = Array.from(document.querySelectorAll('button[aria-label^="switch to "]')).find(node => node.title?.includes('지금 보는 터미널'))?.getAttribute('aria-label')?.slice('switch to '.length); return sessionId && terminalId ? { sessionId, terminalId } : null; })()`;
const identity = (value: unknown): { sessionId: string; terminalId: string } | null => {
  if (!value || typeof value !== 'object') return null;
  const { sessionId, terminalId } = value as Record<string, unknown>;
  return typeof sessionId === 'string' && sessionId.length > 0 && typeof terminalId === 'string' && terminalId.length > 0
    ? { sessionId, terminalId } : null;
};

async function replayContains(value: unknown, baseUrl: string, text: string, count: number, readReplay: typeof readTerminalReplay): Promise<boolean> {
  const ids = identity(value);
  if (!ids) return false;
  const snapshot = await readReplay({ baseUrl, ...ids, timeoutMs: 2_000 });
  return snapshot.split(text).length - 1 >= count;
}

/** `--only` picks exactly those IDs; without it, every scenario except the costly ones (they call a real model). */
export function selectScenarios(all: readonly Scenario[], only?: readonly string[]): { selected: Scenario[]; unknown: string[] } {
  const requested = new Set(only ?? all.filter((s) => !s.costly).map((s) => s.id));
  return {
    selected: all.filter((s) => requested.has(s.id)),
    unknown: [...requested].filter((id) => !all.some((s) => s.id === id)),
  };
}

/** Fresh data per invocation: the terminal marker must not match earlier scrollback. */
export function createScenarios(): Scenario[] {
  return createScenariosWithReplay(readTerminalReplay);
}

/** Testable replay seam; production always uses the daemon-backed reader. */
export function createScenariosWithReplay(readReplay: typeof readTerminalReplay): Scenario[] {
  const marker = `pwa-scn-${randomBytes(8).toString('hex')}`;
  const t1bMarker = `pwa-scn-${randomBytes(8).toString('hex')}`;
  // C1 — the answer (n+1) never appears in the question, so finding it on the page means a model replied.
  const c1Base = 1000 + (randomBytes(2).readUInt16BE(0) % 8000);
  return [
    {
      id: 'T1', surface: 'terminal', path: '/app/term/', title: 'xterm and a tab',
      steps: [{ kind: 'goto' }, { kind: 'waitFor', selector: terminal, timeoutMs: 20_000 }, { kind: 'waitFor', selector: tab, timeoutMs: 20_000 }],
      expect: [
        { js: selector(terminal), expected: 'xterm screen is mounted' },
        { js: `document.querySelectorAll(${JSON.stringify(tab)}).length >= 1`, expected: 'at least one terminal tab' },
      ],
    },
    {
      id: 'T1b', surface: 'terminal', path: '/app/term/', title: 'no unknown terminal relationship',
      steps: [
        { kind: 'goto' }, { kind: 'waitFor', selector: terminal, timeoutMs: 20_000 },
        { kind: 'waitFor', selector: tab, timeoutMs: 20_000 },
        { kind: 'waitFor', jsPredicate: `Array.from(document.querySelectorAll(${JSON.stringify(connected)})).some(node => node.textContent?.includes('ACP: 연결됨'))`, timeoutMs: 20_000 },
        { kind: 'click', selector: terminal }, { kind: 'type', text: `echo ${t1bMarker}` }, { kind: 'press', key: 'Enter' },
      ],
      expect: [],
      hostCheck: [{
        js: `(() => { const ids = ${terminalIdentity}; if (!ids) return null; return { ...ids, tabsClean: Array.from(document.querySelectorAll(${JSON.stringify(tab)})).every(node => !node.textContent?.includes('이 행에서는 알 수 없음')), paneClean: Array.from(document.querySelectorAll('[data-pane-relationship]')).every(node => !node.textContent?.includes('관계를 알 수 없어 배치하지 않았습니다')) }; })()`,
        expected: 'two echo markers in replay, no unknown relationship message in terminal replay, pane or tab', timeoutMs: 20_000,
        predicate: async (value, baseUrl) => {
          const ids = identity(value);
          if (!ids) return false;
          const snapshot = await readReplay({ baseUrl, ...ids, timeoutMs: 2_000 });
          return snapshot.split(t1bMarker).length - 1 >= 2
            && !snapshot.includes('관계를 알 수 없어 배치하지 않았습니다')
            && (value as { tabsClean?: unknown; paneClean?: unknown }).tabsClean === true
            && (value as { paneClean?: unknown }).paneClean === true;
        },
      }],
    },
    {
      id: 'T4a', surface: 'terminal', path: '/app/term/', title: 'terminal echo round-trip',
      steps: [
        { kind: 'goto' }, { kind: 'waitFor', selector: terminal, timeoutMs: 20_000 },
        { kind: 'waitFor', selector: tab, timeoutMs: 20_000 },
        { kind: 'waitFor', jsPredicate: `Array.from(document.querySelectorAll(${JSON.stringify(connected)})).some(node => node.textContent?.includes('ACP: 연결됨'))`, timeoutMs: 20_000 },
        { kind: 'click', selector: terminal }, { kind: 'type', text: `echo ${marker}` }, { kind: 'press', key: 'Enter' },
      ],
      expect: [],
      hostCheck: [{ js: terminalIdentity, expected: `replay contains ${marker} twice (input echo and output)`, timeoutMs: 20_000,
        predicate: (value, baseUrl) => replayContains(value, baseUrl, marker, 2, readReplay) }],
    },
    {
      id: 'T5', surface: 'terminal', path: '/app/term/', title: 'terminal reload keeps one shell',
      steps: [{ kind: 'goto' }, { kind: 'waitFor', selector: tab, timeoutMs: 20_000 },
        { kind: 'capture', key: 'first', js: terminalIdentity, timeoutMs: 20_000 },
        { kind: 'goto' }, { kind: 'waitFor', selector: tab, timeoutMs: 20_000 },
        { kind: 'capture', key: 'second', js: terminalIdentity, timeoutMs: 20_000 },
        { kind: 'goto' }, { kind: 'waitFor', selector: tab, timeoutMs: 20_000 },
        { kind: 'capture', key: 'third', js: terminalIdentity, timeoutMs: 20_000 }],
      expect: [],
      hostCheck: [{ js: terminalIdentity, expected: 'same tab ID on three opens and one web-registration row', timeoutMs: 10_000,
        predicate: async (value, baseUrl, captured) => {
          const ids = identity(value);
          const first = identity(captured.first);
          const second = identity(captured.second);
          const third = identity(captured.third);
          if (!ids || !first || !second || !third) return false;
          if (first.terminalId !== second.terminalId || second.terminalId !== third.terminalId || third.terminalId !== ids.terminalId) return false;
          const response = await fetch(`${baseUrl}/v1/terminals`, { headers: { Origin: baseUrl }, signal: AbortSignal.timeout(5_000) });
          if (!response.ok) throw new Error(`terminal list HTTP ${response.status}`);
          const body = await response.json() as { terminals?: Array<{ id?: string; producer?: string }> };
          if (!Array.isArray(body.terminals)) throw new Error('invalid terminal list response');
          return body.terminals.filter((row) => row.producer === 'web-registration' && row.id === ids.terminalId).length === 1;
        } }],
    },
    {
      id: 'C1', surface: 'chat', path: '/app/chat/', title: 'first message streams a model reply', costly: true,
      steps: [{ kind: 'goto' }, { kind: 'waitFor', selector: chatInput, timeoutMs: 20_000 }, { kind: 'click', selector: chatInput }, { kind: 'type', text: `Reply with only the number that is one more than ${c1Base}.` }, { kind: 'press', key: 'Enter' }],
      expect: [{ js: `document.body.innerText.includes(${JSON.stringify(String(c1Base + 1))})`, expected: `a model reply containing ${c1Base + 1} appears`, timeoutMs: 120_000, intervalMs: 1_000 }],
    },
    {
      id: 'C2a', surface: 'chat', path: '/app/chat/', title: 'local meta command help',
      steps: [{ kind: 'goto' }, { kind: 'waitFor', selector: chatInput, timeoutMs: 20_000 }, { kind: 'click', selector: chatInput }, { kind: 'type', text: ':help' }, { kind: 'press', key: 'Enter' }],
      expect: [{ js: `Array.from(document.querySelectorAll('pre')).some(node => node.textContent?.includes('Meta commands'))`, expected: 'message list shows Meta commands', timeoutMs: 10_000 }],
    },
    {
      id: 'C2b', surface: 'chat', path: '/app/chat/', title: 'slash help aliases local meta command',
      steps: [{ kind: 'goto' }, { kind: 'waitFor', selector: chatInput, timeoutMs: 20_000 }, { kind: 'click', selector: chatInput }, { kind: 'type', text: '/help' }, { kind: 'press', key: 'Enter' }],
      expect: [{ js: `Array.from(document.querySelectorAll('pre')).some(node => node.textContent?.includes('Meta commands'))`, expected: 'message list shows Meta commands for /help', timeoutMs: 10_000 }],
    },
    {
      id: 'N1', surface: 'intake', path: '/app/intake/', title: 'empty field disables actions',
      steps: [{ kind: 'goto' }, { kind: 'waitFor', selector: intakeField, timeoutMs: 20_000 },
        ...['intake-absorb', 'intake-split', 'intake-graph'].map((id): Step => ({ kind: 'waitFor', selector: `[data-testid="${id}"]`, timeoutMs: 5_000 }))],
      expect: [{ js: `['intake-absorb','intake-split','intake-graph'].every(id => document.querySelector('[data-testid="' + id + '"]')?.hasAttribute('disabled'))`, expected: 'all three action buttons disabled for empty input' }],
    },
    {
      id: 'N5a', surface: 'intake', path: '/app/intake/', title: 'URL previews absorb without submitting',
      steps: [{ kind: 'goto' }, { kind: 'waitFor', selector: intakeField, timeoutMs: 20_000 }, { kind: 'click', selector: intakeField }, { kind: 'type', text: 'https://example.com' },
        { kind: 'waitFor', jsPredicate: `(() => { const chip = document.querySelector('[data-testid="intake-route-chip"]'); return Boolean(chip && chip.getClientRects().length); })()`, timeoutMs: 5_000, measureChip: true },
        { kind: 'waitFor', jsPredicate: `(() => { const chip = document.querySelector('[data-testid="intake-route-chip"]'); return chip?.getAttribute('data-auto-submit') === '0' && chip.querySelector('[data-testid="intake-route-chip-label"]')?.textContent?.includes('흡수'); })()`, timeoutMs: 5_000, withinChipMs: true }],
      expect: [{ js: `(() => { const chip = document.querySelector('[data-testid="intake-route-chip"]'); return chip?.getAttribute('data-auto-submit') === '0' && chip.querySelector('[data-testid="intake-route-chip-label"]')?.textContent?.includes('흡수'); })()`, expected: 'absorb chip within 5s and data-auto-submit=0', timeoutMs: 0 }],
    },
    {
      id: 'N6a', surface: 'intake', path: '/app/intake/', title: 'unknown rule offers classification without invoking LLM',
      steps: [{ kind: 'goto' }, { kind: 'waitFor', selector: intakeField, timeoutMs: 20_000 }, { kind: 'click', selector: intakeField }, { kind: 'type', text: '안녕' },
        { kind: 'waitFor', selector: '[data-testid="intake-route-chip"]', timeoutMs: 5_000 }],
      expect: [{ js: `(() => { const button = document.querySelector('[data-testid="intake-route-chip"] [data-testid="intake-route-classify"]'); return Boolean(button && button.getClientRects().length); })()`, expected: 'classification button visible; never clicked (no LLM call)', timeoutMs: 5_000 }],
    },
  ];
}

/** Return a canonical loopback origin; disallow credentials, paths and non-local hosts. */
export function validateBaseUrl(input: string, allowPort = false): string {
  const explicit = /^http:\/\/127\.0\.0\.1:(\d+)\/?$/.exec(input);
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('base URL must be http://127.0.0.1:PORT'); }
  const port = Number(explicit?.[1]);
  if (!explicit || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !Number.isInteger(port)
      || port < 1 || port > 65535 || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('base URL must be http://127.0.0.1:PORT');
  }
  if (!allowPort && (port < 31450 || port > 31499 || [31415, 31420, 31421].includes(port))) {
    throw new Error(`port ${port} refused: use isolated daemon port 31450–31499 (or --allow-port)`);
  }
  return `http://127.0.0.1:${port}`;
}
