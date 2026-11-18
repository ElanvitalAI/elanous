/**
 * WEB-CHAT-ONE-SESSION-STABLE (대표 11-17 «원 세션 채팅 먼저 안정화 뒤 프로젝트»): the one-session web chat scenario bundle.
 * It drives the built PWA in a headless Chrome against a running Nexus and writes one receipt with a verdict per scenario:
 *   send      — the first message appears as the user's turn and an assistant turn starts
 *   stream    — the answer grows while it is being written (more than one length seen before it ends)
 *   capsule   — a turn that used a tool folds its steps into one «n steps» capsule above the answer
 *   reconnect — after the browser was offline for a while, the next message is answered
 *   refresh   — a reload keeps the same conversation (id and earlier turns)
 *   mobile    — at phone width the composer is on screen and a message is answered
 * Real LLM turns: run it in a test universe (isolated Nexus with a configured provider), never against an operating one.
 *
 *   bun scripts/ux/web-chat-one-session-e2e.ts --origin http://127.0.0.1:31494 --out <dir> [--token-file <path>] [--port 9341]
 *
 * The token (when the Nexus needs one) is read from a file and put into the page's storage — never printed or written.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, sleep, type Cdp } from './lib/cdp';

type Verdict = { scenario: string; pass: boolean; detail: string; ms: number; shot?: string };

function arg(name: string, fallback?: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const value = at >= 0 ? process.argv[at + 1] : undefined;
  if (value === undefined && fallback === undefined) throw new Error(`--${name} is required`);
  return value ?? fallback!;
}

const origin = arg('origin').replace(/\/+$/, '');
const out = arg('out');
const port = Number(arg('port', '9341'));
const tokenFile = arg('token-file', '');
// 출처: one model turn in the test universe measured 49–56 s (11-17, grok); a tool turn takes longer.
const TURN_TIMEOUT_MS = Number(arg('turn-timeout-ms', '180000'));
// 출처: tool turns in the same universe took 89–173 s (11-17 runs 1–3) and one ran past 180 s (run 4, it completed
// later); a tool turn gets twice the plain limit.
const TOOL_TURN_TIMEOUT_MS = Number(arg('tool-turn-timeout-ms', String(TURN_TIMEOUT_MS * 2)));
mkdirSync(out, { recursive: true });

const STATE = `(() => {
  const all = [...document.querySelectorAll('[data-elanous-message]')];
  const last = (role) => [...all].reverse().find((node) => node.getAttribute('data-elanous-message') === role);
  const assistant = last('assistant');
  const capsule = assistant ? [...assistant.querySelectorAll('summary')].map((s) => s.textContent.trim()).find((t) => /\\d+ steps?/.test(t)) ?? null : null;
  return {
    users: all.filter((n) => n.getAttribute('data-elanous-message') === 'user').length,
    assistants: all.filter((n) => n.getAttribute('data-elanous-message') === 'assistant').length,
    streaming: assistant?.getAttribute('data-elanous-streaming') === 'true',
    incomplete: assistant?.getAttribute('data-elanous-incomplete') === 'true',
    lastText: (assistant?.innerText ?? '').trim().slice(0, 400),
    capsule,
    session: localStorage.getItem('elanous.daemon.sessionId'),
    composer: (() => { const t = document.querySelector('textarea'); if (!t) return false; const r = t.getBoundingClientRect(); return r.height > 0 && r.bottom <= innerHeight + 1; })(),
    connectScreen: document.body.innerText.includes('이 기기를 연결해야 합니다'),
  };
})()`;
type State = { users: number; assistants: number; streaming: boolean; incomplete: boolean; lastText: string; capsule: string | null; session: string | null; composer: boolean; connectScreen: boolean };

async function state(cdp: Cdp): Promise<State> { return cdp.ev<State>(STATE); }

async function type(cdp: Cdp, text: string): Promise<void> {
  await cdp.ev(`(() => { const t = document.querySelector('textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ${JSON.stringify(text)}); t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(200);
  await cdp.ev(`(() => { document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
}

/** Send one message and follow the answer. `streamed`: visible lengths seen while the message was still streaming
 *  (the final length after it ends is not counted). `done`: it ended as a complete answer (not incomplete/error) with
 *  answer text beyond the folded «자세히» summary. */
async function turn(cdp: Cdp, text: string, limitMs = TURN_TIMEOUT_MS): Promise<{ before: State; after: State; streamed: number[]; ms: number; done: boolean }> {
  const before = await state(cdp);
  const started = Date.now();
  await type(cdp, text);
  const streamed: number[] = [];
  let after = before;
  let done = false;
  while (Date.now() - started < limitMs) {
    await sleep(500);
    after = await state(cdp);
    if (after.assistants > before.assistants) {
      if (after.streaming && streamed.at(-1) !== after.lastText.length) streamed.push(after.lastText.length);
      if (!after.streaming) {
        const answer = after.lastText.replace(/^\s*(▸|⋯)?\s*(\d+ steps?|자세히)\s*$/gm, '').trim();
        done = !after.incomplete && answer.length > 0;
        break;
      }
    }
  }
  return { before, after, streamed, ms: Date.now() - started, done };
}

async function open(cdp: Cdp, token: string): Promise<void> {
  await cdp.send('Network.enable');
  await cdp.send('Network.setBypassServiceWorker', { bypass: true });
  await cdp.send('Page.navigate', { url: `${origin}/app/chat/` });
  await sleep(2000);
  await cdp.ev(`(() => { localStorage.setItem('elanous.installBanner.dismissed', '1'); ${token ? `localStorage.setItem('elanous.daemon.token', ${JSON.stringify(token)});` : ''} return true; })()`);
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(5000);
}

