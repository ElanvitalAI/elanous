import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skill = (name: string) => readFileSync(join(import.meta.dir, name, 'SKILL.md'), 'utf8');

const enterpriseSkills = [
  { name: 'enterprise-needs', stage: 'needs', evidence: 'affected learner group', handoff: '`task`' },
  { name: 'enterprise-task-analysis', stage: 'task', evidence: 'observable performance criterion', handoff: '`ncs-match`' },
  { name: 'enterprise-ai-fit', stage: 'ai-fit', evidence: 'non-AI alternative', handoff: '`competency`' },
  { name: 'enterprise-competency', stage: 'competency', evidence: 'self-report only', handoff: '`roadmap`' },
  { name: 'enterprise-roadmap', stage: 'roadmap', evidence: 'observable assessment', handoff: '`spec`' },
] as const;

for (const { name, stage, evidence, handoff } of enterpriseSkills) {
  test(`${name} describes its distinct enterprise stage and safeguards`, () => {
    const content = skill(name);
    expect(content).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---\\n`));
    expect(content).toContain(`\`${stage}\``);
    expect(content).toContain(evidence);
    expect(content).toContain(handoff);
    expect(content).toContain('미확인');
    expect(content).toMatch(/fictional/i);
    expect(content).toMatch(/quot|excerpt|인터뷰 인용/iu);
    expect(content).toMatch(/NCS/i);
    expect(content).toMatch(/course/i);
    expect(content).toMatch(/policy/i);
    if (name === 'enterprise-ai-fit') expect(content).toContain('policy and deployment feasibility `미확인`');
  });
}

test('enterprise interview profile documents distinct headings and keeps personal-mode contract', () => {
  const content = skill('interview-to-profile');
  for (const heading of ['기업 개요', '교육 대상', '현업 과제', '교육 목표', '현재 역량', '교육 제약']) {
    expect(content).toContain(`\`## ${heading}\``);
  }
  for (const heading of ['희망 직무', '경험', '보유 역량']) {
    expect(content).toContain(`\`## ${heading}\``);
  }
  expect(content).toContain('`jobs`');
  expect(content).toContain('`skills`');
  expect(content).toContain('`experienceCount`');
  expect(content).toContain('short, relevant excerpt');
  expect(content).toContain('Mark unknown NCS codes or units, course names or URLs, and company policy details `미확인`');
  expect(content).toMatch(/policy approval/);
});
