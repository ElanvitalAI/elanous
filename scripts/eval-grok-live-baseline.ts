// 대조군 v2 — xAI Responses API · 추론 모델(저장소 GROK_SEARCH_MODEL) · web_search ⊕ x_search 켬. 그록봇 «제품» 은 아니다.
// 사용: bun eval-grok-live.ts <repo-checkout> <outDir>   (키 값은 출력하지 않는다)
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [,, repo, outDir] = process.argv;
mkdirSync(outDir, { recursive: true });
const { grokAgentSearch, GROK_SEARCH_MODEL } = await import(join(repo, 'src/grok/agent-search.js'));
const env = readFileSync(join(process.env.HOME!, '.claude/skills/omni-crawl/.env'), 'utf8');
const apiKey = /^XAI_API_KEY=(.*)$/m.exec(env)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '';

type Q = { id: string; text: string; session?: string };
const QS: Q[] = [
  { id: 'q01', text: '안녕, 오늘 뭐 도와줄 수 있어? 세 줄 안으로.' },
  { id: 'q02', text: '요즘 좀 지쳤어. 짧게 한마디 해줘.' },
  { id: 'q03', text: '서울에서 부산까지 KTX 로 대략 몇 시간 걸려? 한 줄로.' },
  { id: 'q04', text: 'HWPX 파일 형식이 뭐야? 두 줄로.' },
  { id: 'q05', session: 'ctx', text: '내 프로젝트 이름은 elanous 야. 기억해 둬. «알겠다» 한 마디만.' },
  { id: 'q06', session: 'ctx', text: '우리 팀은 네 세션으로 나뉘어 있어: OP, MK, TC, UX. 이것도 기억해. 한 마디만.' },
  { id: 'q07', session: 'ctx', text: '내 프로젝트 이름이랑 팀 세션 약자 넷을 한 줄로 말해 봐.' },
  { id: 'q10', text: '오늘 날짜를 한국 시간으로 알려줘.' },
  { id: 'q12', text: '내가 어제 너한테 부탁한 일 결과 알려줘.' },
];
const history: string[] = [];
const rows: unknown[] = [];
for (const q of QS) {
  const systemPrompt = q.session && history.length ? `이전 대화:\n${history.join('\n')}` : undefined;
  const t0 = Date.now();
  const r = await grokAgentSearch(q.text, { apiKey, tools: ['web_search', 'x_search'], ...(systemPrompt ? { systemPrompt } : {}), timeoutMs: 90_000 });
  const ms = Date.now() - t0;
  if (q.session) history.push(`사용자: ${q.text}`, `어시스턴트: ${r.text}`);
  rows.push({ id: q.id, target: 'grok-live', model: GROK_SEARCH_MODEL, ms, ok: r.ok, reply: r.text, citations: (r.citations ?? []).length, error: r.error });
  console.log(`grok-live ${q.id} ${r.ok ? 'ok' : 'FAIL'} ${(ms / 1000).toFixed(1)}s cites=${(r.citations ?? []).length}`);
}
writeFileSync(join(outDir, 'grok-live.rows.json'), JSON.stringify(rows, null, 2));
console.log('done', rows.length);
