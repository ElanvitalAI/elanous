import { setDefaultTimeout, afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideTypeAction, type TypeTarget } from './browser-act-type.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const HOSTS = ['news.ycombinator.com'];
const target = (over: Partial<TypeTarget> = {}): TypeTarget => ({
  tag: 'input', type: 'text', name: 'q', id: null, contentEditable: false, inForm: true, ...over,
});
const decide = (over: Partial<Parameters<typeof decideTypeAction>[0]> = {}) => decideTypeAction({
  url: 'https://news.ycombinator.com/', selector: '#q', text: 'ai news',
  actionHosts: HOSTS, armed: true, target: target(), ...over,
});

describe('decideTypeAction — 하니스 타이핑 판정', () => {
  test('✅ 평범한 짧은 텍스트와 실재 셀렉터는 허용한다 (알려진 음성)', () => {
    const v = decide();
    expect(v.allowed).toBe(true);
    expect(v.reason).toContain('news.ycombinator.com');
  });

  test('⛔ 개행이 든 텍스트는 거부한다 — 많은 칸에서 개행은 제출과 같다', () => {
    for (const text of ['ai\nnews', 'ai\r\nnews', 'ai\r']) {
      const v = decide({ text });
      expect(v.allowed).toBe(false);
      expect(v.reason).toContain('개행');
    }
  });

  test('반환은 { allowed, reason } 이다', () => {
    const v = decide();
    expect(typeof v.allowed).toBe('boolean');
    expect(typeof v.reason).toBe('string');
    expect(Object.keys(v).sort()).toEqual(['allowed', 'reason']);
  });
});

