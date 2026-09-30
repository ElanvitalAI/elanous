import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join } from 'node:path';

type Data = Record<string, unknown>;
const object = (v: unknown): Data => v && typeof v === 'object' && !Array.isArray(v) ? v as Data : {};
const text = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const fields = ['name', 'title', 'company', 'email', 'phone', 'url', 'linkedin', 'language'] as const;
const clean = (v: unknown) => text(v) || null;
const line = (v: unknown) => text(v).replace(/[\r\n|]/g, ' ');

// Find the first balanced object, respecting JSON string escapes and braces in quoted text.
function firstObject(raw: string): Data {
  for (let start = raw.indexOf('{'); start !== -1; start = raw.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          const parsed = JSON.parse(raw.slice(start, i + 1));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Data;
        } catch { /* try the next object */ }
        break;
      }
    }
  }
  throw new Error(`JSON 객체 없음: ${raw.slice(0, 200)}`);
}

async function cli(bin: string, args: string[]): Promise<string> {
  const child = Bun.spawn([bin, ...args], { stdout: 'pipe', stderr: 'pipe', env: process.env });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status !== 0) throw new Error(`${args[0]} 실패: ${(stderr || stdout).slice(0, 200)}`);
  return stdout;
}

function absolute(path: string, label: string): string {
  const expanded = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  if (!isAbsolute(expanded)) throw new Error(`${label}: 절대 경로 필요`);
  return expanded;
}

function sources(raw: string): { title: string; url: string; snippet: string }[] {
  const data = object(JSON.parse(raw));
  // research --json exposes the human-readable result in `output`.
  const output = text(data.output);
  return output.split('\n').flatMap(row => {
    const match = row.match(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/) ?? row.match(/(https?:\/\/[^\s)]+)/);
    if (!match) return [];
    return [{ title: match[2] ? match[1]! : row.replace(match[0], '').trim(), url: match[2] ?? match[1]!, snippet: row.replace(match[0], '').trim() }];
  });
}

const contextFile = process.env.ELANOUS_GRAPH_CONTEXT;
if (!contextFile) throw new Error('ELANOUS_GRAPH_CONTEXT 필요');
const context = object(JSON.parse(readFileSync(contextFile, 'utf8')));
const input = object(context.input);
const outputs = object(context.outputs);
const step = process.argv[2];
const elanous = process.env.CARD_FOLLOWUP_ELANOUS_BIN || 'elanous';
const codex = process.env.CARD_FOLLOWUP_CODEX_BIN || 'codex';
const result = (data: Data) => console.log(JSON.stringify(data.outcome ? data : { outcome: 'ok', ...data }));

