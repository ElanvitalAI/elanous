#!/usr/bin/env bun
// TUI-LONG-PASTE-SPIN e2e (대표 11-25 «이렇게 아예 죽는 문제가 나오면 안 됩니다») — drives the REAL next TUI in an
// isolated test universe through tmux with a local fake LLM that keeps the turn running (no subscription spend):
//   1. seed a long synthetic transcript (default ≈4.8k saved rows: human Q · tool rows with real-size output ·
//      Korean markdown answers) — or a small one with --small
//   2. the input under test STARTS the turn: `paste` (bracketed → paste chip) · `rawpaste` (no bracketed markers →
//      keystrokes) · `type` (each line typed + Enter) · `short` (one ~200-char hard instruction)
//   3. while the turn runs, probe key→paint latency: one probe key, poll the screen until it is painted (cap 20 s)
// The probe latency is the loop delay a person feels per frame. Results are written after every probe.
// Usage: bun scripts/tui-long-paste-spin-e2e.ts --mode paste|rawpaste|type|short [--small] [--tree <checkout>]
//        [--out <dir>] [--label <name>] [--probes 6] [--session <jsonl>]
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
const tree = flag('--tree') ?? join(import.meta.dir, '..');
const mode = flag('--mode') ?? 'paste';
const small = argv.includes('--small');
const label = flag('--label') ?? `${mode}${small ? '-small' : ''}`;
const out = flag('--out') ?? mkdtempSync(join(tmpdir(), 'long-paste-e2e-out-'));
const probes = Number(flag('--probes') ?? '6');
const sessionFile = flag('--session');
const PROBE_CAP_MS = 20_000;
mkdirSync(out, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'long-paste-e2e-root-'));
mkdirSync(join(root, 'state'), { recursive: true });
mkdirSync(join(root, 'xdg'), { recursive: true });

// Literal fixtures (independent of product text). The paste mirrors the live one: a 48-line report with box-drawing
// table rows, quoted prompt lines and Korean prose (≈3.6 KB).
const PASTE = [
  '│ - → 칸 WAIT-CYCLE-DETECTOR(P0)를 만들었습니다.', '왜 하기 케이던스로 전체 탭 제어를 못하나요?', '>>>', '│❯ 턴 압축 사라짐 문제는요?',
  `│ ┌${'─'.repeat(60)}┬────────┬${'─'.repeat(30)}┐`, '│ │ 경로 │ 수리 │ 상태 │',
  ...Array.from({ length: 40 }, (_, i) => i % 3 === 0 ? `│ ├${'─'.repeat(60)}┼────────┼${'─'.repeat(30)}┤`
    : `│ - ${i}번째 줄: 재기동하면 압축된 저장 기록 대신 표시 스냅숏을 먼저 그리고, 그 뒤에 새로 생긴 줄만 덧붙입니다.`),
  `│ └${'─'.repeat(60)}┴────────┴${'─'.repeat(30)}┘`, '바깥 행동은 이제 늘 eln OP에 넣습니다',
].join('\n');
const SHORT = '방금 받은 우편 전부 다시 읽고, 착지 대기 PR 세 건의 판정 근거를 원문 영수와 대조한 뒤, 막힌 칸은 주인을 바꿔 재배정하고, 오늘 22:00 예행 전에 끝낼 수 없는 것은 이월 사유를 적어 OP 우편으로 한 줄씩 보내라. 단 MK 에는 보내지 말 것.';
const ANSWER = '## 작업 현황\n\n- 착지 대기 PR 세 건을 판정국에 넘겼다 · 리뷰 결과를 기다린다\n- 발행 예행은 22:00 에 시작한다\n\n| 칸 | 상태 |\n|---|---|\n| 착지 | 진행 중 |\n\n본문 문장은 길게 이어져서 터미널 폭을 넘기면 줄이 바뀌어야 한다. 한국어 단어 경계를 지켜야 한다.';
const TOOL_OUT = JSON.stringify({ output: Array.from({ length: 24 }, (_, i) => `${i + 1}\t#${160000 + i} OP → TC · 받은 우편과 칸 상태를 대조했다 · 근거 영수 첨부`).join('\n'), ok: true });

// ── fake LLM: the turn streams nothing visible for ~2 minutes (a long «Thinking») ──
const encoder = new TextEncoder();
const llm = Bun.serve({
  hostname: '127.0.0.1', port: 0, idleTimeout: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'test-model', object: 'model' }] });
    if (!pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 });
    const body = await request.json() as { stream?: boolean };
    if (!body.stream) {
      return Response.json({ id: 'x', object: 'chat.completion', model: 'test-model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '## Goal\n- summary' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    }
    let n = 0;
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        await Bun.sleep(400);
        n += 1;
        if (n > 300) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`));
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`));
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  },
});

writeFileSync(join(root, 'config.json'), JSON.stringify({
  onboarding: { completed: true },
  llm: { provider: 'local', model: 'test-model', baseUrl: `http://127.0.0.1:${llm.port}/v1` },
  skillRouter: { llmFallback: false }, mcp: { enabled: false },
}));

