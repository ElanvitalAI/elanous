import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { callNcsTool } from '../connectors/ncs/server.js';
import { courseLinks } from './course-links.js';

type Data = Record<string, unknown>;
const value = (object: unknown): Data => object && typeof object === 'object' && !Array.isArray(object) ? object as Data : {};
const text = (item: unknown) => typeof item === 'string' ? item.trim() : '';
const list = (item: unknown): string[] => Array.isArray(item) ? item.filter((v): v is string => typeof v === 'string' && !!v.trim()) : [];
const line = (item: unknown) => text(item).replace(/[\r\n|]/g, ' ');
const json = (data: Data) => console.log(JSON.stringify(data));
const context = value(JSON.parse(readFileSync(process.env.ELANOUS_GRAPH_CONTEXT ?? '', 'utf8')));
const input = value(context.input);
const outputs = value(context.outputs);
const contextsDir = dirname(process.env.ELANOUS_GRAPH_CONTEXT ?? '');
if (!contextsDir.endsWith('.json.contexts')) throw new Error('invalid graph run context');
const runStateFile = contextsDir.slice(0, -'.contexts'.length);
const reportDir = runStateFile.slice(0, -'.json'.length);
const reportFile = join(reportDir, 'report.md');

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
  } else if (step === 'ncs-match') {
    const profile = value(outputs.profile);
    const jobs = list(profile.jobs);
    if (!jobs.length) throw new Error('missing profile jobs');
    const results = await Promise.all(jobs.slice(0, 3).map(async (job) => ({ job, result: await callNcsTool('ncs_search_units', { keyword: job }) })));
    const units = results.flatMap(({ job, result }) => {
      const body = value(value(result).body);
      const raw = value(body.items).item;
      return (Array.isArray(raw) ? raw : raw ? [raw] : []).map(item => {
        const unit = value(item);
        return { job, code: line(unit.NCS_CL_CD ?? unit.NCS_COMPE_UNIT_CD), name: line(unit.COMPE_UNIT_NAME), definition: line(unit.COMPE_UNIT_DEF), source: text(value(result).source) };
      }).filter(unit => unit.name && unit.code);
    });
    if (!units.length) throw new Error('NCS search returned no named competency units; cannot invent a match');
    json({ units });
  } else if (step === 'research') {
    const profile = value(outputs.profile);
    const query = `${list(profile.jobs).join(' ')} 역량 교육 과정 강의 공식 출처`;
    if (!query.trim()) throw new Error('missing job for research');
    const cli = Bun.spawn(['elanous', '--test', 'research', query, '--json'], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
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
    const profile = value(outputs.profile);
    const ncs = value(outputs['ncs-match']);
    const skills = list(profile.skills);
    const units = Array.isArray(ncs.units) ? ncs.units.map(value) : [];
    if (!units.length) throw new Error('missing NCS units');
    const gaps = units.map(unit => ({ code: line(unit.code), name: line(unit.name), status: skills.some(skill => line(skill) === line(unit.name) && !!line(unit.name)) ? '보유(인터뷰 자기보고)' : '갭(증거 미확인)' }));
    json({ gaps });
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
      '## NCS 능력단위 매칭', ...units.map(x => `- ${line(x.code)} — ${line(x.name)} (${line(x.job)})`), '',
      '## 역량 갭', ...gaps.map(x => `- ${line(x.code)} ${line(x.name)}: ${line(x.status)}`), '',
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