try {
  if (step === 'read-card') {
    const image = absolute(text(input.image), 'image');
    if (!/\.(png|jpe?g|heic)$/i.test(extname(image))) throw new Error('image: png/jpg/heic 필요');
    if (!existsSync(image)) throw new Error('image: 파일 없음');
    const raw = await cli(codex, ['exec', '-i', image, '명함 사진에서 읽을 수 있는 값만 JSON 객체로 출력하라: name, title, company, email, phone, url, linkedin, language. 빈 칸은 null. 추측 금지.']);
    const card = firstObject(raw);
    const normalized = Object.fromEntries(fields.map(field => [field, clean(card[field])]));
    result({ card: normalized, image });
  } else if (step === 'research') {
    const read = object(outputs['read-card']);
    const card = object(read.card ?? read);
    const company = text(card.company), name = text(card.name);
    if (!company && !name) throw new Error('조사할 이름·회사 없음');
    const queries = [company || name, [name, company].filter(Boolean).join(' ')];
    const hits = (await Promise.all(queries.map(query => cli(elanous, ['--test', 'research', '--json', '--limit', '5', query])))).flatMap(sources);
    const unique = [...new Map(hits.map(hit => [hit.url, hit])).values()];
    // Only the exact result text may be reported as a company fact, never a model-invented summary.
    result({ summary: unique.length ? unique[0]!.title : null, news: unique.slice(1, 3).map(hit => hit.title), sources: unique });
  } else if (step === 'draft') {
    const read = object(outputs['read-card']);
    const card = object(read.card ?? read);
    const research = object(outputs.research);
    const evidence = (Array.isArray(research.sources) ? research.sources.map(object) : [])
      .filter(source => /^https?:\/\//.test(text(source.url)));
    const language = text(input.language) || text(card.language) || 'ko';
    if (!['ko', 'en'].includes(language)) throw new Error('language: ko 또는 en 필요');
    const contextLine = text(input.context);
    const numbered = evidence.map((source, index) => ({ id: `S${index + 1}`, title: text(source.title), snippet: text(source.snippet) }));
    const marker = /\s*\[S(\d+)\]/g;
    const strip = (value: string) => value.replace(marker, '').trim();
    const sentencesOf = (value: string) => value.split(/(?<=[.!?。！？])\s+|\n+/).map(s => s.trim()).filter(Boolean);
    const ask = async (payload: Data): Promise<Data> => {
      const response = JSON.parse(await cli(elanous, ['--test', 'ask', '--json', JSON.stringify(payload)])) as Data;
      return firstObject(typeof response.reply === 'string' ? response.reply : JSON.stringify(response));
    };
    const instruction = 'JSON 객체만 출력: subject, body (120~200자 · [S#] 표시는 글자 수에서 뺀다), linkedin (300자 이하), question. context가 있으면 body에 그 문구를 그대로 한 번 포함. '
      + '명함 필드(이름·직함·회사)와 context 는 출처 없이 써도 된다. 그 밖의 회사·사람·시장 사실은 evidence 에 있는 것만 쓰고, 그 문장 끝에 근거 번호를 [S1] 처럼 붙인다. '
      + 'evidence 에 없는 사실(매출·순위·규모·수상·최근 소식 등)은 쓰지 말 것. email이 없으면 메일 주소를 만들지 말 것. 어떤 메시지도 보내지 말 것.';
    let feedback = '';
    let accepted: { warnings: string[]; draft: Data; facts: { text: string; url: string }[] } | undefined;
    let lastProblem = '';
    for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
      const draft = await ask({ task: 'draft', instruction: instruction + feedback, card, context: contextLine, sender: text(input.sender), language, evidence: numbered });
      const parts = { subject: text(draft.subject), body: text(draft.body), linkedin: text(draft.linkedin), question: text(draft.question) };
      if (!parts.subject || !parts.body || !parts.linkedin || !parts.question) { lastProblem = '초안 필수 필드 없음'; feedback = ' 이전 응답에 필드가 빠졌다.'; continue; }
      const body = strip(parts.body), linkedin = strip(parts.linkedin);
      const shape: string[] = [];
      if (body.length < 120 || body.length > 200) shape.push(`메일 본문 120~200자 범위 밖(${body.length}자)`);
      // LinkedIn 한도는 한 번 다시 부르고, 그래도 넘으면 막지 않고 보고서에 경고로 남긴다(보내기 전 사람이 고친다).
      const linkedinOver = linkedin.length > 300;
      if (linkedinOver && attempt === 0) shape.push(`LinkedIn 300자 초과(${linkedin.length}자)`);
      if (contextLine && !body.includes(contextLine)) shape.push('메일 본문에 context 없음');
      const sentences = Object.values(parts).flatMap(sentencesOf).map(sentence => ({
        raw: sentence, text: strip(sentence), cites: [...sentence.matchAll(marker)].map(match => Number(match[1])),
      }));
      const badCite = sentences.find(sentence => sentence.cites.some(n => n < 1 || n > evidence.length));
      if (badCite) shape.push(`없는 출처 번호: ${badCite.raw}`);
      if (shape.length) { lastProblem = shape.join(' · '); feedback = ` 이전 초안 문제: ${lastProblem}. 모두 고쳐 다시 작성하라.`; continue; }
      // Every sentence is judged against the card, the context and only the evidence it cites — a company name alone is identity, not a claim.
      const verdict = await ask({
        task: 'verify',
        instruction: '각 문장에 대해, 받는 사람·그 회사·시장에 관한 사실 주장이 명함 필드, context, 또는 그 문장이 인용한 evidence 로 뒷받침되는지 판정하라. 인사·호칭·명함에 있는 이름/회사/직함 언급·제안·질문·보내는 사람의 의도는 사실 주장이 아니다. JSON 객체만 출력: {"unsupported":[뒷받침 안 되는 문장 번호]}',
        card, context: contextLine,
        sentences: sentences.map((sentence, i) => ({ i, text: sentence.text, evidence: sentence.cites.map(n => numbered[n - 1]) })),
      });
      if (!Array.isArray(verdict.unsupported)) throw new Error('사실 검증 응답을 읽지 못했다');
      const unsupported = verdict.unsupported.map(Number).filter(i => Number.isInteger(i) && sentences[i]).map(i => sentences[i]!.text);
      if (unsupported.length) { lastProblem = `출처 없는 회사 사실: ${unsupported.join(' / ')}`; feedback = ` 이전 초안에서 근거 없는 문장: ${unsupported.join(' / ')}. 그 문장을 빼거나 evidence 로 뒷받침되는 문장으로 바꿔라.`; continue; }
      const facts = sentences.flatMap(sentence => sentence.cites.map(n => ({ text: sentence.text, url: text(evidence[n - 1]!.url) })));
      accepted = { warnings: linkedinOver ? ['LinkedIn 문구 300자 초과 — 전송 전 수정 필요'] : [], draft: { subject: strip(parts.subject), body, linkedin, question: strip(parts.question) }, facts: [...new Map(facts.map(f => [`${f.text}\n${f.url}`, f])).values()] };
    }
    if (!accepted) throw new Error(lastProblem || '초안 생성 실패');
    result({ ...accepted.draft, companyFacts: accepted.facts, destination: card.email ? ['email', 'LinkedIn'] : ['LinkedIn'], warnings: accepted.warnings, language });
  } else if (step === 'report') {
    const read = object(outputs['read-card']);
    const card = object(read.card ?? read);
    const research = object(outputs.research), draft = object(outputs.draft);
    if (!text(draft.subject) || !text(draft.linkedin) || !text(draft.question)) throw new Error('초안 없음');
    const fallback = dirname(contextFile).endsWith('.json.contexts') ? dirname(contextFile).slice(0, -'.json.contexts'.length) : dirname(contextFile);
    const outDir = input.outDir === undefined ? fallback : absolute(text(input.outDir), 'outDir');
    const hits = Array.isArray(research.sources) ? research.sources.map(object) : [];
    const warnings = Array.isArray(draft.warnings) ? draft.warnings.map(text).filter(Boolean) : [];
    const md = ['# 네트워킹 팔로업 초안', '', '## 명함', '| 필드 | 값 |', '| --- | --- |',
      ...fields.map(field => `| ${field} | ${line(card[field]) || 'null'} |`), '',
      '## 조사 요약', hits.length ? line(research.summary) : '조사 결과 없음',
      ...((Array.isArray(research.news) ? research.news : []).map(v => `- ${line(v)}`)),
      '## 출처', ...(hits.length ? hits.map(hit => `- ${line(hit.title)} — ${text(hit.url)}`) : ['- 조사 결과 없음']), '',
      '## 보낼 곳', ...((Array.isArray(draft.destination) ? draft.destination : []).map(v => `- ${line(v)}`)), '',
      '## 팔로업 메일', `제목: ${line(draft.subject)}`, '', text(draft.body), '',
      '## LinkedIn 초대 문구', text(draft.linkedin), '', '## 대화 이어 갈 질문', text(draft.question), '',
      '## 초안의 사실과 출처', ...((Array.isArray(draft.companyFacts) && draft.companyFacts.length ? draft.companyFacts : ['출처를 인용한 문장 없음']).map(v => typeof v === 'string' ? `- ${v}` : `- ${line(object(v).text)} — ${text(object(v).url)}`)),
      ...(warnings.length ? ['## 경고', ...warnings.map(v => `- ${v}`)] : []), '', '※ 초안만 생성했습니다. 전송은 사람이 결정합니다.', ''].join('\n');
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const report = { card, research, draft, warnings, sent: false };
    const markdown = join(outDir, 'followup.md'), json = join(outDir, 'followup.json');
    writeFileSync(markdown, md, { mode: 0o600 });
    writeFileSync(json, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    result({ markdown, json });
  } else throw new Error(`unknown step: ${step}`);
} catch (error) {
  result({ outcome: 'fail', reason: error instanceof Error ? error.message : String(error) });
}
