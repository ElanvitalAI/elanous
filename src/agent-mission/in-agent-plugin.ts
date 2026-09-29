import type { PtyHandle } from '../pty-shell/registry.js';
import { classifierFrameLines } from '../capture/frame-state-detect.js';
import { emitDecision, type DecisionEvent } from '../live/detail-switch.js';
import { debug } from '../debug/log.js';
import { streamLLM, type LLMMessage } from '../llm.js';

export interface PluginRequest { agent: 'codex' | 'claude'; plugin: string; marketplace: string }
export type PluginResult = { outcome: 'installed' } | { outcome: 'escalate'; reason: 'plugins-disabled' | 'unknown-menu' | 'timeout' | 'wrong-target' | 'credentials' };
export interface PluginDeps {
  sleep?: (ms: number) => Promise<void>;
  decide?: (event: DecisionEvent) => unknown;
  log?: (event: string, data: Record<string, unknown>) => void;
  /** Returns a single UI action, not arbitrary bytes. An Enter suggestion is still checked against the visible target. */
  brain?: (screen: string, target: string) => Promise<'up' | 'down' | 'tab' | 'enter' | 'wait' | 'unknown'>;
  write?: (chars: string) => void;
  /** The backend's folder-trust answer (driver passes `backend.handleTrust`). A trust menu can appear late on a folder
   *  opened for the first time — after the driver's own trust pass — so the installer answers it too. */
  handleTrust?: (screen: string, write: (chars: string) => void) => boolean;
}

const IDENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export function parsePluginRef(ref: string): { plugin: string; marketplace: string } | null {
  const parts = ref.split('@');
  return parts.length === 2 && parts.every(part => IDENT.test(part)) ? { plugin: parts[0]!, marketplace: parts[1]! } : null;
}

