import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTicketingArchitecturePrompt, structureTicketingAnswer } from './ticketing-scene4.js';
import { SCENE4_DRAFT_POLICY, withScene4Workspace } from './scene4-turn-policy.js';

const prompt = `콘서트 티켓팅 시스템 아키텍처를 설계해줘.\n규모: 동시 100,000명(공연 오픈 피크).\n핵심 제약: 공정한 대기열 · 같은 좌석 중복 예매 0건 · 결제 실패 복구.`;
const answer = `공정한 대기열은 Redis 입장 순번으로 제어한다. 좌석 상태는 PostgreSQL 원장에서 조건부 전이와 유일 제약으로 확정한다. 결제 실패 및 지연 웹훅은 멱등 키와 outbox로 복구하고 TTL 홀드 만료를 정리한다. 예약 API는 정적 엣지 뒤에서 입장률에 맞춰 수평 확장한다. 운영 지표는 충돌 수와 큐 지연을 기록한다.`;

test('three-line architecture answer becomes source-specific structured input for the shared renderer', () => {
  expect(isTicketingArchitecturePrompt(prompt)).toBe(true);
  const structured = structureTicketingAnswer(prompt, answer) as { nodes: Array<{ service: string }>; capacity: Array<{ assumption: string }>; summary: string; costs: Array<{ monthlyUsd: number }> };
  expect(structured.nodes.map(node => node.service)).toContain('PostgreSQL seat ledger');
  expect(structured.nodes.map(node => node.service)).toContain('Redis admission queue');
  expect(structured.capacity[0]?.assumption).toContain('100,000');
  expect(structured.summary).toContain('PostgreSQL');
  expect(structured.costs[0]?.monthlyUsd).toBe(0);
});

test('Korean concurrent-user units reach the same architecture capacity as digit counts', () => {
  const cases = [
    ['동시 접속 10만 명', '100,000명'],
    ['동시 3천 명', '3,000명'],
    ['동시 사용자 2천만 명', '20,000,000명'],
    ['동시 접속 1억 2천만 명', '120,000,000명'],
    ['동시 10.5만 명', '105,000명'],
    ['동시 접속자 약 10만 명', '100,000명'],
    ['동시 접속 사용자 10만 명', '100,000명'],
    ['동시 1만 5백 명', '10,500명'],
    ['동시 1백만 명', '1,000,000명'],
  ];
  for (const [size, expected] of cases) {
    const localized = prompt.replace('동시 100,000명', size!);
    const structured = structureTicketingAnswer(localized, answer) as { capacity: Array<{ assumption: string }> };
    expect(structured.capacity[0]?.assumption).toContain(expected!);
  }
  const twoSizes = prompt.replace('콘서트 티켓팅 시스템', '동시 2개 공연의 콘서트 티켓팅 시스템')
    .replace('동시 100,000명', '동시 사용자 10만 명');
  const structured = structureTicketingAnswer(twoSizes, answer) as { capacity: Array<{ assumption: string }> };
  expect(structured.capacity[0]?.assumption).toContain('100,000명');
  const changed = prompt.replace('동시 100,000명', '동시 10만')
    .replace('콘서트 티켓팅 시스템', '동시 2개의 공연을 위한 콘서트 티켓팅 시스템');
  expect((structureTicketingAnswer(changed, answer) as { capacity: Array<{ assumption: string }> }).capacity[0]?.assumption).toContain('100,000명');
  const sourceSize = prompt.replace('핵심 제약:', '핵심 제약: 출처에는 동시 사용자 1만 명이라고 쓰였으나 현재 설계 규모는 앞 줄.');
  expect((structureTicketingAnswer(sourceSize, answer) as { capacity: Array<{ assumption: string }> }).capacity[0]?.assumption).toContain('100,000명');
  const estimated = prompt.replace('규모:', '예상 규모:').replace('100,000', '10만')
    .replace('핵심 제약:', '핵심 제약: 출처의 동시 사용자 1만 명은 과거 값.');
  expect((structureTicketingAnswer(estimated, answer) as { capacity: Array<{ assumption: string }> }).capacity[0]?.assumption).toContain('100,000명');
  const concertCount = prompt.replace('콘서트 티켓팅 시스템', '동시 2개의 콘서트를 위한 티켓팅 시스템').replace('100,000명', '10만');
  expect((structureTicketingAnswer(concertCount, answer) as { capacity: Array<{ assumption: string }> }).capacity[0]?.assumption).toContain('100,000명');
  const eventCount = prompt.replace('규모: 동시 100,000명', '규모: 동시 2회 공연, 동시 10만');
  expect((structureTicketingAnswer(eventCount, answer) as { capacity: Array<{ assumption: string }> }).capacity[0]?.assumption).toContain('100,000명');
  const designSize = prompt.replace('규모:', '설계 규모:').replace('핵심 제약:', '핵심 제약: 출처의 동시 사용자 1만 명은 과거 값.');
  expect((structureTicketingAnswer(designSize, answer) as { capacity: Array<{ assumption: string }> }).capacity[0]?.assumption).toContain('100,000명');
  expect(() => structureTicketingAnswer(prompt.replace('동시 100,000명', '동시 1천 5백만 명'), answer)).toThrow('three-line');
  expect(() => structureTicketingAnswer(prompt.replace('동시 100,000명', '동시 1백 20만 명'), answer)).toThrow('three-line');
  expect(() => structureTicketingAnswer(prompt.replace('동시 100,000명', '동시 1백만만 명'), answer)).toThrow('three-line');
});

test('missing model evidence or a changed prompt fails before diagram publication', () => {
  expect(() => structureTicketingAnswer(prompt, '짧은 답')).toThrow('model answer lacks');
  expect(() => structureTicketingAnswer(prompt.replace('100,000', '많은'), answer)).toThrow('three-line ticketing architecture prompt');
  expect(() => structureTicketingAnswer('티켓팅 설계해줘', answer)).toThrow('three-line');
});

