import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type Data = Record<string, unknown>;
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

type Fit = {
  score: number | null;
  label: 'high' | 'medium' | 'low' | 'unknown';
  reasons: { text: string; basis: string }[];
};
type Approach = { who: string; problem: string; proposal: string; channel: string; timing: string };
type NextAction = { what: string; due: string };
type Strategy = { fit: Fit; approach: Approach; nextAction: NextAction };
type CrmRow = Record<(typeof columns)[number], string>;
const columns = ['name', 'company', 'title', 'email', 'interest', 'met_context', 'fit_score', 'fit_label', 'next_action', 'due', 'updated_at'] as const;

function parseAnswer(raw: unknown): Data {
  const response = object(raw);
  if (typeof response.reply === 'string') {
    const reply = response.reply;
    const start = reply.indexOf('{'), end = reply.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('strategy 응답 JSON 객체 없음');
    return object(JSON.parse(reply.slice(start, end + 1)));
  }
  return response;
}

async function defaultAsk(payload: Data): Promise<unknown> {
  const child = Bun.spawn(['elanous', 'ask', '--json', JSON.stringify(payload)], { stdout: 'pipe', stderr: 'pipe', env: process.env });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status !== 0) throw new Error(`ask 실패: ${(stderr || stdout).slice(0, 200)}`);
  return JSON.parse(stdout);
}

