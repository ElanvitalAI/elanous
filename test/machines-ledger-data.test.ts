import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { loadMachineLedger, renderLedgerMarkdown } from '../src/machines/machine-ledger.js';

const ledgerPath = resolve(import.meta.dir, '../docs/ops/machines.yaml');
const ledger = parse(readFileSync(ledgerPath, 'utf8')) as {
  policy: string[];
  machines: Array<{ id: string; name: string; specs: string; locationStatus: string; role: string; duties: string }>;
  devices: Array<{ id: string; name: string; status: string; purpose: string }>;
  rules: string[];
  changes: string[];
};

describe('machine ledger migration', () => {
  test('retains each compute-resource and portable-device row, including the unnamed purchases', () => {
    expect(ledger.machines.map(({ id, name }) => [id, name])).toEqual([
      ['mbp', 'mbp'],
      ['mac-mini-m5-pro', '(미정)'],
      ['node-b', 'node-b'],
      ['mac-studio-m5-ultra', '(미정)'],
      ['node-c', 'node-c'],
      ['minio', 'minio'],
      ['host-e', 'host-e · host-e-wsl'],
      ['cloud-vm', 'cloud-vm'],
    ]);
    expect(ledger.devices.map(({ id, name }) => [id, name])).toEqual([
      ['macbook-air-m5', 'MacBook Air M5'],
      ['ipad-pro-11', 'iPad Pro 11'],
      ['ipad-mini-7', 'iPad mini 7세대'],
      ['iphone-16-pro', 'iPhone 16 Pro'],
      ['iphone-duo', 'iPhone Duo'],
      ['galaxy-fold-8', 'Galaxy Fold 8'],
    ]);
    expect(ledger.machines.find(({ id }) => id === 'mbp')).toMatchObject({
      specs: 'MacBook Pro M5 Max · 128GB',
      locationStatus: '**사무실** 고정(들고 다니지 않음) · 가동',
      role: '**작업실(사무실 메인)**',
    });
    expect(ledger.machines.find(({ id }) => id === 'mac-mini-m5-pro')?.duties).toContain('이전 = 0.2.8 HQ2(TC)');
    expect(ledger.machines.find(({ id }) => id === 'cloud-vm')?.duties).toContain('폰 릴레이 서비스 설치 예정');
    expect(ledger.devices.find(({ id }) => id === 'iphone-duo')?.status).toBe('**구매 예정**(10-23 출시)');
  });

  test('preserves the original four placement rules and three dated change entries', () => {
    expect(ledger.rules.slice(0, 4)).toEqual([
      '사람이 쓰는 메인 = 사무실 mbp · 재택 node-c.',
      '무거운 병렬 = node-b(→ M5 Ultra 합류 뒤 둘) · 사람이 보는 화면·로그인·로컬 앱 = mbp · 늘 켜져야 하는 것 = 운영 본부(미니 도입 전엔 mbp).',
      '매니지드 좌석 = 두 Ultra 의 리눅스 컨테이너(macOS VM 은 라이선스상 한 대 2개) · 격리 k3d(OrbStack k8s 는 NetworkPolicy 미집행) · 손님 LLM 은 우리 구독 금지 — 자체/클라우드 경계는 TC 매니지드 RFC(10-05).',
      '리눅스 점검 = 셋업 안정화 뒤 **새 베어 VM** 또는 듀얼부팅한 미니 PC(봇 운영 중인 `cloud-vm` 에 먼저 쏘지 않는다).',
    ]);
    expect(ledger.changes.length).toBeGreaterThanOrEqual(3);
    expect(ledger.changes.slice(0, 3).map((entry) => entry.slice(0, 17))).toEqual([
      '2026-09-30 22:5x ',
      '2026-09-30 23:0x ',
      '2026-09-30 23:3x ',
    ]);
    expect(ledger.changes[2]).toContain('맥미니 M5 Pro 64GB 구매 확정');
  });

  test('published Markdown rows, rules and history match the YAML source', () => {
    const markdown = readFileSync(resolve(import.meta.dir, '../docs/ops/LEDGER-machines-and-devices.md'), 'utf8');
    expect(markdown).toBe(renderLedgerMarkdown(loadMachineLedger(resolve(import.meta.dir, '..'))));
    const section = (start: string, end: string) => markdown.split(start)[1]?.split(end)[0] ?? '';
    expect(markdown).toContain('생성 결과 — 보유·역할과 변경 이력의 단일 원본은 [`machines.yaml`](machines.yaml)');
    expect(ledger.policy[0]).toContain('`docs/ops/machines.yaml`');
    expect(ledger.policy).toContain('창은 들고 다니는 기기 · 전부 tailnet 으로 본부·작업실에 붙는다.');
    expect(readFileSync(ledgerPath, 'utf8')).toContain('machine render --check');
    const machineRows = section('## 1. 계산 자원', '## 2. 창');
    const deviceRows = section('## 2. 창', '## 3. 규칙');
    const rules = section('## 3. 규칙', '## 변경');
    const changes = markdown.split('## 변경')[1] ?? '';
    const rows = (text: string) => text.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('|---'));
    expect(rows(machineRows).slice(1)).toEqual(ledger.machines.map((machine) => {
      const names = machine.name === '(미정)' ? machine.name : machine.name.split(' · ').map((name) => `\`${name}\``).join(' · ');
      return `| ${names} | ${machine.specs} | ${machine.locationStatus} | ${machine.role} | ${machine.duties} |`;
    }));
    expect(rows(deviceRows).slice(1)).toEqual(ledger.devices.map((device) =>
      `| ${device.name} | ${device.status} | ${device.purpose} |`,
    ));
    expect(rules.split('\n').filter((line) => line.startsWith('- '))).toEqual(ledger.rules.map((rule) => `- ${rule}`));
    expect(changes.split('\n').filter((line) => line.startsWith('- '))).toEqual(ledger.changes.map((change) => `- ${change}`));
  });

  test('does not publish credentials or private network addresses', () => {
    const content = readFileSync(ledgerPath, 'utf8');
    expect(content).not.toMatch(/(?:sk-(?:proj-|live-)|gh[ps]_|AKIA)[A-Za-z0-9_-]{8,}/);
    expect(content).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  });
});
