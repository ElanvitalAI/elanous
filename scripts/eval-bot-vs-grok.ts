// 봇 UX «그록봇 수준» 판별 — 같은 질문 묶음을 elanous chat(글자) · elanous agent(도구) · xAI Grok 에 던지고 원문·시간을 남긴다.
// 사용: bun scripts/eval-bot-vs-grok.ts <outDir> <repoCwd> · Grok 모델 = 사다리 `budget` 칸(tierModel)   (키 값은 출력하지 않는다)
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tierModel } from '../src/llm/model-defaults.js';

const [,, outDir, repoCwd] = process.argv;
mkdirSync(outDir, { recursive: true });

type Q = { id: string; axis: string; text: string; session?: string; needsTools?: boolean };
const QUESTIONS: Q[] = [
  { id: 'q01', axis: 'smalltalk', text: '안녕, 오늘 뭐 도와줄 수 있어? 세 줄 안으로.' },
  { id: 'q02', axis: 'smalltalk', text: '요즘 좀 지쳤어. 짧게 한마디 해줘.' },
  { id: 'q03', axis: 'fact', text: '서울에서 부산까지 KTX 로 대략 몇 시간 걸려? 한 줄로.' },
  { id: 'q04', axis: 'fact', text: 'HWPX 파일 형식이 뭐야? 두 줄로.' },
  { id: 'q05', axis: 'context', session: 'ctx', text: '내 프로젝트 이름은 elanous 야. 기억해 둬. «알겠다» 한 마디만.' },
  { id: 'q06', axis: 'context', session: 'ctx', text: '우리 팀은 네 세션으로 나뉘어 있어: OP, MK, TC, UX. 이것도 기억해. 한 마디만.' },
  { id: 'q07', axis: 'context', session: 'ctx', text: '내 프로젝트 이름이랑 팀 세션 약자 넷을 한 줄로 말해 봐.' },
  { id: 'q08', axis: 'tools', needsTools: true, text: '지금 작업 폴더(git 저장소)에서 가장 최근 커밋 제목 세 개를 알려줘.' },
  { id: 'q09', axis: 'tools', needsTools: true, text: 'apps/pwa 폴더에 파일이 대략 몇 개야? 숫자 하나로.' },
  { id: 'q10', axis: 'tools', needsTools: true, text: '오늘 날짜를 한국 시간으로 알려줘.' },
  { id: 'q11', axis: 'recovery', needsTools: true, text: 'docs/NOPE-does-not-exist-xyz.md 파일을 요약해줘.' },
  { id: 'q12', axis: 'recovery', text: '내가 어제 너한테 부탁한 일 결과 알려줘.' },
];

type Row = { id: string; axis: string; target: string; ms: number; ok: boolean; reply: string; meta?: Record<string, unknown> };
const rows: Row[] = [];

function runElanous(mode: 'chat' | 'agent', q: Q, session?: string): Row {
  const args = [mode, '--json', ...(session ? ['--session', session] : ['--new']), q.text];
  const t0 = Date.now();
  const r = spawnSync('elanous', args, { cwd: repoCwd, encoding: 'utf8', timeout: 240_000, maxBuffer: 64 << 20 });
  const ms = Date.now() - t0;
  const line = (r.stdout ?? '').trim().split('\n').reverse().find((l) => l.startsWith('{')) ?? '';
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(line); } catch { /* keep empty */ }
  const reply = typeof parsed.reply === 'string' ? parsed.reply : ((r.stderr ?? '').slice(-400) || '(no reply)');
  return { id: q.id, axis: q.axis, target: `elanous-${mode}`, ms, ok: r.status === 0 && typeof parsed.reply === 'string', reply, meta: { sessionId: parsed.sessionId, provider: parsed.provider, model: parsed.model, status: r.status } };
}

function xaiKey(): string {
  const env = readFileSync(join(process.env.HOME!, '.claude/skills/omni-crawl/.env'), 'utf8');
  return /^XAI_API_KEY=(.*)$/m.exec(env)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
}
const grokHistory = new Map<string, Array<{ role: string; content: string }>>();
async function runGrok(q: Q): Promise<Row> {
  if (q.needsTools) return { id: q.id, axis: q.axis, target: 'grok', ms: 0, ok: false, reply: 'n/a — 작업 폴더·도구 없음(대조 제외)' };
  const history = q.session ? (grokHistory.get(q.session) ?? []) : [];
  const messages = [...history, { role: 'user', content: q.text }];
  const t0 = Date.now();
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${xaiKey()}` },
    body: JSON.stringify({ model: tierModel('budget', 'grok'), messages }),
  });
  const ms = Date.now() - t0;
  const body = await res.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }> };
  const reply = body.choices?.[0]?.message?.content ?? `(http ${res.status})`;
  if (q.session) grokHistory.set(q.session, [...messages, { role: 'assistant', content: reply }]);
  return { id: q.id, axis: q.axis, target: 'grok', ms, ok: res.ok, reply };
}

for (const mode of ['chat', 'agent'] as const) {
  const sessions = new Map<string, string>();
  for (const q of QUESTIONS) {
    const row = runElanous(mode, q, q.session ? sessions.get(q.session) : undefined);
    if (q.session && !sessions.has(q.session) && typeof row.meta?.sessionId === 'string') sessions.set(q.session, row.meta.sessionId as string);
    rows.push(row);
    console.log(`${mode} ${q.id} ${row.ok ? 'ok' : 'FAIL'} ${(row.ms / 1000).toFixed(1)}s`);
    writeFileSync(join(outDir, 'rows.json'), JSON.stringify(rows, null, 2));
  }
}
for (const q of QUESTIONS) {
  const row = await runGrok(q);
  rows.push(row);
  console.log(`grok ${q.id} ${row.ok ? 'ok' : 'skip/FAIL'} ${(row.ms / 1000).toFixed(1)}s`);
}
writeFileSync(join(outDir, 'rows.json'), JSON.stringify(rows, null, 2));
console.log('done', rows.length);