test('Korean capacity and rejected technology names do not become selected services', () => {
  const korean = prompt.replace('100,000', '10만');
  const denied = `${answer}\nPostgreSQL 사용 금지. Redis 사용 금지. 좌석 원장은 트랜잭션 데이터베이스로 대체하고 대기열은 지속성 있는 서비스로 운영한다.`;
  const structured = structureTicketingAnswer(korean, denied) as { nodes: Array<{ service: string }>; capacity: Array<{ assumption: string }> };
  expect(structured.capacity[0]?.assumption).toContain('100,000');
  expect(structured.nodes.map(node => node.service)).not.toContain('PostgreSQL seat ledger');
  expect(structured.nodes.map(node => node.service)).not.toContain('Redis admission queue');
  const mixed = `${answer}\nPostgreSQL을 좌석 원장으로 사용하고 Redis는 사용하지 않는다.`;
  const mixedServices = (structureTicketingAnswer(korean, mixed) as { nodes: Array<{ service: string }> }).nodes.map(node => node.service);
  expect(mixedServices).toContain('PostgreSQL seat ledger');
  expect(mixedServices).not.toContain('Redis admission queue');
  const coupled = `${answer}\nPostgreSQL과 Redis 사용 금지. 좌석 원장은 다른 트랜잭션 데이터베이스로 운영한다.`;
  const coupledServices = (structureTicketingAnswer(korean, coupled) as { nodes: Array<{ service: string }> }).nodes.map(node => node.service);
  expect(coupledServices).not.toContain('PostgreSQL seat ledger');
  expect(coupledServices).not.toContain('Redis admission queue');
});

test('scene graph declares knowledge, normalization, render and verification nodes', () => {
  const graph = readFileSync(join(import.meta.dir, '../../plugins/demo-brief-to-requirements/graphs/scene4-architecture.yaml'), 'utf8');
  for (const contract of ['scene4.knowledge@1', 'scene4.normalize@1', 'scene4.render@1', 'scene4.verify@1']) expect(graph).toContain(contract);
});

test('scene 4 isolates the model turn and restores the user directory, including failures', async () => {
  let cwd = '/user/project';
  let isolated = '';
  await expect(withScene4Workspace(prompt, { getCwd: () => cwd, setCwd: value => { cwd = value; },
    run: async () => { isolated = cwd; expect(isolated).not.toBe('/user/project'); expect(existsSync(isolated)).toBe(true); throw new Error('model failed'); },
  })).rejects.toThrow('model failed');
  expect(cwd).toBe('/user/project');
  expect(existsSync(isolated)).toBe(false);
  expect(SCENE4_DRAFT_POLICY).toContain('추가 질문을 기다리지 말고');
  expect(isTicketingArchitecturePrompt(prompt.replace('설계해줘', '설계 전에 먼저 질문해줘'))).toBe(false);
  expect(isTicketingArchitecturePrompt(prompt.replace('설계해줘', '설계 전에 질문 먼저 해줘'))).toBe(false);
  expect(isTicketingArchitecturePrompt(prompt.replace('설계해줘', '먼저 몇 가지 질문을 해주세요'))).toBe(false);
  expect(isTicketingArchitecturePrompt(prompt.replace('설계해줘', 'ask me clarifying questions first, then design'))).toBe(false);
  expect(isTicketingArchitecturePrompt(prompt.replace('설계해줘', 'ask questions before designing'))).toBe(false);
  expect(isTicketingArchitecturePrompt(prompt.replace('설계해줘', '먼저 필요한 사항을 물어봐줘'))).toBe(false);
  expect(isTicketingArchitecturePrompt(prompt.replace('설계해줘', '먼저 확인 질문 부탁드립니다'))).toBe(false);
  expect(isTicketingArchitecturePrompt(prompt.replace('설계해줘', '먼저 질문 몇 개 부탁드립니다'))).toBe(false);
  expect(isTicketingArchitecturePrompt(prompt.replace('설계해줘', '먼저 질문해 주시겠어요?'))).toBe(false);
  expect(isTicketingArchitecturePrompt(prompt.replace('설계해줘', '먼저 질문 주시면 안 됩니다'))).toBe(true);
  expect(isTicketingArchitecturePrompt(prompt.replace('설계해줘', '먼저 질문해 주세요가 아니라, 질문 없이 바로 설계해줘'))).toBe(true);
  expect(isTicketingArchitecturePrompt(prompt.replace('설계해줘', '먼저 질문해 주세요가 아니라, 설계부터 해줘'))).toBe(true);
  expect(isTicketingArchitecturePrompt(prompt.replace('설계해줘', '먼저 질문해 주세요가 아니라, 질문 없이 바로 설계해줘')
    .replace('핵심 제약:', '핵심 제약: 먼저 대기열 정책을 질문해줘.'))).toBe(false);
  expect(isTicketingArchitecturePrompt(prompt.replace('설계해줘', '먼저 질문하지 말고 설계해줘'))).toBe(true);
  expect(isTicketingArchitecturePrompt(prompt.replace('설계해줘', '먼저 대기열 정책을 질문해줘')
    .replace('핵심 제약:', '핵심 제약: 결제 세부 사항은 질문하지 말고.'))).toBe(false);
  expect(isTicketingArchitecturePrompt(prompt.replace('설계해줘', '먼저 대기열 정책을 질문해줘 그리고 결제 세부사항은 질문하지 말고 설계해줘'))).toBe(false);
  expect(isTicketingArchitecturePrompt(prompt.replace('동시 100,000명', '규모는 미정'))).toBe(false);
});
