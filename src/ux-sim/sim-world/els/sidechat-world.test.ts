// ELS-SIDECHAT sim — seeded CORE scenarios over a REAL registry + hub and REAL attach apps (see sidechat-world.ts):
// open (ctrl+b / · CLI-style open) → type (Korean, paste) → Enter → streamed markdown answer → multi-turn → Esc → reopen
// empty (refill), and the model failing / never starting → one clean line. Every frame is checked as it is written.
// Expected strings are literals, never built with the product's renderer.
import { afterAll, describe, expect, test } from 'bun:test';
import { createSidechatWorld, type SidechatViewer, type SidechatWorld } from './sidechat-world.js';

const SEEDS = [1, 2, 3, 4, 5] as const;
const PREFIX = '\u0002';
const ESC = '\u001b';
const worlds: SidechatWorld[] = [];
afterAll(() => { for (const one of worlds) one.dispose(); });
const world = (seed: number): SidechatWorld => { const made = createSidechatWorld(seed); worlds.push(made); return made; };
const text = (v: SidechatViewer): string => v.last().join('\n');
const QUESTIONS = ['els 가 뭐야?', '오늘 발행 몇 시?', 'What is a z-axis overlay?', '표로 정리해줘', '코드 예시 보여줘'] as const;
// Keys arrive one code point at a time, the way an IME commits syllables (한 → 국 → 어), or as one paste chunk.
const typeIn = (v: SidechatViewer, words: string, paste: boolean): void => { if (paste) v.press(`\u001b[200~${words}\u001b[201~`); else for (const ch of Array.from(words)) v.press(ch); };

describe('C1 · open → type (Korean · paste) → Enter → streamed markdown → Esc → reopen empty', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed);
    const v = await w.viewer();
    v.press(`${PREFIX}/`);                                                   // ctrl+b / → els server overlay open
    await w.flush();
    expect(w.layer()).toBeDefined();
    expect(text(v)).toContain('Sidechat');
    expect(text(v)).toContain('Enter send · Esc close');
    const question = QUESTIONS[w.rand.int(0, QUESTIONS.length - 1)]!;
    typeIn(v, question, w.rand.int(0, 1) === 1);
    expect(w.layer()!.props.input).toBe(question);
    expect(v.typed()).toEqual([]);                                           // nothing leaks to the pane underneath
    v.press('\r');
    await w.flush();
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.messages.at(-1)).toEqual({ role: 'user', content: question });
    expect(text(v)).toContain('thinking…');                                  // before the first token
    expect(w.layer()!.props.input).toBe('');
    // Stream a long markdown answer: a heading, a table, fenced code — in random chunk sizes.
    const answer = '## 답\n\n| 칸 | 값 |\n|---|---|\n| a | 1 |\n\n```ts\nconst x = 1;\n```\n\n끝 문장입니다.';
    let at = 0;
    while (at < answer.length) { const n = w.rand.int(1, 12); await w.calls[0]!.say(answer.slice(at, at + n)); at += n; if (w.rand.int(0, 2) === 0) await w.flush(); }
    await w.flush();
    expect(text(v)).toContain('answering…');
    await w.calls[0]!.end();
    await w.flush();
    const done = text(v);
    expect(done).not.toContain('answering…');
    expect(done).toContain('› ' + question);
    expect(done).toContain('const x = 1;');
    expect(done).toContain('끝 문장입니다.');
    expect(done).not.toContain('|---|');                                     // the table is drawn, not raw
    v.press(ESC);
    await w.flush();
    expect(w.layer()).toBeUndefined();
    expect(text(v)).not.toContain('Sidechat');
    v.press(`${PREFIX}/`);                                                   // refill: a fresh session
    await w.flush();
    expect(text(v)).toContain('Ask anything');
    expect(text(v)).not.toContain('끝 문장입니다.');
    expect(v.violations).toEqual([]);
  });
});

describe('C2 · multi-turn while open: the second question carries the first turn', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed);
    const v = await w.viewer({ cols: w.rand.int(0, 1) ? 200 : 120, rows: w.rand.int(0, 1) ? 80 : 30 });
    w.registry.apply({ action: 'open', kind: 'sidechat', props: {} });         // the CLI / ElsControl path
    await w.flush();
    typeIn(v, '첫 질문', false); v.press('\r'); await w.flush();
    await w.calls[0]!.say('첫 답'); await w.calls[0]!.end(); await w.flush();
    typeIn(v, 'second', false);
    v.press('\r'); await w.flush();
    expect(w.calls).toHaveLength(2);
    expect(w.calls[1]!.messages.slice(1)).toEqual([{ role: 'user', content: '첫 질문' }, { role: 'assistant', content: '첫 답' }, { role: 'user', content: 'second' }]);
    // Enter while answering is ignored (one question at a time).
    typeIn(v, 'third', false); v.press('\r'); await w.flush();
    expect(w.calls).toHaveLength(2);
    await w.calls[1]!.say('둘째 답'); await w.calls[1]!.end(); await w.flush();
    expect(text(v)).toContain('첫 답');
    expect(text(v)).toContain('둘째 답');
    expect(v.violations).toEqual([]);
  });
});