// ── seed (store API, isolated root) ──
process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
const store = await import(join(tree, 'src/session/index.ts'));
const sessionId = store.createSession({ source: 'tui' }).id;
if (sessionFile) writeFileSync(join(root, 'sessions', `${sessionId}.jsonl`), readFileSync(sessionFile, 'utf-8'));
else {
  const lines: string[] = [];
  let second = 0;
  const ts = () => new Date(Date.UTC(2026, 10, 24, 20, 0, second++)).toISOString();
  const exchanges = small ? 20 : 1200;
  for (let k = 0; k < exchanges; k += 1) {
    lines.push(JSON.stringify({ role: 'user', content: `질문 ${k}: 상태 알려줘`, ts: ts() }));
    for (let t = 0; t < 3; t += 1) lines.push(JSON.stringify({ role: 'tool', content: '⚙️ MsgList', ts: ts(), toolName: 'MsgList', toolResult: TOOL_OUT }));
    lines.push(JSON.stringify({ role: 'assistant', content: ANSWER, ts: ts(), replyFinal: true }));
  }
  writeFileSync(join(root, 'sessions', `${sessionId}.jsonl`), `${lines.join('\n')}\n`);
}
delete process.env.ELANOUS_SESSION_ROOT;
const pasteFile = join(root, 'paste.txt');
writeFileSync(pasteFile, PASTE);

// ── tmux ──
const SESS = `long-paste-e2e-${process.pid}`;
const tmux = (...args: string[]) => Bun.spawnSync(['tmux', ...args], { stdout: 'pipe', stderr: 'pipe' });
const capture = () => new TextDecoder().decode(tmux('capture-pane', '-t', SESS, '-p').stdout);
const env = `NODE_ENV=development XDG_STATE_HOME=${join(root, 'xdg')} ELANOUS_STATE_DIR=${join(root, 'state')} TERM=xterm-256color`;
const launch = `env -u ELANOUS_CONFIG_DIR -u XDG_CONFIG_HOME -u ELANOUS_SESSION_ROOT ${env} bun bin/elanous.mjs --test=${root} --tui next --resume ${sessionId}`;
tmux('kill-session', '-t', SESS);
tmux('new-session', '-d', '-s', SESS, '-x', '160', '-y', '50', `cd ${tree} && ${launch}; echo E2E-EXITED; sleep 600`);

const composer = (s: string) => s.includes('Ctrl+Q') || s.split('\n').some((l) => /^\s*[❯›]\s*$/.test(l));
const waitFor = async (ok: (s: string) => boolean, ms: number) => {
  const end = Date.now() + ms; let s = '';
  while (Date.now() < end) { s = capture(); if (ok(s)) return s; await Bun.sleep(250); }
  return null;
};
const PROBE = 'Z';
const countProbe = (s: string) => (s.split('\n').slice(-12).join('\n').match(/Z/g) ?? []).length;
const probe = async () => {
  const before = countProbe(capture());
  const t0 = Date.now();
  tmux('send-keys', '-t', SESS, '-l', PROBE);
  while (Date.now() - t0 < PROBE_CAP_MS) { if (countProbe(capture()) > before) return Date.now() - t0; await Bun.sleep(20); }
  return PROBE_CAP_MS;
};
const result: Record<string, unknown> = { label, mode, small, tree, sessionId, probeCapMs: PROBE_CAP_MS };
const save = () => writeFileSync(join(out, `${label}.json`), JSON.stringify(result, null, 2));
try {
  if (!await waitFor(composer, 120_000)) throw new Error('boot timeout');
  await Bun.sleep(3000);
  result.idleProbeMs = [await probe(), await probe()];
  tmux('send-keys', '-t', SESS, 'BSpace', 'BSpace');
  const t0 = Date.now();
  if (mode === 'paste' || mode === 'rawpaste') {
    tmux('load-buffer', '-b', SESS, pasteFile);
    // -p = bracketed paste (the app sees one paste → chip) · without it the text arrives as keystrokes.
    tmux('paste-buffer', ...(mode === 'paste' ? ['-p'] : []), '-b', SESS, '-t', SESS);
    await Bun.sleep(500);
    tmux('send-keys', '-t', SESS, 'Enter');
  } else if (mode === 'type') {
    for (const line of PASTE.split('\n')) { tmux('send-keys', '-t', SESS, '-l', line); tmux('send-keys', '-t', SESS, 'Enter'); }
  } else {
    tmux('send-keys', '-t', SESS, '-l', SHORT);
    tmux('send-keys', '-t', SESS, 'Enter');
  }
  result.submitMs = Date.now() - t0;
  await waitFor((s) => /Thinking|Responding|esc to interrupt/.test(s), 60_000);
  await Bun.sleep(2000);
  const after: number[] = [];
  result.busyProbeMs = after;
  for (let i = 0; i < probes; i++) { after.push(await probe()); save(); await Bun.sleep(1500); }
  writeFileSync(join(out, `${label}-screen.txt`), capture());
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  writeFileSync(join(out, `${label}-screen.txt`), capture());
} finally {
  save();
  tmux('send-keys', '-t', SESS, 'C-q');
  await waitFor((s) => s.includes('E2E-EXITED'), 30_000);
  tmux('kill-session', '-t', SESS);
  llm.stop(true);
  console.log(JSON.stringify(result));
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
}
