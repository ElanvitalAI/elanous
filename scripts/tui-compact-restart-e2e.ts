#!/usr/bin/env bun
// TUI-DISPLAY-SNAPSHOT-RESTORE e2e (대표 11-25 «finish the root») — drives the REAL next TUI in an isolated test
// universe through tmux, with a local fake OpenAI-compatible LLM (no subscription spend):
//   1. seed a long session (human Q/A · tool rows · machine-mail notices) past the turn-start compaction trigger
//   2. open it, capture the screen (before)
//   3. send one human line → the turn child compacts the store at turn start → capture (after-compaction)
//   4. Ctrl+Q and relaunch with --resume (what an installed-update self-restart does) → capture (after-restart)
//   5. assert the earlier mail notice and answer texts are on every screen, and the compaction really fired
// It never reads the transcript-vanish detector. Usage:
//   bun scripts/tui-compact-restart-e2e.ts --out <dir> [--root <dir>] [--keep]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
const repoRoot = join(import.meta.dir, '..');
const out = flag('--out') ?? mkdtempSync(join(tmpdir(), 'compact-e2e-out-'));
const root = flag('--root') ?? mkdtempSync(join(tmpdir(), 'compact-e2e-root-'));
const keep = argv.includes('--keep');
mkdirSync(out, { recursive: true });
mkdirSync(join(root, 'state'), { recursive: true });
mkdirSync(join(root, 'xdg'), { recursive: true });

// Literal markers (independent of product text).
const MAIL_MARK = 'MAILMARK-BRAVO landing receipt posted';
const EARLY_ANSWER = 'EARLYANSWER-ALPHA the queue is unblocked';
const FRESH_REPLY = 'FRESHREPLY-CHARLIE done';
const HUMAN_LINE = 'status check after the long run';

// ── fake LLM ──────────────────────────────────────────────────────────────
let summaryCalls = 0;
let streamCalls = 0;
const encoder = new TextEncoder();
const llm = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'test-model', object: 'model' }] });
    if (!pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 });
    const body = await request.json() as { stream?: boolean };
    if (!body.stream) {
      summaryCalls += 1;
      return Response.json({ id: 'x', object: 'chat.completion', model: 'test-model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '## Goal\n- fake summary of the earlier run' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    }
    streamCalls += 1;
    const frames = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: FRESH_REPLY } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    ];
    let index = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { const frame = frames[index++]; if (frame === undefined) controller.close(); else controller.enqueue(encoder.encode(frame)); },
    }), { headers: { 'content-type': 'text/event-stream' } });
  },
});

writeFileSync(join(root, 'config.json'), JSON.stringify({
  onboarding: { completed: true },
  llm: { provider: 'local', model: 'test-model', baseUrl: `http://127.0.0.1:${llm.port}/v1` },
  skillRouter: { llmFallback: false },
  mcp: { enabled: false },
}));

// ── seed the session (store API, isolated root) ───────────────────────────
process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
const store = await import('../src/session/index.js');
const sessionId = store.createSession({ source: 'tui' }).id;
const filler = ' The landing queue moved and receipts were posted for review.'.repeat(30);
let minute = 0;
const ts = () => new Date(Date.UTC(2026, 10, 25, 0, minute++)).toISOString();
for (let k = 0; k < 24; k += 1) {
  store.appendMessage(sessionId, { role: 'user', content: `Question ${k}: how is the queue?${filler}`, ts: ts() });
  store.appendMessage(sessionId, { role: 'tool', content: `⚙️ Bash ${k}`, ts: ts(), toolName: 'Bash' } as never);
  store.appendMessage(sessionId, { role: 'assistant', content: `Answer ${k}: still moving.${filler}`, ts: ts(), replyFinal: true } as never);
}
// The exchange the person reads last: a mail notice and its answer, then a short human exchange.
store.appendMessage(sessionId, { role: 'user', content: `[notice · seat-mail · 1 msg · from TC · #9100]\n[from TC · info] msg:9100 · ${MAIL_MARK}`,
  ts: ts(), from: { kind: 'agent', seat: 'TC', msgId: '9100', intent: 'info' } } as never);
store.appendMessage(sessionId, { role: 'assistant', content: EARLY_ANSWER, ts: ts(), replyFinal: true } as never);
// Three short human exchanges after it put the mail outside the compactor's preserved tail (machine mail is then
// summarized away from the store) while it stays on a 60-row screen.
for (const line of ['thanks, noted', 'any blockers left?', 'ok, keep going']) {
  store.appendMessage(sessionId, { role: 'user', content: line, ts: ts() });
  store.appendMessage(sessionId, { role: 'assistant', content: `Acknowledged: ${line}`, ts: ts(), replyFinal: true } as never);
}
delete process.env.ELANOUS_SESSION_ROOT;

