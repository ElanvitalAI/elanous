import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { callNcsTool } from '../connectors/ncs/server.js';
import { courseLinks } from './course-links.js';
import { gapPrompt, judgeGaps, MAX_GAP_PROMPT_CHARS, type GapUnit } from './gap-judge.js';

type Data = Record<string, unknown>;
const value = (object: unknown): Data => object && typeof object === 'object' && !Array.isArray(object) ? object as Data : {};
const text = (item: unknown) => typeof item === 'string' ? item.trim() : '';
const list = (item: unknown): string[] => Array.isArray(item) ? item.filter((v): v is string => typeof v === 'string' && !!v.trim()) : [];
const line = (item: unknown) => text(item).replace(/[\r\n|]/g, ' ');
const json = (data: Data) => console.log(JSON.stringify(data));
const items = (raw: unknown): Data[] => {
  const item = value(raw).items ? value(value(raw).items).item : value(raw).item ?? raw;
  return (Array.isArray(item) ? item : item ? [item] : []).map(value);
};
const pick = (record: Data, ...names: string[]) => names.map(name => line(record[name])).find(Boolean) ?? '';
const MAX_DETAIL_UNITS = 6;
const DETAIL_CONCURRENCY = 2;
const gapUnit = (unit: Data): GapUnit => ({
  code: line(unit.code), name: line(unit.name), definition: line(unit.definition), level: line(unit.level),
  elements: Array.isArray(unit.elements) ? unit.elements.map(value).map(element => ({ name: line(element.name), criteria: line(element.criteria) })) : [],
});
const detailFields = (raw: unknown) => {
  const body = value(value(raw).body);
  const records = items(body);
  const detail = records[0] ?? body;
  const elements = items(detail.COMPE_UNIT_ELEM ?? detail.competencyUnitElements ?? detail.elements ?? body.COMPE_UNIT_ELEM);
  return {
    level: pick(detail, 'COMPE_UNIT_LVL', 'COMPE_UNIT_LEVEL', 'NCS_LVL', 'level'),
    elements: elements.map(element => ({
      name: pick(element, 'COMPE_UNIT_ELEM_NAME', 'NCS_COMPE_UNIT_ELEM_NAME', 'name'),
      criteria: pick(element, 'PERF_CRIT', 'PERF_CRITERIA', 'PERFORMANCE_CRITERIA', 'criteria'),
    })).filter(element => element.name || element.criteria),
  };
};
const context = value(JSON.parse(readFileSync(process.env.ELANOUS_GRAPH_CONTEXT ?? '', 'utf8')));
const input = value(context.input);
const outputs = value(context.outputs);
const contextsDir = dirname(process.env.ELANOUS_GRAPH_CONTEXT ?? '');
if (!contextsDir.endsWith('.json.contexts')) throw new Error('invalid graph run context');
const runStateFile = contextsDir.slice(0, -'.contexts'.length);
const reportDir = runStateFile.slice(0, -'.json'.length);
const reportFile = join(reportDir, 'report.md');
const enterpriseHeadings = ['기업 개요 및 교육 대상', '교육 니즈', '직무·과제 및 NCS', 'AI 적합성', '역량 진단', '교육 로드맵', '교육 명세·운영 경로'];
const interviewField = (interview: string, heading: string) => interview.split(`## ${heading}\n`)[1]?.split(/\n## /)[0]?.trim() ?? '';
const brief = (raw: string) => line(raw.replace(/^[-*]\s*/gm, '')).slice(0, 240) || '미확인';
const enterpriseOutput = (name: string) => value(outputs[name]);
const enterpriseLine = (label: string, raw: unknown) => `- ${label}: ${line(raw) || '미확인'}`;

async function run(step: string) {
  if (step === 'profile') {
    const path = text(input.interview);
    if (!path || !path.endsWith('.md')) throw new Error('input.interview must name a Markdown interview file');
    const interview = readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
    if (!interview.trim()) throw new Error('empty interview');
    // Structured interview headings are the documented input contract; no guessed competencies.
    const field = (heading: string) => interview.split(`## ${heading}\n`)[1]?.split(/\n## /)[0]?.trim() ?? '';
    const jobs = field('희망 직무').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    const experiences = field('경험').split(/\n/).map(s => s.replace(/^[-*] /, '').trim()).filter(Boolean);
    const skills = field('보유 역량').split(/[,\n]/).map(s => s.replace(/^[-*] /, '').trim()).filter(Boolean);
    if (!jobs.length || !experiences.length || !skills.length) throw new Error('interview requires 희망 직무, 경험, 보유 역량 headings');
    json({ jobs, skills, experienceCount: experiences.length });
  } else if (step === 'intake') {
    const path = text(input.interview);
    if (!path || !path.endsWith('.md')) throw new Error('input.interview must name a Markdown interview file');
    const interview = readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
    const headings = ['기업 개요', '교육 대상', '현업 과제', '교육 목표', '현재 역량', '교육 제약'];
    if (headings.some(heading => !interview.includes(`## ${heading}\n`))) throw new Error(`enterprise interview requires ${headings.join(', ')} headings`);
    const task = interviewField(interview, '현업 과제').split(/\n|[,;]/).map(s => s.replace(/^[-*]\s*/, '').trim()).find(Boolean) ?? '';
    if (!task || task === '미확인') throw new Error('missing enterprise task for NCS search');
    for (const heading of ['교육 대상', '교육 목표']) {
      const field = brief(interviewField(interview, heading));
      if (field === '미확인') throw new Error(`missing enterprise ${heading}`);
    }
    const jobs = [line(task).slice(0, 80)];
    json({ jobs, sections: Object.fromEntries(headings.map(heading => [heading, brief(interviewField(interview, heading))])) });
  } else if (step === 'needs') {
    const sections = value(enterpriseOutput('intake').sections);
    if (!text(sections['현업 과제'])) throw new Error('missing enterprise intake');
    json({ learnerGroup: sections['교육 대상'], task: sections['현업 과제'], requestedOutcome: sections['교육 목표'], evidence: '인터뷰 자기보고', baseline: '미확인' });
  } else if (step === 'task') {
    const needs = enterpriseOutput('needs');
    if (!text(needs.task)) throw new Error('missing enterprise needs');
    json({ work: needs.task, performanceCriterion: text(needs.requestedOutcome) || '미확인', source: '현업 과제·교육 목표 (인터뷰 자기보고)' });
  } else if (step === 'ncs-match') {
    const profile = value(outputs.profile ?? outputs.intake);
    const jobs = list(profile.jobs);
    if (!jobs.length) throw new Error('missing profile jobs');
    const results = await Promise.all(jobs.slice(0, 3).map(async (job) => ({ job, result: await callNcsTool('ncs_search_units', { keyword: job }) })));
    const named = results.flatMap(({ job, result }) => items(value(result).body).map(unit => ({
      job, code: pick(unit, 'NCS_COMPE_UNIT_CD'), name: pick(unit, 'COMPE_UNIT_NAME'),
      definition: pick(unit, 'COMPE_UNIT_DEF'), source: text(value(result).source),
    })).filter(unit => unit.name));
    // A hit without NCS_COMPE_UNIT_CD cannot be looked up (its classification code is not a unit code) — skip it, keep the rest.
    const matches = named.filter(unit => unit.code);
    if (named.length && !matches.length) throw new Error('NCS search returned named competency units only without NCS_COMPE_UNIT_CD; cannot invent a match');
    if (!matches.length) throw new Error('NCS search returned no named competency units; cannot invent a match');
    // Interleave jobs in search order; deduplicate codes before the bounded detail lookup.
    const perJob = jobs.slice(0, 3).map(job => matches.filter(unit => unit.job === job));
    const candidates: typeof matches = [];
    const seen = new Set<string>();
    for (let index = 0; candidates.length < MAX_DETAIL_UNITS && perJob.some(group => index < group.length); index++) {
      for (const group of perJob) {
        const unit = group[index];
        if (unit && !seen.has(unit.code)) {
          candidates.push(unit);
          seen.add(unit.code);
          if (candidates.length === MAX_DETAIL_UNITS) break;
        }
      }
    }
    const details: (typeof matches[number] & ReturnType<typeof detailFields> & { source: string })[] = [];
    for (let index = 0; index < candidates.length; index += DETAIL_CONCURRENCY) {
      details.push(...await Promise.all(candidates.slice(index, index + DETAIL_CONCURRENCY).map(async unit => {
        const detail = await callNcsTool('ncs_unit', { code: unit.code });
        const fields = detailFields(detail);
        if (!fields.level || !fields.elements.length || fields.elements.some(element => !element.name || !element.criteria)) {
          throw new Error(`NCS unit ${unit.code} has no complete elements, performance criteria and level`);
        }
        return { ...unit, ...fields, source: text(value(detail).source) };
      })));
    }
    const interview = readFileSync(text(input.interview), 'utf8');
    const units: typeof details = [];
    for (const detail of details) {
      if (gapPrompt([...units, detail].map(unit => gapUnit(unit)), interview).length <= MAX_GAP_PROMPT_CHARS) units.push(detail);
    }
    if (!units.length) throw new Error('interview or NCS detail exceeds gap prompt input limit');
    json({ units });
  } else if (step === 'ai-fit') {
    const task = enterpriseOutput('task');
    const ncs = enterpriseOutput('ncs-match');
    const units = Array.isArray(ncs.units) ? ncs.units.map(value) : [];
    if (!text(task.work) || !units.length) throw new Error('missing task or NCS evidence for AI fit');
    json({ task: task.work, ncsCodes: units.map(unit => text(unit.code)),
      opportunity: '해당 과제의 AI 보조 가능성 검토 (효과 미확인)',
      alternative: '업무 절차 정리 및 담당자 검토',
      feasibility: '데이터 접근·보안·사내 정책 승인 미확인', decision: '조건부 검토' });
  } else if (step === 'competency') {
    const sections = value(enterpriseOutput('intake').sections);
    const units = enterpriseOutput('ncs-match').units;
    if (!Array.isArray(units) || !units.length) throw new Error('missing NCS units for competency assessment');
    json({ current: sections['현재 역량'] || '미확인', status: '인터뷰 자기보고만 확인; 객관적 수준 미확인',
      requirements: units.map(value).map(unit => ({ code: text(unit.code), name: text(unit.name), level: text(unit.level) || '미확인' })) });
  } else if (step === 'roadmap') {
    const competency = enterpriseOutput('competency');
    const aiFit = enterpriseOutput('ai-fit');
    if (!Array.isArray(competency.requirements) || !text(aiFit.decision)) throw new Error('missing competency or AI fit');
    json({ phases: ['현재 수준 확인', '업무 기반 실습', '담당자 검토를 동반한 시범 적용', '업무 산출물 평가'],
      assessment: '실제 업무 산출물의 수행 기준에 따른 관찰 평가', adoption: '제안 단계; 승인 미확인' });
  } else if (step === 'spec') {
    const roadmap = enterpriseOutput('roadmap');
    const sections = value(enterpriseOutput('intake').sections);
    if (!Array.isArray(roadmap.phases)) throw new Error('missing enterprise roadmap');
    json({ audience: sections['교육 대상'] || '미확인', outcome: sections['교육 목표'] || '미확인',
      activities: roadmap.phases, assessment: roadmap.assessment, constraints: sections['교육 제약'] || '미확인',
      duration: '미확인', courses: '미확인' });
  } else if (step === 'routing') {
    const spec = enterpriseOutput('spec');
    if (!Array.isArray(spec.activities)) throw new Error('missing enterprise training spec');
    const sections = value(enterpriseOutput('intake').sections);
    const ncs = enterpriseOutput('ncs-match');
    const units = Array.isArray(ncs.units) ? ncs.units.map(value) : [];
    if (!units.length) throw new Error('cannot report without verified NCS units');
    const requirements = enterpriseOutput('competency').requirements;
    if (!Array.isArray(requirements) || !requirements.length) throw new Error('missing competency requirements');
    const md = ['# 기업 HRD 교육 제안 보고서', '',
      `## ${enterpriseHeadings[0]}`, enterpriseLine('기업 개요 (인터뷰 자기보고)', sections['기업 개요']), enterpriseLine('교육 대상 (인터뷰 자기보고)', sections['교육 대상']), '',
      `## ${enterpriseHeadings[1]}`, enterpriseLine('교육 대상', enterpriseOutput('needs').learnerGroup), enterpriseLine('현업 니즈 (인터뷰 자기보고)', enterpriseOutput('needs').task), enterpriseLine('교육 목표', enterpriseOutput('needs').requestedOutcome), enterpriseLine('근거', enterpriseOutput('needs').evidence), enterpriseLine('현재 수준', enterpriseOutput('needs').baseline), '',
      `## ${enterpriseHeadings[2]}`, enterpriseLine('직무 과제', enterpriseOutput('task').work), enterpriseLine('관찰할 수행 기준', enterpriseOutput('task').performanceCriterion), enterpriseLine('과제 출처', enterpriseOutput('task').source),
      ...units.map(unit => `- NCS ${line(unit.code)} — ${line(unit.name)} · 수준 ${line(unit.level) || '미확인'} · 출처 ${line(unit.source) || '미확인'}`), '',
      `## ${enterpriseHeadings[3]}`, enterpriseLine('적용 검토 과제', enterpriseOutput('ai-fit').task), enterpriseLine('관련 NCS 코드', list(enterpriseOutput('ai-fit').ncsCodes).join(', ')), enterpriseLine('적용 가능성', enterpriseOutput('ai-fit').opportunity), enterpriseLine('비AI 대안', enterpriseOutput('ai-fit').alternative), enterpriseLine('도입 판정', enterpriseOutput('ai-fit').decision), enterpriseLine('정책 및 데이터 접근', enterpriseOutput('ai-fit').feasibility), '',
      `## ${enterpriseHeadings[4]}`, enterpriseLine('현재 역량 (자기보고)', enterpriseOutput('competency').current), enterpriseLine('검증 상태', enterpriseOutput('competency').status),
      ...requirements.map(raw => value(raw)).map(unit => `- 요구 역량: NCS ${line(unit.code)} — ${line(unit.name)} · 수준 ${line(unit.level) || '미확인'}`), '',
      `## ${enterpriseHeadings[5]}`, ...list(enterpriseOutput('roadmap').phases).map((phase, i) => `- ${i + 1}. ${line(phase)}`), enterpriseLine('평가', enterpriseOutput('roadmap').assessment), enterpriseLine('채택 상태', enterpriseOutput('roadmap').adoption), '',
      `## ${enterpriseHeadings[6]}`, enterpriseLine('교육 대상', spec.audience), enterpriseLine('교육 목표', spec.outcome), enterpriseLine('평가 명세', spec.assessment), enterpriseLine('시간·예산·접근 제약', spec.constraints),
      enterpriseLine('기간', spec.duration), enterpriseLine('추천 과정·URL', spec.courses), '- 운영 경로: 담당자와 비AI/AI 시범 방식을 검토; 데이터 접근·정책 승인은 미확인', '',
      '※ 인터뷰는 자기보고이며 NCS는 확인된 조회 결과만 인용합니다. 제안은 회사의 승인된 정책이나 확정 교육 과정이 아닙니다.', ''].join('\n');
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(reportFile, md, { mode: 0o600 });
    json({ report: reportFile });
  } else if (step === 'judge-enterprise') {
    const report = text(enterpriseOutput('routing').report);
    if (report !== reportFile) throw new Error('missing enterprise report path');
    const content = readFileSync(reportFile, 'utf8');
    const needs = enterpriseOutput('needs');
    const task = enterpriseOutput('task');
    const aiFit = enterpriseOutput('ai-fit');
    const competency = enterpriseOutput('competency');
    const roadmap = enterpriseOutput('roadmap');
    const spec = enterpriseOutput('spec');
    const sections = value(enterpriseOutput('intake').sections);
    const units = Array.isArray(enterpriseOutput('ncs-match').units) ? (enterpriseOutput('ncs-match').units as unknown[]).map(value) : [];
    const phases = list(roadmap.phases);
    const requirements = Array.isArray(competency.requirements) ? competency.requirements.map(value) : [];
    const substantive = (raw: unknown) => !!text(raw) && text(raw) !== '미확인';
    const required: string[][] = [
      [enterpriseLine('기업 개요 (인터뷰 자기보고)', sections['기업 개요']), enterpriseLine('교육 대상 (인터뷰 자기보고)', sections['교육 대상'])],
      [enterpriseLine('교육 대상', needs.learnerGroup), enterpriseLine('현업 니즈 (인터뷰 자기보고)', needs.task), enterpriseLine('교육 목표', needs.requestedOutcome), enterpriseLine('근거', needs.evidence), enterpriseLine('현재 수준', needs.baseline)],
      [enterpriseLine('직무 과제', task.work), enterpriseLine('관찰할 수행 기준', task.performanceCriterion), enterpriseLine('과제 출처', task.source),
        ...units.map(unit => `- NCS ${line(unit.code)} — ${line(unit.name)} · 수준 ${line(unit.level) || '미확인'} · 출처 ${line(unit.source) || '미확인'}`)],
      [enterpriseLine('적용 검토 과제', aiFit.task), enterpriseLine('관련 NCS 코드', list(aiFit.ncsCodes).join(', ')), enterpriseLine('적용 가능성', aiFit.opportunity), enterpriseLine('비AI 대안', aiFit.alternative), enterpriseLine('도입 판정', aiFit.decision), enterpriseLine('정책 및 데이터 접근', aiFit.feasibility)],
      [enterpriseLine('현재 역량 (자기보고)', competency.current), enterpriseLine('검증 상태', competency.status),
        ...requirements.map(unit => `- 요구 역량: NCS ${line(unit.code)} — ${line(unit.name)} · 수준 ${line(unit.level) || '미확인'}`)],
      [...phases.map((phase, i) => `- ${i + 1}. ${line(phase)}`), enterpriseLine('평가', roadmap.assessment), enterpriseLine('채택 상태', roadmap.adoption)],
      [enterpriseLine('교육 대상', spec.audience), enterpriseLine('교육 목표', spec.outcome), enterpriseLine('평가 명세', spec.assessment), enterpriseLine('시간·예산·접근 제약', spec.constraints), enterpriseLine('기간', spec.duration), enterpriseLine('추천 과정·URL', spec.courses), '- 운영 경로: 담당자와 비AI/AI 시범 방식을 검토; 데이터 접근·정책 승인은 미확인'],
    ];
    const complete = enterpriseHeadings.every((heading, index) => {
      const marker = `## ${heading}\n`;
      const start = content.indexOf(marker);
      const end = index < enterpriseHeadings.length - 1 ? content.indexOf(`## ${enterpriseHeadings[index + 1]}\n`, start + marker.length) : content.length;
      if (start < 0 || end <= start || content.indexOf(marker, start + marker.length) !== -1) return false;
      const lines = new Set(content.slice(start + marker.length, end).split('\n'));
      return required[index]!.every(expected => lines.has(expected));
    });
    const hasNcs = units.length > 0 && units.every(unit => substantive(unit.code) && substantive(unit.name)) &&
      list(aiFit.ncsCodes).join(', ') === units.map(unit => text(unit.code)).join(', ');
    const hasRequiredInput = [sections['교육 대상'], sections['교육 목표'], needs.learnerGroup, needs.requestedOutcome, spec.audience, spec.outcome].every(substantive);
    const hasRequirements = requirements.length === units.length && requirements.every((unit, index) =>
      substantive(unit.code) && substantive(unit.name) && substantive(unit.level) &&
      ['code', 'name', 'level'].every(field => text(unit[field]) === text(units[index]?.[field])));
    const hasDecision = [aiFit.task, aiFit.opportunity, aiFit.alternative, aiFit.decision, roadmap.assessment].every(substantive) &&
      text(aiFit.task) === text(task.work) && phases.length >= 4 && phases.every(substantive);
    const path = (JSON.parse(readFileSync(runStateFile, 'utf8')) as { path?: string[] }).path ?? [];
    const visits = path.filter(node => node === 'judge' || node === 'judge-enterprise').length;
    json({ outcome: complete && hasRequiredInput && hasNcs && hasRequirements && hasDecision ? 'ok' : visits < 2 ? 'retry' : 'fail', report });
  } else if (step === 'research') {
    const profile = value(outputs.profile);
    const query = `${list(profile.jobs).join(' ')} 역량 교육 과정 강의 공식 출처`;
    if (!query.trim()) throw new Error('missing job for research');
    const cli = Bun.spawn(['elanous', 'research', query, '--json'], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
    const stdout = await new Response(cli.stdout).text();
    const stderr = await new Response(cli.stderr).text();
    if (await cli.exited !== 0) throw new Error(`research failed: ${stderr.slice(0, 300)}`);
    const result = JSON.parse(stdout) as unknown;
    const ncs = value(outputs['ncs-match']);
    const units = Array.isArray(ncs.units) ? ncs.units.map(value).map(unit => ({ name: text(unit.name), code: text(unit.code) })) : [];
    if (!units.length) throw new Error('missing NCS units for course verification');
    const courses = await courseLinks(result, units);
    json({ courses });
  } else if (step === 'gap') {
    const ncs = value(outputs['ncs-match']);
    const units = Array.isArray(ncs.units) ? ncs.units.map(value).map(gapUnit) : [];
    if (!units.length) throw new Error('missing NCS units');
    const interview = readFileSync(text(input.interview), 'utf8');
    // A research retry revisits gap with the same units and interview — reuse only a verdict made from exactly those.
    const basis = createHash('sha256').update(gapPrompt(units, interview)).digest('hex');
    const previous = value(outputs.gap);
    if (previous.basis === basis && Array.isArray(previous.gaps)) {
      json({ gaps: previous.gaps, basis });
      return;
    }
    const gaps = await judgeGaps(units, interview, async prompt => {
      const cli = Bun.spawn(['elanous', 'ask', '--json', prompt], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
      const stdout = await new Response(cli.stdout).text();
      await new Response(cli.stderr).text();
      if (await cli.exited !== 0) throw new Error('gap LLM failed');
      const response = value(JSON.parse(stdout));
      if (typeof response.reply !== 'string') throw new Error('gap LLM returned no reply');
      return response.reply;
    });
    json({ gaps, basis });
  } else if (step === 'report') {
    const profile = value(outputs.profile);
    const ncs = value(outputs['ncs-match']);
    const research = value(outputs.research);
    const gap = value(outputs.gap);
    const units = Array.isArray(ncs.units) ? ncs.units.map(value) : [];
    const courses = Array.isArray(research.courses) ? research.courses.map(value) : [];
    const gaps = Array.isArray(gap.gaps) ? gap.gaps.map(value) : [];
    if (!units.length || !gaps.length) throw new Error('cannot report without NCS units and gaps');
    const md = ['# AI 직무코치 보고서', '', '## 직무', ...list(profile.jobs).map(x => `- ${line(x)}`), '',
      '## NCS 능력단위 매칭', ...units.map(x => `- ${line(x.code)} — ${line(x.name)} (${line(x.job)}) · 수준 ${line(x.level) || '미확인'}${Array.isArray(x.elements) ? x.elements.map(value).map(element => ` · ${line(element.name)}: ${line(element.criteria)}`).join('') : ''}`), '',
      '## 역량 갭', ...gaps.map(x => `- ${line(x.code)} ${line(x.name)}: ${line(x.status)}${text(x.quote) ? ` — 인터뷰 인용: “${line(x.quote)}”` : ''}`), '',
      '## 추천 코스', ...(courses.length ? courses.map(x => `- [${line(x.title).replace(/[\[\]]/g, '')}](${text(x.url)}) — ${line(x.matchedUnit)}; ${line(x.evidence)}`) : ['- 확인된 관련 교육 과정 없음 (추천 미확인)']), '',
      '## 출처', '- [한국산업인력공단 NCS 기준정보 조회](https://www.data.go.kr/data/15128213/openapi.do)',
      ...courses.map(x => `- ${text(x.url)}`), '', '※ 보유 역량은 인터뷰 자기보고이며, 확인되지 않은 역량은 갭으로 표시합니다.', ''].join('\n');
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(reportFile, md, { mode: 0o600 });
    json({ report: reportFile });
  } else if (step === 'judge') {
    const report = text(value(outputs.report).report);
    if (!report || report !== reportFile) throw new Error('missing report path');
    const content = readFileSync(report, 'utf8');
    const sections = ['직무', 'NCS 능력단위 매칭', '역량 갭', '추천 코스', '출처'];
    const complete = sections.every((section, index) => {
      const start = content.indexOf(`## ${section}\n`);
      if (start < 0) return false;
      const end = index + 1 < sections.length ? content.indexOf(`## ${sections[index + 1]}\n`, start) : content.length;
      return end > start && content.slice(start + section.length + 4, end).includes('- ');
    });
    const visits = readFileSync(runStateFile, 'utf8');
    const priorJudgeVisits = (JSON.parse(visits) as { path?: string[] }).path?.filter(node => node === 'judge').length ?? 0;
    const courses = value(outputs.research).courses;
    const hasVerifiedCourse = Array.isArray(courses) && courses.length > 0;
    json({ outcome: !complete ? priorJudgeVisits < 2 ? 'retry' : 'fail' : !hasVerifiedCourse && priorJudgeVisits < 2 ? 'retry' : 'ok', report });
  } else throw new Error(`unknown report step: ${step}`);
}

await run(process.argv[2] ?? '');
