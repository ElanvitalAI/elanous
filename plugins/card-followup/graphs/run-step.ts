import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, basename } from 'node:path';
import { buildStrategy, crmRow, upsertCrm } from './sales-strategy.js';

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

// The page's own <title> and meta/og description — the company's words about itself. 5 s cap; null on any failure.
async function readPage(url: string): Promise<{ title: string; description: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 card-followup' } });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('html')) return null;
    const html = (await res.text()).slice(0, 200_000);
    const decode = (v: string) => v.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
    const meta = (key: string) => {
      for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
        if (new RegExp(`(?:name|property)=["']${key}["']`, 'i').test(tag)) {
          const content = /content=["']([^"']*)["']/i.exec(tag)?.[1];
          if (content) return decode(content);
        }
      }
      return '';
    };
    const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '') || meta('og:title');
    const description = meta('description') || meta('og:description');
    return title && description ? { title, description } : null;
  } catch { return null; }
}

function sources(raw: string): { title: string; url: string; snippet: string }[] {
  const data = object(JSON.parse(raw));
  // research --json exposes the human-readable result in `output`.
  const output = text(data.output);
  return output.split('\n').flatMap(row => {
    const match = row.match(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/) ?? row.match(/(https?:\/\/[^\s)]+)/);
    if (!match) return [];
    // A logo or thumbnail row («[![](…)](…png)») is not a source.
    if (/^\s*[-*]?\s*\[?!\[/.test(row) || /\.(?:png|jpe?g|gif|svg|webp)(?:[?#]|$)/i.test(match[2] ?? match[1]!)) return [];
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
    // The prompt goes before `-i`: `--image` takes several files, so a prompt after it is read as another image
    // and codex answers «No prompt provided» (10-01 live run). The graph may run outside a git checkout.
    const raw = await cli(codex, ['exec', '--skip-git-repo-check', '명함 사진에서 읽을 수 있는 값만 JSON 객체로 출력하라: name, title, company, email, phone, url, linkedin, language(ko 또는 en). 빈 칸은 null. 추측 금지.', '-i', image]);
    const card = firstObject(raw);
    const normalized = Object.fromEntries(fields.map(field => [field, clean(card[field])]));
    result({ card: normalized, image });
  } else if (step === 'research') {
    const read = object(outputs['read-card']);
    const card = object(read.card ?? read);
    const company = text(card.company), name = text(card.name);
    if (!company && !name) throw new Error('조사할 이름·회사 없음');
    // The card's own site is the strongest query: «Elanvital AI» alone ranks vital.ai and elanvital.co above elanvital.ai
    // (10-01 dry run: 19 hits, none from the company), while «elanvital.ai» returns the site itself.
    const siteQuery = text(card.url).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]!.toLowerCase();
    const queries = [...new Set([...(siteQuery.includes('.') ? [siteQuery] : []), company || name, [name, company].filter(Boolean).join(' ')])];
    const hits = (await Promise.all(queries.map(query => cli(elanous, ['research', '--json', '--limit', '5', query])))).flatMap(sources);
    const unique = [...new Map(hits.map(hit => [hit.url, hit])).values()];
    // Only the exact result text may be reported as a company fact, never a model-invented summary.
    // Put results that name the card's company (or its site) first; if none does, say nothing as a summary —
    // the first search hit was another company's page on the 10-01 live run («Vital AI» for Elanvital AI).
    const site = text(card.url).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]!.toLowerCase();
    const companyKey = company.toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
    const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
    const nameKey = squash(name);
    const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
    // The site counts by host («vercel.com», «docs.vercel.com»), never by substring — «someone.vercel.app» is a stranger's page.
    // The company counts by title only, and a title carrying the contact's name counts only on the company's own site:
    // a search cannot tell this Alex Rivera from another.
    const matches = (hit: { title: string; url: string }) => {
      const host = hostOf(hit.url);
      const onSite = !!site && (host === site || host.endsWith(`.${site}`));
      if (onSite) return true;
      // A bare-link row has the link as its «title» — that is a host, not a name.
      const title = /^https?:\/\//i.test(hit.title.trim()) ? '' : squash(hit.title);
      if (nameKey.length >= 3 && title.includes(nameKey)) return false;
      return companyKey.length >= 3 && title.includes(companyKey);
    };
    // Only hits that name the card's company or site are kept: a name search also returns other people with the
    // same name (10-01 live run: strangers' LinkedIn, Instagram and IMDb pages listed as this contact's sources).
    // A site hit often comes back as a bare link with no title or snippet («https://elanvital.ai» · «-»): nothing a
    // strategy can cite, and the verifier rejects claims resting on it (10-01 dry run: strategy failed twice on «who»).
    // Read the page's own <title> and description once instead, and keep one row per host.
    const thin = (hit: { title: string }) => /^https?:\/\//i.test(hit.title.trim()) || hostOf(`https://${hit.title.trim()}`) === hit.title.trim().toLowerCase();
    const seenHost = new Set<string>();
    const relevant: { title: string; url: string; snippet: string }[] = [];
    for (const hit of unique.filter(matches)) {
      const host = hostOf(hit.url);
      if (!thin(hit)) { relevant.push(hit); continue; }
      if (seenHost.has(host)) continue;
      seenHost.add(host);
      const page = await readPage(hit.url);
      if (page) relevant.push({ title: page.title, url: hit.url, snippet: page.description });
    }
    result({ summary: relevant.length ? relevant[0]!.title : null, news: relevant.slice(1, 3).map(hit => hit.title), sources: relevant, dropped: unique.length - relevant.length });
  } else if (step === 'strategy') {
    const read = object(outputs['read-card']);
    const card = object(read.card ?? read);
    const research = object(outputs.research);
    const ask = async (payload: Data): Promise<Data> => {
      const response = JSON.parse(await cli(elanous, ['ask', '--json', JSON.stringify(payload)])) as Data;
      return firstObject(typeof response.reply === 'string' ? response.reply : JSON.stringify(response));
    };
    const strategy = await buildStrategy({ card, research, context: text(input.context), offer: text(input.offer), ask });
    const fallback = dirname(contextFile).endsWith('.json.contexts') ? dirname(contextFile).slice(0, -'.json.contexts'.length) : dirname(contextFile);
    const outDir = input.outDir === undefined ? fallback : absolute(text(input.outDir), 'outDir');
    const crm = input.crm === undefined ? join(outDir, 'crm.csv') : absolute(text(input.crm), 'crm');
    const row = crmRow(card, strategy.fit, strategy.approach, strategy.nextAction, text(input.context), new Date());
    upsertCrm(crm, row);
    result({ ...strategy, crm, crmRow: row });
  } else if (step === 'draft') {
    const read = object(outputs['read-card']);
    const card = object(read.card ?? read);
    const research = object(outputs.research);
    const approach = object(object(outputs.strategy).approach);
    const evidence = (Array.isArray(research.sources) ? research.sources.map(object) : [])
      .filter(source => /^https?:\/\//.test(text(source.url)));
    // A card reader may answer «English»/«Korean»/«한국어» — fold them to the two codes the draft step writes in.
    const languageCode = (value: string) => ({ english: 'en', en: 'en', korean: 'ko', ko: 'ko', '한국어': 'ko', '영어': 'en' } as Record<string, string>)[value.toLowerCase()] ?? value;
    const language = languageCode(text(input.language) || text(card.language) || 'ko');
    if (!['ko', 'en'].includes(language)) throw new Error('language: ko 또는 en 필요');
    const contextLine = text(input.context);
    const numbered = evidence.map((source, index) => ({ id: `S${index + 1}`, title: text(source.title), snippet: text(source.snippet) }));
    const marker = /\s*\[S(\d+)\]/g;
    const strip = (value: string) => value.replace(marker, '').trim();
    const sentencesOf = (value: string) => value.split(/(?<=[.!?。！？])\s+|\n+/).map(s => s.trim()).filter(Boolean);
    const ask = async (payload: Data): Promise<Data> => {
      const response = JSON.parse(await cli(elanous, ['ask', '--json', JSON.stringify(payload)])) as Data;
      return firstObject(typeof response.reply === 'string' ? response.reply : JSON.stringify(response));
    };
    // A Korean meeting note on an English card used to be pasted verbatim into the English mail
    // («Hi Joosung, 마케터의 밤에서 인사.» · 10-01 dry run). Across languages the note is translated, not copied.
    const crossLanguage = language === 'en' && /[가-힣]/.test(contextLine);
    const contextRule = crossLanguage
      ? 'context 는 한국어 메모다 — 원문을 그대로 넣지 말고 영어로 옮겨 body 에서 한 번 언급하라. subject·body·linkedin·question 에 한글을 쓰지 말 것. '
      : 'context가 있으면 body에 그 문구를 그대로 한 번 포함. ';
    const instruction = 'JSON 객체만 출력: subject, body (120~200자 · [S#] 표시는 글자 수에서 뺀다), linkedin (300자 이하), question. ' + contextRule
      + '명함 필드(이름·직함·회사)와 context 는 출처 없이 써도 된다. 그 밖의 회사·사람·시장 사실은 evidence 에 있는 것만 쓰고, 그 문장 끝에 근거 번호를 [S1] 처럼 붙인다. '
      + 'approach.problem·proposal·channel 에 맞춰 메일과 LinkedIn 초안을 작성하되, 전략 문구도 회사·사람·시장 사실이면 위의 문장별 근거 규칙을 반드시 따를 것. '
      + 'evidence 에 없는 사실(매출·순위·규모·수상·최근 소식 등)은 쓰지 말 것. email이 없으면 메일 주소를 만들지 말 것. 어떤 메시지도 보내지 말 것.';
    let feedback = '';
    let accepted: { warnings: string[]; draft: Data; facts: { text: string; url: string }[] } | undefined;
    let lastProblem = '';
    for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
      const draft = await ask({ task: 'draft', instruction: instruction + feedback, card, context: contextLine, sender: text(input.sender), language, evidence: numbered, approach: { problem: text(approach.problem), proposal: text(approach.proposal), channel: text(approach.channel) } });
      const parts = { subject: text(draft.subject), body: text(draft.body), linkedin: text(draft.linkedin), question: text(draft.question) };
      if (!parts.subject || !parts.body || !parts.linkedin || !parts.question) { lastProblem = '초안 필수 필드 없음'; feedback = ' 이전 응답에 필드가 빠졌다.'; continue; }
      const body = strip(parts.body), linkedin = strip(parts.linkedin);
      const shape: string[] = [];
      if (body.length < 120 || body.length > 200) shape.push(`메일 본문 120~200자 범위 밖(${body.length}자)`);
      // LinkedIn 한도는 한 번 다시 부르고, 그래도 넘으면 막지 않고 보고서에 경고로 남긴다(보내기 전 사람이 고친다).
      const linkedinOver = linkedin.length > 300;
      if (linkedinOver && attempt === 0) shape.push(`LinkedIn 300자 초과(${linkedin.length}자)`);
      if (contextLine && !crossLanguage && !body.includes(contextLine)) shape.push('메일 본문에 context 없음');
      if (crossLanguage && /[가-힣]/.test([parts.subject, body, linkedin, parts.question].join(' '))) shape.push('영어 초안에 한글이 섞였다(context 는 영어로 옮길 것)');
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
    const research = object(outputs.research), draft = object(outputs.draft), strategy = object(outputs.strategy);
    const fit = object(strategy.fit), approach = object(strategy.approach), nextAction = object(strategy.nextAction);
    if (!text(draft.subject) || !text(draft.linkedin) || !text(draft.question)) throw new Error('초안 없음');
    const fallback = dirname(contextFile).endsWith('.json.contexts') ? dirname(contextFile).slice(0, -'.json.contexts'.length) : dirname(contextFile);
    const outDir = input.outDir === undefined ? fallback : absolute(text(input.outDir), 'outDir');
    const hits = Array.isArray(research.sources) ? research.sources.map(object) : [];
    const warnings = Array.isArray(draft.warnings) ? draft.warnings.map(text).filter(Boolean) : [];
    const crm = text(strategy.crm);
    const row = object(strategy.crmRow);
    if (!crm || !Array.isArray(fit.reasons) || !text(approach.who) || !text(approach.problem)
      || !text(approach.proposal) || !text(approach.channel) || !text(approach.timing)
      || !text(nextAction.what) || !text(nextAction.due) || !('fit_label' in row)) throw new Error('전략 없음');
    const md = ['# 명함 영업 계획', '', '## ① 사람·회사 분석',
      `${line(card.name) || '이름 없음'} · ${line(card.title) || '직함 없음'} · ${line(card.company) || '회사 없음'} · ${line(card.email) || '이메일 없음'}`,
      `조사 요약: ${hits.length ? line(research.summary) : '조사 결과 없음'}`, '',
      '## ② CRM 한 줄', `파일: ${basename(crm)}`, Object.entries(row).map(([key, value]) => `${key}: ${line(value)}`).join(' · '), '',
      '## ③ 타겟 판정', `점수: ${fit.score === null ? 'null' : String(fit.score)} · 라벨: ${line(fit.label)}`,
      ...(fit.reasons as unknown[]).map(v => `- ${line(object(v).text)} (${line(object(v).basis)})`), '',
      '## ④ 접근 전략', `- 누구에게: ${line(approach.who)}`, `- 어떤 문제: ${line(approach.problem)}`,
      `- 어떤 제안: ${line(approach.proposal)}`, `- 어느 채널: ${line(approach.channel)}`, `- 언제: ${line(approach.timing)}`,
      `- 다음 행동: ${line(nextAction.what)} · 기한: ${line(nextAction.due)}`, '',
      '## ⑤ 메일·LinkedIn 초안', '### 팔로업 메일', `제목: ${line(draft.subject)}`, '', text(draft.body), '',
      '### LinkedIn 초대 문구', text(draft.linkedin), '', '### 대화 이어 갈 질문', text(draft.question), '',
      '## 명함 전체 필드', '| 필드 | 값 |', '| --- | --- |', ...fields.map(field => `| ${field} | ${line(card[field]) || 'null'} |`), '',
      '## 추가 조사 결과', ...((Array.isArray(research.news) ? research.news : []).map(v => `- ${line(v)}`)), '',
      '## 출처', ...(hits.length ? hits.map(hit => `- ${line(hit.title)} — ${text(hit.url)}`) : ['- 조사 결과 없음']), '',
      '## 보낼 곳', ...((Array.isArray(draft.destination) ? draft.destination : []).map(v => `- ${line(v)}`)), '',
      '## 초안의 사실과 출처', ...((Array.isArray(draft.companyFacts) && draft.companyFacts.length ? draft.companyFacts : ['출처를 인용한 문장 없음']).map(v => typeof v === 'string' ? `- ${v}` : `- ${line(object(v).text)} — ${text(object(v).url)}`)),
      ...(warnings.length ? ['## 경고', ...warnings.map(v => `- ${v}`)] : []), '', '※ 초안만 생성했습니다. 전송은 사람이 결정합니다.', ''].join('\n');
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const report = { card, research, fit, approach, nextAction, crm, draft, warnings, sent: false };
    const markdown = join(outDir, 'followup.md'), json = join(outDir, 'followup.json');
    writeFileSync(markdown, md, { mode: 0o600 });
    writeFileSync(json, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    result({ markdown, json });
  } else throw new Error(`unknown step: ${step}`);
} catch (error) {
  result({ outcome: 'fail', reason: error instanceof Error ? error.message : String(error) });
}