const SCENARIOS = ['send', 'stream', 'capsule', 'reconnect', 'refresh', 'mobile'] as const;
const verdicts: Verdict[] = [];
const record = async (cdp: Cdp, v: Omit<Verdict, 'shot'>) => {
  const shot = join(out, `${v.scenario}.png`);
  try { await cdp.png(shot); } catch { /* the verdict still counts without its picture */ }
  verdicts.push({ ...v, shot });
  console.log(`${v.pass ? 'PASS' : 'FAIL'} ${v.scenario} · ${v.detail} · ${Math.round(v.ms / 1000)}s`);
};

const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : '';
let abortedBy = '';

let wide: Cdp | undefined;
try {
  wide = await launch({ port, timeoutMs: 20 * 60_000, width: 1280, height: 860 });
  await open(wide, token);
  const first = await state(wide);
  if (first.connectScreen) throw new Error('the PWA shows the connect screen — give a --token-file for this Nexus');

  // Long enough that the answer arrives in several pieces (a one-line answer can land in a single frame).
  const one = await turn(wide!, '오늘 할 일을 정리하는 요령을 다섯 문장으로 설명해 줘');
  await record(wide, { scenario: 'send', pass: one.done && one.after.users === one.before.users + 1 && one.after.assistants > one.before.assistants,
    detail: `user ${one.before.users}→${one.after.users} · assistant ${one.before.assistants}→${one.after.assistants}`, ms: one.ms });
  // Streamed = while still streaming, the visible answer grew at least twice (the length after the end is not counted).
  await record(wide, { scenario: 'stream', pass: one.done && one.streamed.filter((n, i, all) => i > 0 && n > all[i - 1]!).length >= 2,
    detail: `${one.done ? 'complete' : 'not complete'} · lengths while streaming ${JSON.stringify(one.streamed.slice(0, 10))}`, ms: one.ms });

  const tool = await turn(wide, '지금 작업 폴더의 파일 목록을 도구로 확인하고 몇 개인지 한 줄로 답해', TOOL_TURN_TIMEOUT_MS);
  await record(wide, { scenario: 'capsule', pass: tool.done && !!tool.after.capsule,
    detail: `${tool.done ? 'ended' : 'did not end'} · capsule ${JSON.stringify(tool.after.capsule)}`, ms: tool.ms });

  // Offline for a while (a phone in a tunnel), then back: the next message must be answered.
  await wide.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  // 출처: 15 s offline is longer than the ACP keep-alive gap, so the socket is really gone before the next send.
  await sleep(15_000);
  await wide.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(3000);
  const back = await turn(wide, '한 단어로만 답해: 다시 연결됐니?');
  await record(wide, { scenario: 'reconnect', pass: back.done && back.after.assistants > back.before.assistants,
    detail: `${back.done ? 'answered' : 'no answer'} · ${JSON.stringify(back.after.lastText.slice(0, 60))}`, ms: back.ms });

  const beforeReload = await state(wide);
  const t0 = Date.now();
  await wide.send('Page.reload', { ignoreCache: true });
  let restored = await state(wide);
  for (let i = 0; i < 20 && (restored.users < beforeReload.users || restored.assistants < beforeReload.assistants); i++) { await sleep(500); restored = await state(wide); }
  await record(wide, { scenario: 'refresh', pass: !!beforeReload.session && restored.session === beforeReload.session
      && restored.users >= beforeReload.users && restored.assistants >= beforeReload.assistants,
    detail: `session kept ${!!beforeReload.session && restored.session === beforeReload.session} · turns user ${beforeReload.users}→${restored.users} · assistant ${beforeReload.assistants}→${restored.assistants}`, ms: Date.now() - t0 });
} catch (error) {
  console.error(`aborted: ${error instanceof Error ? error.message : String(error)}`);
  abortedBy = error instanceof Error ? error.message : String(error);
} finally {
  wide?.close();
}

let phone: Cdp | undefined;
try {
  phone = await launch({ port: port + 1, timeoutMs: 10 * 60_000, width: 375, height: 812, dpr: 2, mobile: true });
  await open(phone, token);
  const t = await turn(phone, '한 단어로만 답해: 폰에서 보여?');
  const s = await state(phone);
  await record(phone, { scenario: 'mobile', pass: s.composer && t.done,
    detail: `composer on screen ${s.composer} · ${t.done ? 'answered' : 'no answer'}`, ms: t.ms });
} catch (error) {
  verdicts.push({ scenario: 'mobile', pass: false, detail: error instanceof Error ? error.message : String(error), ms: 0 });
} finally {
  phone?.close();
}

// Every scenario has a verdict in the receipt, also when the run stopped early (browser did not start, a step threw).
for (const scenario of SCENARIOS) {
  if (!verdicts.some((v) => v.scenario === scenario)) verdicts.push({ scenario, pass: false, detail: `not run${abortedBy ? ` — ${abortedBy}` : ''}`, ms: 0 });
}

const receipt = { origin, at: new Date().toISOString(), green: verdicts.length > 0 && verdicts.every((v) => v.pass), verdicts };
writeFileSync(join(out, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`${receipt.green ? 'GREEN' : 'RED'} · ${verdicts.filter((v) => v.pass).length}/${verdicts.length} · ${join(out, 'receipt.json')}`);
process.exit(receipt.green ? 0 : 1);