function lines(screen: string): string[] { return classifierFrameLines(screen); }
function targetLine(line: string, request: PluginRequest, onMarket: boolean): boolean {
  // A bare plugin name is only unambiguous inside a visibly selected marketplace tab.
  const name = request.plugin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const market = request.marketplace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)${name}(?:@${market})?(?=\\s|$|[✓✔])`, 'i').test(line)
    && !new RegExp(`(?:^|\\s)${name}@(?!${market}(?=\\s|$|[✓✔]))`, 'i').test(line)
    && (onMarket || new RegExp(`${name}@${market}(?=\\s|$|[✓✔])`, 'i').test(line));
}
function selected(line: string): boolean { return /^\s*(?:>|❯|›|→|●|\*)\s/.test(line); }
function installButton(line: string): boolean {
  return selected(line) && /^\s*(?:>|❯|›|→|●|\*)\s+(?:Confirm install|Install|설치)\s*$/i.test(line);
}
function selectedPluginRow(line: string): boolean {
  return selected(line) && /^\s*(?:>|❯|›|→|●|\*)\s+[a-zA-Z0-9][a-zA-Z0-9._-]*@[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\s|$)/.test(line);
}
function negativeInstallation(line: string): boolean {
  return /(?:\b(?:not|never|un|failed|error|disabled)\s*[- ]?installed\b|\bnot\s+enabled\b|\binstall\s+failed\b|설치 안 됨|설치 실패)/i.test(line);
}
function installed(screen: string, request: PluginRequest, onMarket: boolean): boolean {
  let visible = lines(screen);
  if (request.agent === 'claude') {
    // Only output below this install command counts — an «Installed» row left from an earlier run must not.
    const echo = visible.map((line, i) => line.includes(`/plugin install ${request.plugin}@${request.marketplace}`) ? i : -1).filter(i => i >= 0).pop();
    if (echo === undefined) return false;
    visible = visible.slice(echo + 1);
  }
  return visible.some(line => targetLine(line, request, onMarket)
    && !negativeInstallation(line)
    && !/(?:\b(?:installing|loading|downloading|fetching)\b|설치 중)/i.test(line)
    && /(?:\binstalled\b|\benabled\b|✓|✔|설치됨)/i.test(line));
}

// Lines an agent draws under its input box: status/path line and the shortcut hint.
// 🩸 09-29 codex 0.157 home: «› Ask Codex to do anything» then «~/… · branch · Context 100% left ·…» and
//    «? for shortcuts ⚠ 3 warnings · f2 to view» — the prompt is no longer the last line (T 녹화 2/2 unknown-menu).
function footerLine(line: string): boolean {
  return /\?\s*for shortcuts|Context \d+% left|\bf2 to view\b|^\s*~\//i.test(line);
}

function conversationPrompt(screen: string, agent: PluginRequest['agent']): boolean {
  const visible = lines(screen);
  // codex rotates its placeholder («Ask a question», «Ask Codex to do anything», «Explain this codebase», …), so any
  // «› text» line above the footer counts; the Browse-plugins guard below keeps menu rows out.
  const prompt = agent === 'codex'
    ? /^\s*[›❯>]\s+\S/
    : /^\s*❯\s*(?:$|How can I help|Type a message)/i;
  // A selected plugin row is not a conversation prompt; neither is a prompt left above an overlay.
  let end = visible.length;
  while (end > 0 && footerLine(visible[end - 1]!)) end--;
  const lastPrompt = visible[end - 1];
  return lastPrompt !== undefined && prompt.test(lastPrompt)
    && (agent === 'codex' || (visible.some(line => /Claude Code/i.test(line)) && !visible.some(line => /\bCodex\b/i.test(line))))
    && !visible.some(line => /^(?:Browse plugins|Plugins)(?:\s|$)/i.test(line));
}

function menuPluginRows(visible: string[], onMarket: boolean): { line: string; index: number }[] {
  const menuStart = visible.findIndex(line => /^(?:Browse plugins|Plugins)(?:\s|$)/i.test(line));
  if (menuStart < 0) return [];
  return visible.slice(menuStart + 1).flatMap((line, offset) => {
    if (!/^\s*(?:[>❯›→●*]\s+)?[a-zA-Z0-9][a-zA-Z0-9._-]*(?:@[a-zA-Z0-9][a-zA-Z0-9._-]*)?(?:\s|$)/.test(line)
      || /^(?:Marketplaces?|Tabs?|Install|Confirm install|Ask a question)\b/i.test(line.replace(/^\s*(?:[>❯›→●*]\s+)?/, ''))
      || (!onMarket && !/@[a-zA-Z0-9._-]+/.test(line))) return [];
    return [{ line, index: menuStart + 1 + offset }];
  });
}

export async function installPluginInsideAgent(request: PluginRequest, pty: Pick<PtyHandle, 'renderScreen' | 'write' | 'isAlive'>, deps: PluginDeps = {}): Promise<PluginResult> {
  if (!IDENT.test(request.plugin) || !IDENT.test(request.marketplace)) return { outcome: 'escalate', reason: 'wrong-target' };
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const log = (event: string, data: Record<string, unknown>) => (deps.log ?? ((e, d) => debug.log('agent-mission.plugin', e, d)))(event, data);
  const decide = (kind: DecisionEvent['kind'], what: string, reason: string) =>
    (deps.decide ?? emitDecision)({ kind, what, reason, purpose: '미션에 이 플러그인 스킬이 필요', target: `${request.plugin}@${request.marketplace}`, phase: 'implement' });
  const write = deps.write ?? ((text: string) => pty.write(text, 'agent'));
  const safeTail = (screen: string) =>
    /password|token|api.?key|sign in|log in|login method|Paste code here|https?:\/\//i.test(screen)
      ? ['[credential screen]']
      : lines(screen).slice(-10).map(line => line.slice(0, 160));
  const brain = deps.brain ?? (async (screen: string, target: string) => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You navigate a plugin menu using only up/down/tab/enter/wait/unknown. Return exactly one of those words. Do not choose enter unless the requested plugin@marketplace is visibly selected. Never enter credentials.' },
      { role: 'user', content: `Target: ${target}\nScreen:\n${screen.slice(-3500)}` },
    ];
    const answer = (await streamLLM(messages, () => {}, { maxTokens: 20 })).trim().toLowerCase();
    return /^(up|down|tab|enter|wait)$/.test(answer) ? answer as 'up' | 'down' | 'tab' | 'enter' | 'wait' : 'unknown';
  });
  const target = `${request.plugin}@${request.marketplace}`;
  const fail = (reason: Extract<PluginResult, { outcome: 'escalate' }>['reason'], screen: string): PluginResult => {
    log('escalated', { reason, tail: safeTail(screen) });
    decide('ESCALATE', `에이전트 안 플러그인 ${target} 설치 중단`, reason === 'plugins-disabled' ? 'plugins 기능 꺼짐 — 사람에게 codex features enable plugins 확인 요청' : reason);
    return { outcome: 'escalate', reason };
  };
  // Installed (now or already): confirm, close the menu with Esc and wait for the conversation prompt.
  const closeInstalled = async (why: string): Promise<PluginResult> => {
    decide('VERIFY', `설치됨 ${target}`, why);
    write('\x1b');
    for (let i = 0; i < 4; i++) {
      await sleep(300);
      const prompt = await pty.renderScreen();
      if (conversationPrompt(prompt, request.agent)) return { outcome: 'installed' };
    }
    return fail('unknown-menu', await pty.renderScreen());
  };
  // codex ≥0.157 (실물 09-29): the plugin menu is tabbed by marketplace and has «Type to search plugins». Typing the
  // name filters to «[-] <name>  Available|Installed»; Enter opens details whose header is «<name> · <status> · <market>»
  // with «1. Back to plugins / 2. Install plugin|Uninstall plugin»; a finished install prints «• Installed <name> plugin.»
  // Returns null when the menu has no search box (older codex → the generic loop below).
  const credentialScreen = (text: string) => /(?:password|passphrase|api.?key|token|sign in|log in|authentication required|two.factor|Paste code here)/i.test(text);
  const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameRe = escapeRegExp(request.plugin);
  const rowRe = new RegExp(`^\\s*(›\\s*)?\\[[-* x]\\]\\s+${nameRe}\\s+(Available|Installed)\\b`, 'i');
  const headerRe = new RegExp(`^\\s*${nameRe}\\s+·\\s+(.+?)\\s+·\\s+([A-Za-z0-9._-]+)\\s*$`, 'i');
  const frame = async (): Promise<string> => { await sleep(700); const s = await pty.renderScreen(); log('screen', { step: 'search', tail: safeTail(s) }); return s; };
  const closeToPrompt = async (why: string): Promise<PluginResult> => {
    decide('VERIFY', `설치됨 ${target}`, why);
    for (let i = 0; i < 3; i++) {
      write('\x1b');
      const s = await frame();
      if (conversationPrompt(s, 'codex')) return { outcome: 'installed' };
    }
    return fail('unknown-menu', await pty.renderScreen());
  };
  let handedScreen: string | undefined;
  const codexSearchInstall = async (): Promise<PluginResult | null> => {
    let menu = '';
    let resent = false;
    for (let i = 0; i < 8; i++) {
      menu = await frame();
      if (!pty.isAlive()) return fail('timeout', menu);
      if (/Plugins are disabled\. Enable the plugins feature/i.test(menu)) return fail('plugins-disabled', menu);
      if (credentialScreen(menu)) return fail('credentials', menu);
      if (/Type to search plugins/i.test(menu)) break;
      if (/Browse plugins/i.test(menu)) { handedScreen = menu; return null; }
      if (!resent && lines(menu).some(line => /^\s*[›❯>]\s*\/plugins\s*$/.test(line))) { resent = true; write('\r'); }
    }
    if (!/Type to search plugins/i.test(menu)) return fail('unknown-menu', menu);
    write(request.plugin);
    let rows: string[] = [];
    for (let i = 0; i < 6 && rows.length === 0; i++) rows = lines(await frame()).filter(line => rowRe.test(line));
    if (rows.length === 0) return fail('wrong-target', await pty.renderScreen());
    for (let candidate = 0; candidate < Math.min(rows.length, 5); candidate++) {
      if (candidate > 0) write('\x1b[B');
      write('\r');
      let header: RegExpMatchArray | null = null;
      let details = '';
      for (let i = 0; i < 6 && !header; i++) {
        details = await frame();
        if (credentialScreen(details)) return fail('credentials', details);
        header = lines(details).map(line => line.match(headerRe)).find(Boolean) ?? null;
      }
      if (!header) return fail('unknown-menu', details);
      const [, status, market] = header;
      if (market!.toLowerCase() !== request.marketplace.toLowerCase()) {
        log('market-mismatch', { target, market });
        write('\r'); // «1. Back to plugins» is selected when details open
        await frame();
        continue;
      }
      if (/^Installed$/i.test(status!.trim())) return closeToPrompt('이미 설치돼 있다 — 다시 설치하지 않고 미션으로');
      decide('ROUTE', `설치 ${target}`, '상세 화면의 마켓이 요청과 같다');
      write('\x1b[B');
      const choose = await frame();
      const chosen = lines(choose).find(line => /^\s*›\s*2\.\s*Install plugin\b/i.test(line));
      const stillTarget = lines(choose).some(line => { const m = line.match(headerRe); return Boolean(m && m[2]!.toLowerCase() === request.marketplace.toLowerCase()); });
      if (!chosen || !stillTarget) return fail('wrong-target', choose);
      write('\r');
      for (let i = 0; i < 20; i++) {
        const after = await frame();
        if (!pty.isAlive()) return fail('timeout', after);
        if (credentialScreen(after) && !/No additional app authentication is required/i.test(after)) return fail('credentials', after);
        if (new RegExp(`Installed\\s+${nameRe}\\s+plugin`, 'i').test(after)
          || lines(after).some(line => { const m = line.match(headerRe); return Boolean(m && /^Installed$/i.test(m[1]!.trim())); })) {
          return closeToPrompt('설치 완료 줄을 화면에서 확인');
        }
      }
      return fail('timeout', await pty.renderScreen());
    }
    return fail('wrong-target', await pty.renderScreen());
  };
  let screen = await pty.renderScreen();
  if (!pty.isAlive()) return fail('timeout', screen);
  // 🩸 09-29 (🅣 v4 녹화): on a first-opened folder codex showed «Trust this folder? › 1. Trust and continue» after the
  //    driver's trust pass, and this step escalated unknown-menu. Answer late trust menus here (at most 3).
  for (let pass = 0; pass < 3 && deps.handleTrust?.(screen, write); pass++) {
    decide('ROUTE', '폴더 신뢰 메뉴 응답', '처음 여는 워크트리 — 설치 전에 늦게 뜬 신뢰 메뉴');
    await sleep(1500);
    screen = await pty.renderScreen();
  }
  if (/(?:password|passphrase|api.?key|token|sign in|log in|login method|authentication required|two.factor|Paste code here)/i.test(screen)) return fail('credentials', screen);
  if (!conversationPrompt(screen, request.agent)) return fail('unknown-menu', screen);
  decide('ROUTE', '에이전트 안 메뉴 → 설치', '미션에 이 플러그인 스킬이 필요');
  write(request.agent === 'codex' ? '/plugins\r' : `/plugin install ${target}\r`);
  if (request.agent === 'codex') {
    const bySearch = await codexSearchInstall();
    if (bySearch) return bySearch;
  }
  let marketSelected = false;
  let installStarted = request.agent === 'claude';
  let observedInstallTransition = false;
  let lastAction = '';
  let repeats = 0;
  let resentSlash = false;
  for (let step = 0; step < 36; step++) {
    if (handedScreen !== undefined) { screen = handedScreen; handedScreen = undefined; }
    else { await sleep(700); screen = await pty.renderScreen(); }
    log('screen', { step, tail: safeTail(screen) });
    if (!pty.isAlive()) return fail('timeout', screen);
    if (/Plugins are disabled\. Enable the plugins feature to use \/plugins\./i.test(screen)) return fail('plugins-disabled', screen);
    if (/(?:password|passphrase|api.?key|token|sign in|log in|authentication required|two.factor)/i.test(screen)) return fail('credentials', screen);
    if (installStarted && lines(screen).some(line => targetLine(line, request, marketSelected) && negativeInstallation(line))) return fail('unknown-menu', screen);
    if (request.agent === 'codex' && !/(?:Browse plugins|marketplace|Install|Installing|Installed|✓|✔)/i.test(screen)) {
      // 🩸 09-29 (🅣 녹화 3/3): step 0 showed «› /plugins» still in the input box — the menu had not opened yet
      //    and this line escalated at once. Give the slash command one more Enter and a few frames to open.
      if (!installStarted && step < 6) {
        if (!resentSlash && lines(screen).some(line => /^\s*[›❯>]\s*\/plugins\s*$/.test(line))) { resentSlash = true; write('\r'); }
        continue;
      }
      return fail('unknown-menu', screen);
    }
    if (installed(screen, request, marketSelected) && (request.agent === 'claude' || observedInstallTransition)) {
      return closeInstalled('대상 항목 설치됨 표지를 화면에서 확인');
    }
    if (/(?:Installing|Downloading|Loading|Fetching|설치 중|⠋|⠙)/i.test(screen) && installStarted) { observedInstallTransition = true; continue; }
    if (request.agent === 'claude') {
      if (/(?:error|failed|not found|unknown plugin|not installed)/i.test(screen)) return fail('unknown-menu', screen);
      continue;
    }
    const visible = lines(screen);
    const tabs = visible.find(line => /marketplaces?|tabs?/i.test(line) && line.toLowerCase().includes(request.marketplace.toLowerCase()));
    const activeMarket = visible.some(line => selected(line) && line.includes(request.marketplace)) || Boolean(tabs && tabs.includes(`[${request.marketplace}]`));
    marketSelected = activeMarket;
    const menuRows = menuPluginRows(visible, marketSelected);
    const rows = menuRows.filter(({ line }) => targetLine(line, request, marketSelected));
    const chosen = menuRows.find(({ line }) => selected(line))?.index ?? -1;
    const row = rows.length === 1 ? rows[0]!.index : -1;
    const button = visible.find(installButton);
    const targetButton = Boolean(button && installStarted && menuRows.length === 1 && rows.length === 1
      && !menuRows.some(({ line }) => selected(line)));
    let action: 'up' | 'down' | 'tab' | 'enter' | 'wait' | 'unknown' = 'unknown';
    let safeEnter = false;
    if (!installStarted && rows.length === 1 && installed(rows[0]!.line, request, marketSelected)) {
      log('already-installed', { target });
      return closeInstalled('이미 설치돼 있다 — 다시 설치하지 않고 미션으로');
    }
    if (rows.length === 1 && row === chosen) {
      action = 'enter'; safeEnter = true;
    } else if (rows.length === 1 && chosen >= 0) action = row > chosen ? 'down' : 'up';
    else if (targetButton) { action = 'enter'; safeEnter = true; }
    else if (tabs && !marketSelected) action = 'tab';
    if (action === 'unknown') {
      try { action = await brain(screen.slice(-3500), target); }
      catch { action = 'unknown'; }
      safeEnter = rows.length === 1 && row === chosen || targetButton;
    }
    if (action === 'unknown') return fail('unknown-menu', screen);
    if (action === 'enter' && !safeEnter) return fail('wrong-target', screen);
    if (action === 'enter') {
      const freshScreen = await pty.renderScreen();
      if (/(?:password|passphrase|api.?key|token|sign in|log in|authentication required|two.factor)/i.test(freshScreen)) return fail('credentials', freshScreen);
      const fresh = lines(freshScreen);
      const freshRows = menuPluginRows(fresh, marketSelected);
      const freshSelected = freshRows.filter(({ line }) => selected(line) && targetLine(line, request, marketSelected));
      // State can change between the decision and the key: an «Installed» row must not receive Enter.
      if (freshSelected.length === 1 && installed(freshSelected[0]!.line, request, marketSelected)) {
        return closeInstalled('Enter 직전 재확인에서 이미 설치됨');
      }
      const freshButton = fresh.find(installButton);
      const freshTargetButton = Boolean(freshButton && installStarted && freshRows.length === 1
        && targetLine(freshRows[0]!.line, request, marketSelected)
        && !freshRows.some(({ line }) => selected(line))
        && !fresh.some(line => selectedPluginRow(line)));
      if (!(freshSelected.length === 1 && !freshButton
        && !freshRows.some(({ line }) => selected(line) && !targetLine(line, request, marketSelected)))
        && !freshTargetButton) return fail('wrong-target', fresh.join('\n'));
    }
    if (action === 'enter') { installStarted = true; observedInstallTransition = true; }
    if (action === lastAction) repeats++; else repeats = 0;
    if (repeats > 8) return fail('timeout', screen);
    lastAction = action;
    if (action === 'wait') continue;
    decide('ROUTE', `에이전트 안 메뉴 → ${action}`, `화면에서 ${target} 대상 확인`);
    write(action === 'enter' ? '\r' : action === 'up' ? '\x1b[A' : action === 'down' ? '\x1b[B' : '\t');
  }
  return fail('timeout', screen);
}