// ── tmux ──────────────────────────────────────────────────────────────────
const SESS = `compact-e2e-${process.pid}`;
const tmux = (...args: string[]) => Bun.spawnSync(['tmux', ...args], { stdout: 'pipe', stderr: 'pipe' });
const capture = () => new TextDecoder().decode(tmux('capture-pane', '-t', SESS, '-p').stdout);
const sleep = (ms: number) => Bun.sleep(ms);
const waitFor = async (label: string, ok: (screen: string) => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  let screen = '';
  while (Date.now() < deadline) { screen = capture(); if (ok(screen)) return screen; await sleep(500); }
  writeFileSync(join(out, `timeout-${label}.txt`), screen);
  throw new Error(`timeout waiting for ${label} (screen saved)`);
};
const env = `NODE_ENV=development XDG_STATE_HOME=${join(root, 'xdg')} ELANOUS_STATE_DIR=${join(root, 'state')} TERM=xterm-256color`;
const launch = `env -u ELANOUS_CONFIG_DIR -u XDG_CONFIG_HOME -u ELANOUS_SESSION_ROOT ${env} bun bin/elanous.mjs --test=${root} --tui next --resume ${sessionId}`;
// Two launches in one pane: the second one is the restart (same session, same universe).
tmux('kill-session', '-t', SESS);
tmux('new-session', '-d', '-s', SESS, '-x', '160', '-y', '60', `cd ${repoRoot} && ${launch}; echo E2E-RESTARTING; ${launch}; echo E2E-DONE; sleep 600`);

const composer = (screen: string) => screen.includes('Ctrl+Q') || screen.split('\n').some((line) => /^\s*[❯›]\s*$/.test(line));
const result: Record<string, unknown> = { sessionId, root, out };
let failed = false;
try {
  const before = await waitFor('boot', (s) => s.includes('EARLYANSWER-ALPHA') && composer(s), 90_000);
  writeFileSync(join(out, '1-before.txt'), before);
  tmux('send-keys', '-t', SESS, '-l', HUMAN_LINE);
  await sleep(500);
  tmux('send-keys', '-t', SESS, 'Enter');
  const afterCompaction = await waitFor('reply', (s) => s.includes('FRESHREPLY-CHARLIE'), 120_000);
  await sleep(4_000); // settle: the turn-end reload + snapshot write
  writeFileSync(join(out, '2-after-compaction.txt'), capture());
  void afterCompaction;
  tmux('send-keys', '-t', SESS, 'C-q');
  await waitFor('restart-marker', (s) => s.includes('E2E-RESTARTING'), 30_000).catch(() => undefined);
  const afterRestart = await waitFor('restart', (s) => s.includes('FRESHREPLY-CHARLIE') && !s.includes('E2E-RESTARTING') && composer(s), 90_000)
    .catch(async () => { await sleep(8_000); return capture(); });
  await sleep(3_000);
  writeFileSync(join(out, '3-after-restart.txt'), capture());

  const screens = {
    before: readFileSync(join(out, '1-before.txt'), 'utf-8'),
    afterCompaction: readFileSync(join(out, '2-after-compaction.txt'), 'utf-8'),
    afterRestart: readFileSync(join(out, '3-after-restart.txt'), 'utf-8'),
  };
  void afterRestart;
  const stored = readFileSync(join(root, 'sessions', `${sessionId}.jsonl`), 'utf-8');
  const checks = {
    compactionFired: stored.includes('<context_summary>'),
    storeStubbedMail: stored.includes('[seat-mail 9100 from TC]') && !stored.includes(MAIL_MARK),
    snapshotWritten: existsSync(join(root, 'sessions', `${sessionId}.display.json`)),
    mailBefore: screens.before.includes('MAILMARK-BRAVO'),
    mailAfterCompaction: screens.afterCompaction.includes('MAILMARK-BRAVO'),
    mailAfterRestart: screens.afterRestart.includes('MAILMARK-BRAVO'),
    answerBefore: screens.before.includes('EARLYANSWER-ALPHA'),
    answerAfterCompaction: screens.afterCompaction.includes('EARLYANSWER-ALPHA'),
    answerAfterRestart: screens.afterRestart.includes('EARLYANSWER-ALPHA'),
    freshAfterRestart: screens.afterRestart.includes('FRESHREPLY-CHARLIE'),
  };
  Object.assign(result, { checks, summaryCalls, streamCalls });
  failed = Object.values(checks).some((value) => value !== true);
} catch (error) {
  failed = true;
  result.error = error instanceof Error ? error.message : String(error);
  writeFileSync(join(out, 'last-screen.txt'), capture());
} finally {
  tmux('kill-session', '-t', SESS);
  llm.stop(true);
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(failed ? 'E2E FAIL' : 'E2E PASS');
  if (!keep) rmSync(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