export async function buildStrategy({ card, research, context = '', offer = '', ask = defaultAsk }: {
  card: Data; research: Data; context?: string; offer?: string; ask?: (payload: Data) => Promise<unknown>;
}): Promise<Strategy> {
  const sources = Array.isArray(research.sources) ? research.sources.map(object).filter(source => /^https?:\/\//.test(text(source.url))) : [];
  const evidence = sources.map((source, i) => ({ id: `S${i + 1}`, title: text(source.title), snippet: text(source.snippet), url: text(source.url) }));
  const hasOffer = !!text(offer);
  const sourceBasis = (basis: string) => /^S[1-9]\d*$/.test(basis) && Number(basis.slice(1)) <= evidence.length
    && !!(evidence[Number(basis.slice(1)) - 1]?.title || evidence[Number(basis.slice(1)) - 1]?.snippet);
  const fitBasis = (basis: string) => basis === 'card' && Object.values(card).some(value => !!text(value))
    || basis === 'context' && !!text(context) || basis === 'offer' && hasOffer || sourceBasis(basis);
  const validBasis = (basis: string) => basis === 'assumption' || fitBasis(basis);
  const citedEvidence = (basis: string) => /^S\d+$/.test(basis) ? evidence[Number(basis.slice(1)) - 1] : undefined;
  const instruction = 'JSON 객체만 출력: {"fit":{"score":0~100,"label":"high|medium|low","reasons":[{"text":"이유","basis":"S1|card|context|offer"} 3개]},"approach":{"who":"누구에게","problem":"어떤 문제","proposal":"어떤 제안","channel":"어느 채널","timing":"언제"},"approachBasis":{"who":["card"],"problem":["S1"],"proposal":["offer"],"channel":["assumption"],"timing":["assumption"]},"nextAction":{"what":"할 일","due":"기한"},"nextActionBasis":{"what":["assumption"],"due":["assumption"]}}. approachBasis와 nextActionBasis에는 각 필드의 주장에 실제로 사용한 근거 번호/입력을 적을 것. S#는 제공된 evidence 번호만 사용. nextAction은 고객의 확정 약속이나 확정 일정을 주장하지 말고 우리가 제안할 내부 행동과 목표 기한으로만 작성할 것. 출처에 없는 사실을 꾸며내지 말 것. offer가 없으면 fit 평가는 하지 말고 명함과 만남 맥락만으로 접근 전략을 작성할 것. 메시지는 보내지 말 것. 전략은 구체적이어야 한다(일반론 «AI 로 효율화» 금지): who = 이름·직함 ⊕ 결정권 추정(추정이면 basis 에 assumption); problem = 그 회사가 지금 겪을 법한 문제 하나 — 근거는 출처 S# 또는 만남 맥락(context)이어야 하고 없으면 만남 맥락에서 나온 관심사로 좁힌다; proposal = 우리 제안 하나(수치 약속 없음 · 작은 시범·시연·파일럿처럼 바로 해 볼 수 있는 것); channel = 메일/LinkedIn/전화 중 하나 ⊕ 그 이유 한 구; timing = 날짜나 요일로(예: 행사 다음 날 오전 · 이번 주 금요일 전). fit 이유는 서로 다른 근거로 셋을 채워라(card·context·offer·S#).';
  let answer: Data = {};
  let reasons: Fit['reasons'] = [];
  let feedback = '';
  // Three tries: with company-site evidence the writer still over-cites about one run in three (10-01 dry runs 0.2.6–0.2.8);
  // the third try gets the rejected fields by name. The verdict rule itself is unchanged.
  const LAST = 2;
  for (let attempt = 0; attempt <= LAST; attempt++) {
    try {
      answer = parseAnswer(await ask({ task: 'strategy', instruction: instruction + feedback, card, research: hasOffer ? { summary: research.summary, news: research.news } : {}, context, offer, evidence: hasOffer ? evidence : [] }));
    } catch (error) {
      if (attempt >= 1) throw error;
      feedback = ' 이전 답이 올바른 JSON 객체가 아니었다. 지정한 필드를 갖춘 JSON 객체만 다시 작성하라.';
      continue;
    }
    const approachData = object(answer.approach);
    const actionData = object(answer.nextAction);
    if ((['who', 'problem', 'proposal', 'channel', 'timing'] as const).some(field => !text(approachData[field]))
      || !text(actionData.what) || !text(actionData.due)) {
      if (attempt >= 1) throw new Error('접근 전략 필수 필드 없음');
      feedback = ' 이전 답에 접근 전략 또는 다음 행동 필수 필드가 빠졌다. 모두 채워 다시 작성하라.';
      continue;
    }
    const raw = hasOffer && Array.isArray(object(answer.fit).reasons) ? object(answer.fit).reasons as unknown[] : [];
    reasons = raw.map(object).map(item => ({ text: text(item.text), basis: text(item.basis) }))
      .filter(item => item.text && fitBasis(item.basis)).slice(0, 3);
    const invalidNumber = raw.some(item => !text(object(item).text) || !fitBasis(text(object(item).basis)));
    const claims = reasons.map((reason, i) => ({ i, text: reason.text, basis: reason.basis, evidence: citedEvidence(reason.basis) }));
    const basisFor = (rawBasis: unknown) => {
      const entries = Array.isArray(rawBasis) ? rawBasis : [];
      return entries.map(text).filter(validBasis);
    };
    const approachBasis = object(answer.approachBasis), actionBasis = object(answer.nextActionBasis);
    const approachClaims = (['who', 'problem', 'proposal', 'channel', 'timing'] as const)
      .map(field => ({ field, text: text(approachData[field]), basis: basisFor(approachBasis[field]),
        evidence: basisFor(approachBasis[field]).map(citedEvidence).filter((source): source is NonNullable<typeof source> => !!source) }));
    const actionClaims = (['what', 'due'] as const)
      .map(field => ({ field, text: text(actionData[field]), basis: basisFor(actionBasis[field]),
        evidence: basisFor(actionBasis[field]).map(citedEvidence).filter((source): source is NonNullable<typeof source> => !!source) }));
    const invalidClaims = [...approachClaims.map(claim => ({ claim, raw: approachBasis[claim.field] })),
      ...actionClaims.map(claim => ({ claim, raw: actionBasis[claim.field] }))]
      .some(({ claim, raw }) => !Array.isArray(raw) || !claim.basis.length || raw.length !== claim.basis.length ||
        (!hasOffer && claim.basis.some(basis => /^S\d+$/.test(basis))));
    const verdict = parseAnswer(await ask({ task: 'strategy-verify',
      instruction: 'fit 이유는 사실 주장뿐 아니라 적합성 판단 자체도 그 이유에 표시된 basis의 실제 내용(명함 필드·만남 맥락·제안·인용된 출처 제목/본문 조각)에 뒷받침되는지 판정하고, 추측이나 근거 없는 적합성 판단은 unsupportedReasons에 넣어라. 접근 전략과 다음 행동의 사람·회사·시장·고객 약속·확정 일정에 관한 사실 주장을 해당 basis와 인용된 evidence의 title/snippet/url, 명함, context, offer 원문에 대조하라. 전체 evidence가 있어도 각 주장은 자신이 인용한 근거로만 판정. 번호가 존재하는 것만으로 뒷받침된다고 판정하지 말 것. 고객의 미확인 약속·확정 일정은 nextAction에서 특히 unsupportedAction으로 표시할 것. 제안·질문·우리 내부의 향후 계획/목표 기한은 사실 주장이 아니다. JSON 객체만 출력: {"unsupportedReasons":[이유의 i],"unsupportedApproach":[접근 전략의 field],"unsupportedAction":[다음 행동의 field]}.',
      card, context, offer, evidence, claims, approach: approachClaims, nextAction: actionClaims }));
    if (!Array.isArray(verdict.unsupportedReasons) || !Array.isArray(verdict.unsupportedApproach) || !Array.isArray(verdict.unsupportedAction)) throw new Error('전략 근거 검증 응답을 읽지 못했다');
    const badReasons = new Set(verdict.unsupportedReasons.filter((i): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < reasons.length));
    const badApproach = verdict.unsupportedApproach.filter(field => approachClaims.some(claim => claim.field === field));
    const badAction = verdict.unsupportedAction.filter(field => actionClaims.some(claim => claim.field === field));
    if (verdict.unsupportedReasons.some(i => !badReasons.has(i as number)) || verdict.unsupportedApproach.length !== badApproach.length || verdict.unsupportedAction.length !== badAction.length) throw new Error('전략 근거 검증 응답을 읽지 못했다');
    reasons = reasons.filter((_, i) => !badReasons.has(i));
    if (!invalidNumber && !invalidClaims && (!hasOffer || (reasons.length >= 3 && new Set(reasons.map(reason => reason.basis)).size >= 3)) && badReasons.size === 0 && badApproach.length === 0 && badAction.length === 0) break;
    // Fit-only shortfalls keep the old two tries (the answer is used with fewer reasons); only rejected approach/action
    // claims get the third try.
    if (attempt >= 1 && !(badApproach.length || badAction.length || invalidClaims)) break;
    if (attempt === LAST && (badApproach.length || badAction.length || invalidClaims)) throw new Error(`근거 없는 접근 전략/다음 행동: ${[...badApproach, ...badAction].join(', ') || '근거 누락'}`);
    // Name the rejected fields: a site snippet («we build automations») invites a «problem» the page never states
    // (10-01 dry run, card-followup 0.2.4: strategy failed twice on who/problem once research found the company site).
    const rejected = [...badApproach, ...badAction];
    feedback = ' 이전 답에서 존재하지 않는 S# 또는 근거 내용과 불일치하는 이유·접근 전략·다음 행동을 제외하고, 근거 세 개와 주장별 근거를 다시 작성하라. 고객 약속·확정 일정은 확인된 근거가 없으면 쓰지 말고 내부 제안·목표 기한만 적어라.'
      + (rejected.length ? ` 특히 ${rejected.join(', ')} 는 근거와 맞지 않았다 — 그 필드는 출처가 «직접 말한» 사실만 S# 로 인용하고, 출처가 말하지 않은 회사의 문제·결정권은 «만남 맥락(context)에서 확인할 질문» 꼴로 바꾸거나 basis 를 assumption 으로 적어 추정임을 밝혀라.` : '');
  }
  const fitData = object(answer.fit);
  const score = typeof fitData.score === 'number' && Number.isFinite(fitData.score) && fitData.score >= 0 && fitData.score <= 100 ? fitData.score : null;
  const label = fitData.label;
  const grounded = reasons.length >= 3 && new Set(reasons.map(reason => reason.basis)).size >= 3;
  const fit: Fit = hasOffer
    ? { score: grounded ? score : null, label: grounded && score !== null && (label === 'high' || label === 'medium' || label === 'low') ? label : 'unknown', reasons }
    : { score: null, label: 'unknown', reasons: [{ text: 'offer 입력이 없어 맞음을 판정하지 않았다', basis: 'offer' }] };
  const approachData = object(answer.approach), actionData = object(answer.nextAction);
  const approach: Approach = {
    who: text(approachData.who), problem: text(approachData.problem), proposal: text(approachData.proposal),
    channel: text(approachData.channel), timing: text(approachData.timing),
  };
  const nextAction: NextAction = { what: text(actionData.what), due: text(actionData.due) };
  return { fit, approach, nextAction };
}

export function crmRow(card: Data, fit: Fit, approach: Approach, nextAction: NextAction, context: string, at: Date | string): CrmRow {
  return {
    name: text(card.name), company: text(card.company), title: text(card.title), email: text(card.email),
    interest: approach.problem, met_context: context, fit_score: fit.score === null ? '' : String(fit.score),
    fit_label: fit.label, next_action: nextAction.what, due: nextAction.due,
    updated_at: at instanceof Date ? at.toISOString() : at,
  };
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < content.length; i++) {
    const char = content[i]!;
    if (quoted) {
      if (char === '"' && content[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && content[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (quoted) throw new Error('CRM CSV 따옴표가 닫히지 않음');
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const quote = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

export function upsertCrm(path: string, row: CrmRow): void {
  const prior = existsSync(path) ? parseCsv(readFileSync(path, 'utf8')) : [];
  if (prior.length && (prior[0]!.length !== columns.length || columns.some((col, i) => prior[0]![i] !== col))) throw new Error('CRM CSV 헤더 불일치');
  const records = prior.slice(1).map(values => Object.fromEntries(columns.map((column, i) => [column, values[i] ?? ''])) as CrmRow);
  const same = (left: CrmRow, right: CrmRow) => right.email
    ? !!left.email && left.email.toLowerCase() === right.email.toLowerCase()
    : !left.email && left.name === right.name && left.company === right.company;
  const index = records.findIndex(existing => same(existing, row));
  if (index >= 0) records[index] = row;
  else records.push(row);
  records.sort((a, b) => (b.fit_score === '' ? -1 : Number(b.fit_score)) - (a.fit_score === '' ? -1 : Number(a.fit_score)));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, [columns.join(','), ...records.map(record => columns.map(column => quote(record[column])).join(','))].join('\n') + '\n', { mode: 0o600 });
}
