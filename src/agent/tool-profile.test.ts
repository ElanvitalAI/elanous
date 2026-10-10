import { describe, expect, test } from 'bun:test';
import { activeToolProfile, applyToolProfile, childToolProfile, parseToolProfile } from './tool-profile.js';

// BACKLOG L1 — 기본(다이어트) ⊕ 추가 묶음. 대표 09-25: 이원화 없이 «ADD».
describe('tool profile = base ⊕ extra groups (BACKLOG L1)', () => {
  const tools = ['Read', 'Edit', 'Bash', 'memory_recall', 'logs_query', 'skill_exec', 'finance_quote', 'finance_13f', 'conatus_position', 'schedule_manage', 'ops_status', 'mission_decide', 'update_goal']
    .map((name) => ({ name }));
  const names = (p: string) => applyToolProfile(tools, parseToolProfile(p)).tools!.map((t) => t.name);
  test('no profile → unchanged (chat·telegram·daemon)', () => {
    expect(activeToolProfile({})).toBeNull();
    expect(applyToolProfile(tools, null).tools).toBe(tools);
  });
  test('coding = base only; full = everything; a group adds only that group', () => {
    expect(names('coding')).toEqual(['Read', 'Edit', 'Bash', 'update_goal']);
    expect(names('full')).toEqual(tools.map((t) => t.name));
    expect(names('finance')).toEqual(['Read', 'Edit', 'Bash', 'finance_quote', 'finance_13f', 'conatus_position', 'update_goal']);
    expect(names('recall,skills')).toEqual(['Read', 'Edit', 'Bash', 'memory_recall', 'logs_query', 'skill_exec', 'update_goal']);
  });
  test('every mode is a superset of coding (a mode switch never drops a tool used earlier)', () => {
    const base = new Set(names('coding'));
    for (const p of ['full', 'finance', 'ops', 'finance,ops', 'admin', 'recall', 'skills', 'subagent', 'admin,subagent']) for (const n of base) expect(names(p)).toContain(n);
  });
  test('child profile: default coding, parent chooses full or groups; unknown group falls back to coding', () => {
    expect(childToolProfile({})).toBe('coding');
    expect(childToolProfile({ ELANOUS_CHILD_TOOL_PROFILE: 'full' })).toBe('full');
    expect(parseToolProfile('nope')!.name).toBe('coding');
  });
});

// 대표 09-25 「config 가 아니라 상황별로 풀 모드」
import { omittedToolGroupsNote, situationalToolGroups } from './tool-profile.js';
describe('situational tool groups', () => {
  test('goal text adds the matching groups; explicit env wins; plain coding goal stays coding', () => {
    expect(situationalToolGroups('삼성전자 종목 13F 포지션을 조회해 리포트')).toEqual(['finance']);
    expect(childToolProfile({}, '포트폴리오 백테스트 후 스케줄 등록')).toBe('finance,ops');
    expect(childToolProfile({}, '대상 경로: src/foo.ts · 파서 버그 수정')).toBe('coding');
    expect(childToolProfile({ ELANOUS_CHILD_TOOL_PROFILE: 'coding' }, '종목 매매')).toBe('coding');
    expect(childToolProfile({ ELANOUS_CHILD_TOOL_PROFILE: 'full' }, '파서 수정')).toBe('full');
  });
  test('omitted groups are announced in one line (names only, no schemas)', () => {
    const note = omittedToolGroupsNote(['finance_quote', 'finance_13f', 'ops_status']);
    expect(note).toContain('finance(2');
    expect(note).toContain('ops(1');
    expect(note).toContain('ToolSearch');
    expect(omittedToolGroupsNote([])).toBeNull();
  });
});

// CHILD-TOOL-PROFILE-TRIM — 판·자리 운영·회수·스킬·서브에이전트도 «추가 묶음»이다. 골 문면이 그 일을 말하면 더한다.
describe('trim: admin · recall · skills · subagent groups (CHILD-TOOL-PROFILE-TRIM)', () => {
  const tools = ['Read', 'Bash', 'coo_admin', 'release_status', 'release_change', 'ops_seats', 'decisions_pending', 'proact_meter',
    'memory_recall', 'fact_check', 'self_recall', 'context_now', 'logs_query', 'elanous_skills_list', 'skill_exec',
    'Agent', 'AgentOutput', 'AgentReply', 'AgentStop', 'AgentList', 'Plan', 'MarkStepDone'].map((name) => ({ name }));
  const names = (p: string) => applyToolProfile(tools, parseToolProfile(p)).tools!.map((t) => t.name);
  test('coding keeps only the coding tools', () => {
    expect(names('coding')).toEqual(['Read', 'Bash', 'Plan', 'MarkStepDone']);
  });
  test('goal text «release_change 로 판 칸 근거를 갱신한다» adds admin and the applied list has release_change', () => {
    const profile = childToolProfile({}, 'release_change 로 판 칸 근거를 갱신한다');
    expect(profile.split(',')).toContain('admin');
    expect(names(profile)).toContain('release_change');
    expect(names(profile)).toContain('Read');
  });
  test('situational signals for recall · skills · subagent; plain coding goals add nothing', () => {
    expect(situationalToolGroups('self_recall 로 지난 런 이력을 찾는다')).toEqual(['recall']);
    expect(situationalToolGroups('skill_exec 로 스킬을 실행해 결과를 붙인다')).toEqual(['skills']);
    expect(situationalToolGroups('서브에이전트 셋을 병렬로 띄워 조사한다')).toEqual(['subagent']);
    expect(childToolProfile({}, '대상 경로: src/release/foo.ts · 파서 버그 수정')).toBe('coding');
  });
  test('the omitted-groups note names the new groups', () => {
    const note = omittedToolGroupsNote(['coo_admin', 'memory_recall', 'skill_exec', 'Agent']);
    for (const g of ['admin(1', 'recall(1', 'skills(1', 'subagent(1']) expect(note).toContain(g);
  });
});
