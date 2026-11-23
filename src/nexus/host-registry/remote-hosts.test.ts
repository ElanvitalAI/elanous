/**
 * NEXUS-REMOTE-HOST-REGISTRY(P2-1) — 원격 머신 정본(remote-hosts.json) 로더·스키마 검증·별칭 조회.
 * 완료선: 정본 파일에 원격 머신 각각의 ssh(별칭/주소)·금고·relay·tailnet 정의 +
 * 스키마 검증(필수 필드 누락·빈 값 → 명시적 throw) + 별칭 조회(실제 머신명 → 레지스트리 키) +
 * 미등록 원격지 → 명시적 오류(조용한 빈표 아님). 부재 시 러드(loud) 실패.
 * 출처: ROSTER-0334 P2-1 · OP #134157 착수 점검.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  remoteHostsPath,
  readRemoteHosts,
  resolveRemoteHost,
  type RemoteHostsFile,
} from './remote-hosts.js';
import { setTestStateRoot } from '../paths.js';

const FIXTURE = {
  version: 1,
  hosts: {
    'node-b': {
      ssh: { alias: 'node-b', hostName: 'node-b.tailnet-example.ts.net' },
      vault: 'mshq-eln-secret',
      relay: 'tailscale',
      tailnet: '100.64.0.1',
    },
    mbp: {
      ssh: { alias: 'mbp', hostName: '100.64.0.2', user: 'user' },
      vault: 'mshq-eln-secret',
      relay: 'tailscale',
      tailnet: '100.64.0.2',
    },
    minim5: {
      ssh: { alias: 'minim5', hostName: '100.101.68.67', user: 'user' },
      vault: 'mshq-eln-secret',
      relay: 'tailscale',
      tailnet: '100.101.68.67',
    },
  },
};

function fixtureDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `remote-hosts-${name}-`));
  const path = join(dir, 'remote-hosts.json');
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('NEXUS-REMOTE-HOST-REGISTRY: 원격 머신 정본 로더', () => {
  test('정본 파일을 읽어 호스트 맵을 반환한다', () => {
    const dir = fixtureDir('valid');
    const path = join(dir, 'remote-hosts.json');
    writeFileSync(path, JSON.stringify(FIXTURE), 'utf8');
    const hosts = readRemoteHosts(path);
    expect(Object.keys(hosts).sort()).toEqual(['mbp', 'minim5', 'node-b']);
    expect(hosts['node-b'].relay).toBe('tailscale');
    expect(hosts['node-b'].ssh.hostName).toBe('node-b.tailnet-example.ts.net');
    rmSync(dir, { recursive: true, force: true });
  });

  test('파일 부재 시 러드(loud) 실패 — 조용한 빈표 아님', () => {
    const dir = fixtureDir('missing');
    const path = join(dir, 'remote-hosts.json');
    expect(() => readRemoteHosts(path)).toThrow(/remote-hosts\.json.*없|absent|missing/i);
    rmSync(dir, { recursive: true, force: true });
  });

  test('스키마 위반(필수 필드 누락·빈 값)은 항목 키를 밝힌 채 throw', () => {
    const dir = fixtureDir('malformed');
    const path = join(dir, 'remote-hosts.json');
    const bad = { version: 1, hosts: { 'node-b': { ssh: { alias: '' }, tailnet: '100.64.0.1' } } };
    writeFileSync(path, JSON.stringify(bad), 'utf8');
    expect(() => readRemoteHosts(path)).toThrow(/node-b/);
    rmSync(dir, { recursive: true, force: true });
  });

  test('실제 머신명 별칭으로 레지스트리 키를 찾는다 (MacStudioB1 → node-b)', () => {
    const dir = fixtureDir('alias');
    const path = join(dir, 'remote-hosts.json');
    // 출처: PREGATE-RED/39735-24115a6a867d-node-b-114051 — TS2339(.aliases 없음): FIXTURE 추론 타입 대신 정본 RemoteHostsFile 타입으로 캐스트(aliases?: string[]).
    const aliased = JSON.parse(JSON.stringify(FIXTURE)) as RemoteHostsFile;
    aliased.hosts['node-b'].aliases = ['MacStudioB1'];
    writeFileSync(path, JSON.stringify(aliased), 'utf8');
    expect(resolveRemoteHost(path, 'MacStudioB1')?.host).toBe('node-b');
    expect(resolveRemoteHost(path, 'node-b')?.host).toBe('node-b');
    rmSync(dir, { recursive: true, force: true });
  });

  test('미등록 원격지는 명시적 오류 (undefined 반환 아님)', () => {
    const dir = fixtureDir('unknown');
    const path = join(dir, 'remote-hosts.json');
    writeFileSync(path, JSON.stringify(FIXTURE), 'utf8');
    expect(() => resolveRemoteHost(path, 'no-such-host')).toThrow(/no-such-host/);
    rmSync(dir, { recursive: true, force: true });
  });

  test('기본 경로는 nexus 루트의 remote-hosts.json (시험 상태 루트 격리)', () => {
    const dir = fixtureDir('default-path');
    setTestStateRoot(dir);
    try {
      const p = remoteHostsPath();
      expect(p.startsWith(dir)).toBe(true);
      expect(p.endsWith('remote-hosts.json')).toBe(true);
    } finally {
      setTestStateRoot(null);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});