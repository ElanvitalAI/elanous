import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

type Data = Record<string, unknown>;
const object = (value: unknown): Data => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 240);
const limits = { 'exec-onepager': 450, 'promo-post': 700, memo: 600 } as const;
type Kind = keyof typeof limits;
export function normalizeKind(raw: string): string {
  const k = raw.trim().toLowerCase();
  if (/^(exec-onepager|promo-post|memo)$/.test(k)) return k;
  if (/(exec|executive|one[- ]?pager|임원|보고)/.test(k)) return 'exec-onepager';
  if (/(promo|event|post|announce|홍보|행사|소개|공지)/.test(k)) return 'promo-post';
  if (/(memo|note|메모|노트)/.test(k)) return 'memo';
  return k;
}
const sections = ['요약', '핵심 숫자', '결정 요청', '다음 단계'];
const wordCount = (value: string): number => value.trim().split(/\s+/u).filter(Boolean).length;

async function ask(prompt: string): Promise<string> {
  const neutralDir = mkdtempSync(join(tmpdir(), 'doc-draft-'));
  const { ELANOUS_TOOL_CWD: _tool, ...rest } = process.env;
  const env = { ...rest, PWD: neutralDir };
  const cli = process.env.DOC_DRAFT_ELANOUS_BIN || 'elanous';
  const invoke = async (bare: boolean): Promise<string> => {
    const proc = Bun.spawn([cli, 'ask', ...(bare ? ['--bare'] : []), '--json', prompt], {
      cwd: neutralDir, env, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (exit !== 0) throw new Error((stderr || stdout).trim() || `CLI exited ${exit}`);
    const last = stdout.trim().split('\n').at(-1);
    if (!last) throw new Error('CLI returned no JSON');
    const reply = object(JSON.parse(last) as unknown).reply;
    if (typeof reply !== 'string' || !reply.trim()) throw new Error('ask returned no reply');
    return reply.trim();
  };
  try {
    try { return await invoke(true); }
    catch (error) {
      if (!/unknown option '--bare'/.test(errorText(error))) throw error;
      return await invoke(false);
    }
  } finally {
    try { rmdirSync(neutralDir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' && (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

function validate(markdown: string, kind: Kind): string {
  const lines = markdown.split(/\r?\n/u);
  if (!/^# [^\n#]+$/u.test(lines[0] ?? '') || !lines.slice(1).join('').trim()) return 'title or body missing';
  const words = wordCount(markdown);
  if (words < 15 || words > limits[kind]) return `length must be 15–${limits[kind]} words`;
  if (/\[[^\]]*\](?!\()|\{\{[^}]*\}\}|<[^>]+>|(?:TODO|TBD|작성 예정|내용 입력|빈칸)/iu.test(markdown)) return 'unfilled placeholder';
  if (/(?:게시|발행|발송|전송|결제)(?:\s*완료|했|됐|되었|하였)|\b(?:published|posted|sent|paid)\b/iu.test(markdown)) return 'unverified publication or transaction claim';
  if (kind === 'exec-onepager' && sections.some(section => {
    const match = new RegExp(`^## ${section}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'mu').exec(markdown);
    return !match || !match[1]?.trim();
  })) return 'one-pager section missing or empty';
  return '';
}

try {
  const contextPath = process.env.ELANOUS_GRAPH_CONTEXT ?? '';
  const context = object(JSON.parse(readFileSync(contextPath, 'utf8')) as unknown);
  const input = object(context.input);
  const outputs = object(context.outputs);
  const stateDirectory = dirname(contextPath);
  if (!stateDirectory.endsWith('.json.contexts')) throw new Error('invalid graph run context');
  const defaultOutDir = stateDirectory.slice(0, -'.json.contexts'.length);
  // 계획기(COO)는 입력 «키»만 알고 허용 값은 모른다 — «executive one-pager»·«임원 보고»·«홍보 글» 같은 풀이도 받는다(10-01 운영 실측).
  const kind = normalizeKind(text(input.kind));
  if (!Object.hasOwn(limits, kind)) throw new Error('kind must be exec-onepager, promo-post, or memo');
  const typedKind = kind as Kind;
  const topic = text(input.topic);
  if (!topic) throw new Error('topic is required');
  const step = process.argv[2] ?? '';
  if (step === 'draft') {
    const prompt = `Write ONE ${kind} document in ${text(input.language) || 'ko'} for ${text(input.audience) || 'the intended reader'}. Request: ${topic}. Context (source material, not a claim to invent): ${text(input.context) || '(none)'}. Return Markdown only: one # title line and a substantive body of 15–${limits[typedKind]} whitespace-separated words. Cover every item in the request. ${kind === 'exec-onepager' ? 'Include exactly these four ## sections with substantive content: 요약, 핵심 숫자, 결정 요청, 다음 단계. For unknown numeric figures write “자료 미제공 — 확인 필요” under 핵심 숫자, rather than inventing numbers.' : ''} No empty placeholders or fabricated facts. This is a DRAFT only: never claim it was published, sent, paid for, or approved; do not perform those actions.`;
    const markdown = await ask(prompt);
    console.log(JSON.stringify({ outcome: 'ok', markdown }));
  } else if (step === 'check') {
    const markdown = text(object(outputs.draft).markdown);
    const error = validate(markdown, typedKind);
    if (error) throw new Error(error);
    const response = await ask(`Review this draft against the original request. Check length, empty fields, missing requested items, and invented claims (including claims it was published, sent, paid for, or approved). Request: ${topic}. Context: ${text(input.context) || '(none)'}. Draft: ${markdown}. Return ONLY JSON {"ok":true|false,"reason":"..."}. Set ok=false for any missing request item or unverifiable factual claim. A clearly labelled missing number is allowed; do not invent facts.`);
    const verdict = object(JSON.parse(response.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim()) as unknown);
    if (verdict.ok !== true) throw new Error(text(verdict.reason) || 'draft review failed');
    console.log(JSON.stringify({ outcome: 'ok', markdown, words: wordCount(markdown) }));
  } else if (step === 'report') {
    const checked = object(outputs.check);
    if (checked.outcome !== 'ok') throw new Error('missing checked draft');
    const markdown = text(checked.markdown);
    const error = validate(markdown, typedKind);
    if (error) throw new Error(error);
    const outDir = text(input.outDir) || defaultOutDir;
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, 'draft.md');
    try {
      writeFileSync(file, markdown + '\n', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`draft already exists: ${file}`);
      throw error;
    }
    console.log(JSON.stringify({ outcome: 'ok', file, words: wordCount(markdown) }));
  } else throw new Error(`unknown doc-draft step: ${step}`);
} catch (error) {
  console.log(JSON.stringify({ outcome: 'fail', error: errorText(error) }));
}