describe('C3 · Esc mid-stream: the request is aborted, later chunks never show, the next open is empty', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed);
    const v = await w.viewer();
    v.press(`${PREFIX}/`); await w.flush();
    typeIn(v, 'long one', false); v.press('\r'); await w.flush();
    for (let n = w.rand.int(1, 5); n > 0; n--) await w.calls[0]!.say(`part${n} `);
    await w.flush();
    v.press(ESC); await w.flush();
    expect(w.calls[0]!.aborted()).toBe(true);
    expect(w.hub.snapshot()).toEqual({ turns: [], status: 'idle', input: '' });
    await w.calls[0]!.say('ORPHAN'); await w.flush();
    expect(w.layer()).toBeUndefined();
    v.press(`${PREFIX}/`); await w.flush();
    expect(text(v)).not.toContain('ORPHAN');
    expect(text(v)).not.toContain('part');
    expect(w.timers.active()).toBe(0);                                         // no timer left armed by the cancelled run
    expect(v.violations).toEqual([]);
  });
});

describe('C4 · the model fails or never starts: one clean line, the popup stays usable', () => {
  for (const seed of SEEDS) test(`error · seed ${seed}`, async () => {
    const w = world(seed);
    const v = await w.viewer({ cols: 80, rows: 24 });
    v.press(`${PREFIX}/`); await w.flush();
    typeIn(v, '질문', false); v.press('\r'); await w.flush();
    await w.calls[0]!.fail('HTTP 503 upstream overloaded'); await w.flush();
    expect(text(v)).toContain('⚠ The model call failed: HTTP 503 upstream');   // 80 cols: the line wraps
    expect(text(v)).toContain('overloaded');
    expect(text(v)).not.toMatch(/Error:|\n\s+at /);                           // no stack
    typeIn(v, '다시', false); v.press('\r'); await w.flush();
    expect(w.calls).toHaveLength(2);                                           // usable again
    expect(v.violations).toEqual([]);
  });
  for (const seed of SEEDS) test(`first-token timeout · seed ${seed}`, async () => {
    const w = world(seed);
    const v = await w.viewer();
    v.press(`${PREFIX}/`); await w.flush();
    typeIn(v, 'slow?', false); v.press('\r'); await w.flush();
    expect(text(v)).toContain('thinking…');
    w.timers.advance(30_000); await w.flush();
    expect(w.calls[0]!.aborted()).toBe(true);
    expect(text(v)).toContain('No answer yet — the model did not start in 30 s. Try again.');
    expect(text(v)).not.toContain('thinking…');
    expect(v.violations).toEqual([]);
  });
});

describe('C6 · a laggy socket: pushes of older states land between keys; a fast paste + Enter still asks the whole text', () => {
  // Live 11-26 18:0x (test universe, tmux send-keys): the first push landed between the paste and Enter, and the question
  // went out as its first syllable only. Keys now go up as ordered edits; the server's input is the truth.
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed);
    const v = await w.viewer({ lag: true });
    w.registry.apply({ action: 'open', kind: 'sidechat', props: {} });
    await w.flush();
    const question = '방금 답을 2열 표로 정리해줘';
    const chars = Array.from(question);
    let at = 0;
    while (at < chars.length) {
      const n = w.rand.int(1, 4);
      v.press(chars.slice(at, at + n).join(''));                             // one terminal read
      at += n;
      v.deliver(w.rand.int(0, v.inFlight()));                                 // some acts land → a push of an older input
    }
    v.press('\r');
    v.deliver();
    await w.flush();
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.messages.at(-1)).toEqual({ role: 'user', content: question });
    expect(w.layer()!.props.input).toBe('');
    expect(v.violations).toEqual([]);
  });
});

describe('C5 · narrow 80x24 and two viewers: same layer, Esc in B closes it for A', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed);
    const a = await w.viewer({ cols: 80, rows: 24 });
    const b = await w.viewer({ cols: 200, rows: 80, pane: 'p2' });
    a.press(`${PREFIX}/`); await w.flush();
    typeIn(a, '둘이 봐요', false); a.press('\r'); await w.flush();
    await w.calls[0]!.say('**같은 답**'); await w.flush();
    expect(text(a)).toContain('같은 답');
    expect(text(b)).toContain('같은 답');
    expect(a.last()).toHaveLength(24);
    b.press(ESC); await w.flush();
    expect(w.calls[0]!.aborted()).toBe(true);
    expect(text(a)).not.toContain('Sidechat');
    a.press('x');
    expect(a.typed()).toEqual(['x']);                                          // keys reach the pane again
    expect([...a.violations, ...b.violations]).toEqual([]);
  });
});