describe('decideTypeAction — 판정만 한다 (실행 경로를 안 연다)', () => {
  const RAW = readFileSync(join(import.meta.dir, 'browser-act-type.ts'), 'utf8');
  const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

  test('judgeTypeRequest 를 import 해서 재사용한다 — 로직을 복제하지 않는다', () => {
    expect(SRC).toContain('judgeTypeRequest');
    expect(SRC).toMatch(/from ['"][^'"]*bot-type-request/);
  });

  test('키 이벤트를 보내는 길을 만들지 않는다', () => {
    expect(SRC).not.toContain('dispatchKeyEvent');
    expect(SRC).not.toContain('Input.dispatchKey');
    expect(SRC).not.toContain('Input.insertText');
  });

  test('이 판에서 harness browser-type CLI 를 열지 않는다', () => {
    expect(SRC).not.toContain('browser-type');
    expect(SRC).not.toContain('program.command');
  });
});

// ⌨️🚪 CLI 표면(`harness browser-type`) — 판정기는 이미 있었고 «부를 문»이 없었다.
//   ⛔⭐ 이 절의 본선은 「명령이 있나」가 아니라 ***「허용 호스트를 «누가» 주나」***다.
//   호출자가 `--action-hosts` 로 줄 수 있으면 치려는 호스트를 스스로 선언해
//   `decideTypeAction` 의 호스트 검사가 «자기충족»되고, 경계는 «있는 척»만 한다.
describe('harness browser-type — 허용 호스트의 «출처»', () => {
  const SRC = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf8');
  const BLOCK = SRC.slice(SRC.indexOf('runHarnessBrowserType'), SRC.indexOf("harnessCmd\n  .command('browser-act"));

  test('⛔ 호출자가 허용 호스트를 «직접 못 준다» — 그 옵션이 «등록»돼 있지 않다', () => {
    // ⛔ 원문 그대로 grep 하면 «주석에 적은 금지 사유»가 걸린다(그 문자열이 설명에 나온다).
    //    ⇒ 재는 것은 「낱말이 있나」가 아니라 ***「Commander 에 «등록»됐나」***다.
    expect(SRC).not.toMatch(/\.option\(\s*'--action-hosts/);
    expect(BLOCK).not.toMatch(/actionHosts:\s*parse/);
  });

  test('✅ 허용 호스트는 «페르소나»에서 온다 — browser-act 와 같은 출처 (재발명 0)', () => {
    expect(BLOCK).toContain('persona?.actionHosts');
    expect(BLOCK).toContain('awaitGlobalPersonaLoad');
    expect(BLOCK).toContain('getGlobalPersonaRegistry');
  });

  test('⛔ 없는 페르소나는 «조용히» 빈 허용목록으로 안 흘린다 — fail-closed', () => {
    expect(BLOCK).toContain('describeMissingPersona');
    // 「없으면 빈 배열로 계속」 형태가 아니어야 한다 — 그러면 경계 없이 재고 그럴듯한 판정이 나온다
    expect(BLOCK).toMatch(/persona !== undefined && persona === undefined/);
  });

  test('⛔ 이 판은 «문»만 연다 — 키 이벤트·제출을 안 담는다', () => {
    for (const forbidden of ['Input.dispatchKeyEvent', 'insertText', '.submit(', 'performBrowserAction(']) {
      expect(BLOCK).not.toContain(forbidden);
    }
  });

  test('✅ 명령이 등록돼 있고 판정이 거부면 종료 코드가 0 이 아니다', () => {
    expect(SRC).toContain(".command('browser-type <url> <selector> <text>')");
    expect(SRC).toMatch(/if \(!decision\.allowed\) process\.exitCode = 1;/);
  });
});

// 🚦 **실물 입구 검증** — ⛔ 문자열 검색은 「그 코드가 실행 경로에 있는가」를 «원리상» 못 답한다.
//   그래서 여기서는 진짜 CLI 를 spawn 해서 종료 코드와 산출을 «본다».
//   ⭐ 알려진 «양성»(허용된다)과 알려진 «음성»(같은 페르소나·다른 호스트)을 «둘 다» 누른다 —
//     부정만 재면 자가 죽어도 만점이 나온다.
describe('harness browser-type — 실물 CLI (spawn)', () => {
  const repoRoot = join(import.meta.dir, '..', '..');
  const personaDir = mkdtempSync(join(tmpdir(), 'browser-type-persona-'));
  const TARGET = '{"tag":"input","type":"text","name":"q","id":null,"contentEditable":false,"inForm":true}';

  beforeAll(() => {
    writeFileSync(join(personaDir, 'typeprobe.yaml'),
      'personaId: typeprobe\ndisplayName: TypeProbe\nactionHosts:\n  - news.ycombinator.com\n');
  });
  afterAll(() => { rmSync(personaDir, { recursive: true, force: true }); });

  const run = (args: string[]) => {
    const r = spawnSync('bun', ['bin/elanous.mjs', 'harness', 'browser-type', ...args],
      { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ELANOUS_PERSONAS_DIR: personaDir } });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  test('🎯 알려진 «양성» — 선언된 호스트는 허용되고 종료 코드가 0 이다', () => {
    const r = run(['--armed', '--persona', 'typeprobe', '--target-json', TARGET,
      'https://news.ycombinator.com/', '#q', 'ai news']);
    expect(r.out).toContain('"allowed":true');
    expect(r.code).toBe(0);
  }, 60_000);

  test('🎯 알려진 «음성» — 같은 페르소나로 «다른» 호스트는 못 연다 (자기충족 차단)', () => {
    const r = run(['--armed', '--persona', 'typeprobe', '--target-json', TARGET,
      'https://evil.example.com/', '#q', 'ai news']);
    expect(r.out).toContain('"allowed":false');
    expect(r.out).toContain('news.ycombinator.com'); // 선언된 곳을 «이름으로» 댄다
    expect(r.code).not.toBe(0);
  }, 60_000);

  test('⛔ 없는 페르소나는 fail-closed — 스택 트레이스가 아니라 «조회한 곳»을 댄다', () => {
    const r = run(['--armed', '--persona', 'nosuchbot', 'https://news.ycombinator.com/', '#q', 'ai']);
    expect(r.out).toContain('"allowed":false');
    expect(r.out).toContain('persona not found');
    expect(r.out).not.toContain('at Object.<anonymous>');
    expect(r.code).not.toBe(0);
  }, 60_000);
});

// ⛔ 「못 읽었다」를 「안 줬다」로 접지 않는다 — 조용한 기본값 폴백은 이 저장소가 반복해 못 박은 결함이다.
describe('harness browser-type — --max-chars 를 «수»로 못 읽으면 거부한다', () => {
  const repoRoot = join(import.meta.dir, '..', '..');
  const personaDir = mkdtempSync(join(tmpdir(), 'browser-type-maxchars-'));
  const TARGET = '{"tag":"input","type":"text","name":"q","id":null,"contentEditable":false,"inForm":true}';
  beforeAll(() => {
    writeFileSync(join(personaDir, 'typeprobe.yaml'),
      'personaId: typeprobe\ndisplayName: TypeProbe\nactionHosts:\n  - news.ycombinator.com\n');
  });
  afterAll(() => { rmSync(personaDir, { recursive: true, force: true }); });
  const run = (maxChars: string) => spawnSync('bun',
    ['bin/elanous.mjs', 'harness', 'browser-type', '--armed', '--persona', 'typeprobe',
      '--max-chars', maxChars, '--target-json', TARGET, 'https://news.ycombinator.com/', '#q', 'ai news'],
    { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ELANOUS_PERSONAS_DIR: personaDir } });

  test('⛔ 숫자가 아니면 «조용히» 기본 상한으로 안 간다', () => {
    const r = run('많이');
    expect(r.stdout).toContain('"allowed":false');
    expect(r.stdout).toContain('못 읽었다');
    expect(r.status).not.toBe(0);
  }, 60_000);

  test('✅ 정상 숫자는 그대로 판정으로 흐른다 (알려진 양성)', () => {
    const r = run('100');
    expect(r.stdout).toContain('"allowed":true');
    expect(r.status).toBe(0);
  }, 60_000);
});
