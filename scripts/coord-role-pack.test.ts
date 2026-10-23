import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildCoordRolePack, buildCoordRolePackManifest, type RolePack } from './coord-role-pack.js';

test('coordinator and guardian packs start with L0 prohibitions and have deterministic hashes', () => {
  for (const role of ['coordinator', 'guardian'] as const) {
    const first = buildCoordRolePackManifest(role);
    expect(first).toEqual(buildCoordRolePackManifest(role));
    expect(first.body.startsWith('# 금지 목록\n')).toBe(true);
    expect(first.body).toContain('L0에서는 우편 답글 제안만 한다');
    expect(first.body).toContain('권한을 부여하지 않는다');
    expect(first.sha256).toBe(createHash('sha256').update(first.body).digest('hex'));
    expect(buildCoordRolePack(role)).toBe(first.body);
    const prefix = role === 'coordinator' ? 'C' : 'G';
    const count = role === 'coordinator' ? 14 : 12;
    const marker = `→ 팩 ${role === 'coordinator' ? '조율자' : '수호자'} v1`;
    expect(first.includedCardIds).toEqual(Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`));
    const cardLines = first.body.split('\n').filter((line) => new RegExp(`^- ${prefix}\\d+ · `).test(line));
    expect(cardLines).toHaveLength(count);
    for (const [index, line] of cardLines.entries()) expect(line).toMatch(new RegExp(`^- ${prefix}${index + 1} · .+ ${marker}$`));
    expect(first.body).not.toMatch(role === 'coordinator' ? /^- G\d+ · /m : /^- C\d+ · /m);
    expect(first.body).not.toMatch(/- L(?:[1-9]|[12]\d) · /);
    for (const id of first.excludedCardIds) {
      expect(id).toMatch(/^K-[A-Za-z]+(?:-[A-Za-z]{1,4})?-\d+$/);
      expect(first.body).not.toContain(`- ${id} · `);
    }
    expect(first.body).not.toMatch(/K-1014-\d+|\/Users\/[A-Za-z0-9._-]+|\u{1F451}/u);
    // KNOWHOW 출처 해시가 sources에 남는다(통과 카드 본문까지 싣는 근거).
    const knowhowSource = first.sources.find((source) => source.path === 'docs/roles/OP/KNOWHOW.md');
    expect(knowhowSource).toBeDefined();
  }
});

test('lint-pass knowhow entries are included and lint-fail/secret entries are excluded', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-role-pack-'));
  const write2 = (base: string, path: string, content: string) => {
    const target = join(base, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const write = (path: string, content: string) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    write('package.json', '{"version":"0.2.29-test"}');
    for (const path of ['AGENTS.md', 'docs/roles/OP.md', 'docs/handbook/LOOP-AGENTS.md', 'docs/handbook/OPERATIONS.md', 'scripts/coord-role-pack.ts']) write(path, '# Fixture\n');
    const knowhow = [
      '## K-OP-901 린트 통과 항목',
      '- 상황: 칸 판정에 쓸 관측이 필요하다.',
      '- 신호(관측): 이 칸의 판정 근거를 잰다.',
      '- 원인(인지): 관측이 비어 있으면 판정도 비어 있다.',
      '- 처방(힐링): 먼저 재는 명령으로 관측을 채운다.',
      '- 재는 명령: `rg -c GEV ~/elanous-hq/bin/ta-dispatcher.sh`',
      '- 기대: ≥1',
      '- 유효 조건: 항상',
      '- 검증: 2026-10-14 참 (OP · #27510)',
      '- 출처: OP · 상태: active',
      '',
      '## K-OP-902 필수 칸 누락 항목',
      '- 상황: 재는 명령이 없다.',
      '- 출처: OP · 상태: active',
      '',
      '## K-OP-903 비밀값 항목',
      '- 상황: 자격 값이 카드 본문에 있다.',
      '- 신호(관측): 비밀값이 잡힌다.',
      '- 원인(인지): 비밀값을 문서에 남겼다.',
      '- 처방(힐링): 카드를 제외한다.',
      '- 재는 명령: `ls ~/elanous-hq`',
      '- 기대: ≥0',
      '- 유효 조건: 항상',
      '- 검증: 2026-10-14 참 (OP)',
      '- 출처: sk-proj-abcdefghijklmnopqrs · 상태: active',
    ].join('\n');
    write('docs/roles/OP/KNOWHOW.md', knowhow);
    const pack = buildCoordRolePackManifest('coordinator', root);
    expect(pack.body).toContain('- K-OP-901 · 린트 통과 항목');
    // 통과 카드의 본문 전체가 팩 몸에 실린다(제목만이 아니라).
    expect(pack.body).toContain('- 상황: 칸 판정에 쓸 관측이 필요하다.');
    expect(pack.body).toContain('## K-OP-901 린트 통과 항목');
    // sources에 KNOWHOW 파일의 SHA256이 남는다.
    expect(pack.sources.find((source) => source.path === 'docs/roles/OP/KNOWHOW.md')).toEqual({
      path: 'docs/roles/OP/KNOWHOW.md',
      sha256: createHash('sha256').update(knowhow).digest('hex'),
    });
    expect(pack.body).not.toContain('필수 칸 누락 항목');
    expect(pack.body).not.toContain('비밀값 항목');
    expect(pack.body).not.toMatch(/sk-proj-|credential assignment|api[_-]?key/i);
    expect(pack.includedCardIds).not.toContain('K-OP-901');
    expect(pack.excludedCardIds).toEqual(['K-OP-902', 'K-OP-903']);
    expect(pack.body.startsWith('# 금지 목록\n')).toBe(true);
    expect(pack.body.indexOf('## KNOWHOW')).toBeGreaterThan(pack.body.indexOf('# 금지 목록'));
    expect(buildCoordRolePack('coordinator', root)).toBe(pack.body);
    // 같은 입력 → 같은 해시
    const twin = mkdtempSync(join(tmpdir(), 'coord-role-pack-'));
    try {
      write2(twin, 'package.json', '{"version":"0.2.29-test"}');
      for (const path of ['AGENTS.md', 'docs/roles/OP.md', 'docs/handbook/LOOP-AGENTS.md', 'docs/handbook/OPERATIONS.md', 'scripts/coord-role-pack.ts']) write2(twin, path, '# Fixture\n');
      write2(twin, 'docs/roles/OP/KNOWHOW.md', knowhow);
      expect(buildCoordRolePackManifest('coordinator', twin).sha256).toBe(pack.sha256);
    } finally { rmSync(twin, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('knowhow-less fixture packs ignore missing knowhow file', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-role-pack-'));
  const write = (path: string, content: string) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    write('package.json', '{"version":"0.2.29-test"}');
    for (const path of ['AGENTS.md', 'docs/roles/OP.md', 'docs/handbook/LOOP-AGENTS.md', 'docs/handbook/OPERATIONS.md', 'scripts/coord-role-pack.ts']) write(path, '# Fixture\n');
    const before = buildCoordRolePackManifest('coordinator', root);
    expect(before.excludedCardIds).toEqual([]);
    expect(before.body).not.toContain('- K-OP-');
    write('docs/roles/OP/KNOWHOW.md', '## K-OP-004\nNEVER_INCLUDE_UNVERIFIED\n');
    const after = buildCoordRolePackManifest('coordinator', root);
    // 제외된 카드는 팩 몸에 안 실린다. 몸은 출처 해시 줄 하나가 늘어난 것 외에는 같다.
    const knowhowHash = createHash('sha256').update('## K-OP-004\nNEVER_INCLUDE_UNVERIFIED\n').digest('hex');
    const withoutKnowhowLine = after.body.split('\n').filter((line) => line !== `- docs/roles/OP/KNOWHOW.md: ${knowhowHash}`).join('\n');
    expect(withoutKnowhowLine).toBe(before.body);
    expect(after.body).not.toContain('NEVER_INCLUDE_UNVERIFIED');
    expect(after.excludedCardIds).toEqual(['K-OP-004']);
    // 파일이 생겼으므로 출처 기록(·그에 묶인 팩 해시)은 달라진다.
    expect(after.sources.find((source) => source.path === 'docs/roles/OP/KNOWHOW.md')).toEqual({
      path: 'docs/roles/OP/KNOWHOW.md',
      sha256: createHash('sha256').update('## K-OP-004\nNEVER_INCLUDE_UNVERIFIED\n').digest('hex'),
    });
    expect(after.sha256).not.toBe(before.sha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a present but unreadable KNOWHOW source fails instead of silently omitting cards', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-role-pack-read-error-'));
  try {
    mkdirSync(join(root, 'docs/roles/OP/KNOWHOW.md'), { recursive: true });
    expect(() => buildCoordRolePackManifest('coordinator', root)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a package root without internal source docs still builds the inline pack', () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-role-pack-pkg-'));
  try {
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'package.json'), '{"version":"0.2.29-pkg"}');
    writeFileSync(join(root, 'scripts/coord-role-pack.ts'), '// packaged\n');
    for (const role of ['coordinator', 'guardian'] as const) {
      const pack = buildCoordRolePackManifest(role, root);
      expect(pack.body.startsWith('# 금지 목록\n')).toBe(true);
      expect(pack.body).toContain('판: 0.2.29-pkg');
      expect(pack.includedCardIds).toEqual(buildCoordRolePackManifest(role).includedCardIds);
      expect(pack.sources.map((source) => source.path)).toEqual(['scripts/coord-role-pack.ts']);
      expect(pack.missingSources).toEqual(['AGENTS.md', 'docs/roles/OP.md', 'docs/handbook/LOOP-AGENTS.md', 'docs/handbook/OPERATIONS.md']);
      expect(pack.body).toContain('- AGENTS.md: 없음(이 설치본에 미포함)');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('changing a lint-pass knowhow card body changes sources and the pack hash', () => {
  const cardFields = [
    '- 신호(관측): 이 칸의 판정 근거를 잰다.',
    '- 원인(인지): 관측이 비어 있으면 판정도 비어 있다.',
    '- 처방(힐링): 먼저 재는 명령으로 관측을 채운다.',
    '- 재는 명령: `rg -c GEV ~/elanous-hq/bin/ta-dispatcher.sh`',
    '- 기대: ≥1',
    '- 유효 조건: 항상',
    '- 검증: 2026-10-14 참 (OP · #27510)',
    '- 출처: OP · 상태: active',
  ].join('\n');
  const build = (situation: string) => {
    const root = mkdtempSync(join(tmpdir(), 'coord-role-pack-'));
    const write = (path: string, content: string) => {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    };
    try {
      write('package.json', '{"version":"0.2.29-test"}');
      for (const path of ['AGENTS.md', 'docs/roles/OP.md', 'docs/handbook/LOOP-AGENTS.md', 'docs/handbook/OPERATIONS.md', 'scripts/coord-role-pack.ts']) write(path, '# Fixture\n');
      const knowhow = [
        `## K-OP-901 린트 통과 항목`,
        situation,
        cardFields,
        '',
      ].join('\n');
      write('docs/roles/OP/KNOWHOW.md', knowhow);
      return { pack: buildCoordRolePackManifest('coordinator', root), knowhow, root };
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  };
  const first = build('- 상황: 첫 판 본문이다.');
  const second = build('- 상황: 같은 제목의 카드 본문만 바꿨다.');
  try {
    expect(first.pack.excludedCardIds).not.toContain('K-OP-901');
    expect(second.pack.excludedCardIds).not.toContain('K-OP-901');
    // 제목은 같아도 본문이 달라지면 팩 해시도 출처 기록도 달라진다.
    expect(first.pack.body).toContain('- 상황: 첫 판 본문이다.');
    expect(second.pack.body).toContain('- 상황: 같은 제목의 카드 본문만 바꿨다.');
    expect(first.pack.sha256).not.toBe(second.pack.sha256);
    expect(first.pack.sources.find((source) => source.path === 'docs/roles/OP/KNOWHOW.md')?.sha256)
      .not.toBe(second.pack.sources.find((source) => source.path === 'docs/roles/OP/KNOWHOW.md')?.sha256);
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
  }
});

// 실물 CLI 진입(import.meta.main)을 서브프로세스로 지나는 증거 — 합성 fixture 나 소스 문자열이 아니라
// 생산 명령 `bun scripts/coord-role-pack.ts` 자체를 돌려 라이브러리 경로와 같은 팩이 나오는지 잰다.
test('CLI entry emits the lint-filtered pack deterministically through the production command', () => {
  const runCli = (args: string[]) => spawnSync(process.execPath, ['scripts/coord-role-pack.ts', ...args], {
    cwd: join(import.meta.dir, '..'),
    encoding: 'utf8',
    timeout: 60000,
  });
  const jsonRun = runCli(['--role', 'coordinator', '--json']);
  expect(jsonRun.status).toBe(0);
  const pack = JSON.parse(jsonRun.stdout) as RolePack;
  // CLI 진입이 내는 팩은 라이브러리 경로가 내는 팩과 같다(진입 배선이 어긋나지 않는다).
  expect(pack).toEqual(buildCoordRolePackManifest('coordinator'));
  expect(pack.body.startsWith('# 금지 목록\n')).toBe(true);
  expect(pack.sha256).toBe(createHash('sha256').update(pack.body).digest('hex'));
  for (const id of pack.excludedCardIds) expect(id).toMatch(/^K-[A-Za-z]+(?:-[A-Za-z]{1,4})?-\d+$/);
  // 같은 입력 → 프로세스 경계를 넘어도 같은 출력(결정적 해시).
  expect(runCli(['--role', 'coordinator', '--json']).stdout).toBe(jsonRun.stdout);
  // 비밀값은 CLI 출력 전체(JSON 메타데이터 포함)에 없다.
  expect(jsonRun.stdout).not.toMatch(/sk-proj-|credential assignment|api[_-]?key|K-1014-\d+|\/Users\/[A-Za-z0-9._-]+/i);
  // 비-JSON 모드는 팩 몸을 그대로 낸다.
  const bodyRun = runCli(['--role', 'guardian']);
  expect(bodyRun.status).toBe(0);
  expect(bodyRun.stdout).toBe(buildCoordRolePack('guardian'));
});

test('CLI entry rejects missing or invalid --role with usage and exit code 2', () => {
  for (const args of [[], ['--role', 'bogus']] as const) {
    const run = spawnSync(process.execPath, ['scripts/coord-role-pack.ts', ...args], {
      cwd: join(import.meta.dir, '..'),
      encoding: 'utf8',
      timeout: 60000,
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('usage: bun scripts/coord-role-pack.ts --role coordinator|guardian [--json]');
  }
});

const CARD_BODY = [
  '- 신호(관측): 이 칸의 판정 근거를 잰다.',
  '- 원인(인지): 관측이 비어 있으면 판정도 비어 있다.',
  '- 처방(힐링): 먼저 재는 명령으로 관측을 채운다.',
  '- 재는 명령: `rg -c GEV ~/elanous-hq/bin/ta-dispatcher.sh`',
  '- 기대: ≥1',
  '- 유효 조건: 항상',
  '- 검증: 2026-10-14 참 (OP · #27510)',
  '- 출처: OP · 상태: active',
];

const buildFixturePack = (knowhow: string, prefix: string): RolePack => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const write = (path: string, content: string) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    write('package.json', '{"version":"0.2.35-test"}');
    for (const path of ['AGENTS.md', 'docs/roles/OP.md', 'docs/handbook/LOOP-AGENTS.md', 'docs/handbook/OPERATIONS.md', 'scripts/coord-role-pack.ts']) write(path, '# Fixture\n');
    write('docs/roles/OP/KNOWHOW.md', knowhow);
    return buildCoordRolePackManifest('coordinator', root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

// 판정선 ① — 린트 문법을 벗어난 카드 제목은 "통과도 제외 기록도 아닌" 채로 조용히 사라지면 안 된다.
// 조용히 사라지면 실패 카드가 실린 것과 구별되지 않고, 번호를 잘라 읽으면 엉뚱한 아이디가 제외 기록에 남는다.
test('a card-shaped heading that deviates from the lint grammar fails instead of vanishing', () => {
  const knowhow = [
    '## K-OP-901 린트 통과 항목',
    '- 상황: 901 은 정상 카드다.',
    ...CARD_BODY,
    '',
    '## K-OP-901extra 제목 문법이 어긋난 카드',
    '- 상황: 이 카드는 제목이 K-<자리>-<번호>를 벗어난다.',
    ...CARD_BODY,
  ].join('\n');
  expect(() => buildFixturePack(knowhow, 'coord-role-pack-heading-')).toThrow(/카드 제목 형식이 K-<자리>-<번호>를 벗어남/);
});

// 판정선 ② — 린트가 카드 제목으로 인정하는 들여쓰기(0~3칸)는 자를 때도 카드 경계다.
// 자를 때 놓치면 앞 카드에 흡수돼 이 카드가 린트조차 못 본 채 사라진다.
test('a card heading indented up to three spaces still splits its own card', () => {
  const knowhow = [
    '## K-OP-910 첫 카드',
    '- 상황: 첫 카드다.',
    ...CARD_BODY,
    '',
    '   ## K-OP-911 들여 쓴 둘째 카드',
    '- 상황: 둘째 카드다.',
    ...CARD_BODY,
  ].join('\n');
  const pack = buildFixturePack(knowhow, 'coord-role-pack-indent-');
  expect(pack.excludedCardIds).toEqual([]);
  expect(pack.body).toContain('- K-OP-910 · 첫 카드');
  expect(pack.body).toContain('- K-OP-911 · 들여 쓴 둘째 카드');
});

// 생산 CLI 실물 — 실제 CLI가 읽는 KNOWHOW 에 문법 위반 카드와 고유 비밀 표식을 심는다.
// 구현과 같은 카드 제목 정규식으로 원본 카드를 세는 전수 회계는 정규식이 놓친 제목을 잡지 못한다(양쪽이
// 같은 정규식을 쓰면 회계가 통과해도 누락은 안 보인다). 그래서 이 시험은 회계를 하지 않는다.
test('production CLI makes a planted grammar-violating KNOWHOW card fail or excluded explicitly, never silently', () => {
  const repo = join(import.meta.dir, '..');
  // 시험의 독립적 기대값 — 구현의 회계 정규식을 빌리지 않고 심은 카드에서 나온다:
  // `## K-OP-9901X` 제목은 K-<자리>-<번호> 뒤에 글자가 붙어 문법을 벗어뜨렸다.
  const violatingCardId = 'K-OP-9901X';
  const secretMarker = 'knowhow-canary-8f2d47c1';
  const root = mkdtempSync(join(tmpdir(), 'coord-role-pack-canary-'));
  const write = (path: string, content: string) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    // 실제 CLI 바이트와 실제 src 구현이 읽는 루트 — CLI 는 스크립트 위치(import.meta.dir/..)를 루트로 쓴다.
    write('scripts/coord-role-pack.ts', readFileSync(join(repo, 'scripts/coord-role-pack.ts'), 'utf8'));
    symlinkSync(join(repo, 'src'), join(root, 'src'), 'dir');
    write('package.json', '{"version":"0.2.35-canary"}');
    // 실제 KNOWHOW 원본에 문법 위반 카드(몸에 고유 비밀 표식)를 심는다.
    const original = readFileSync(join(repo, 'docs/roles/OP/KNOWHOW.md'), 'utf8');
    const planted = [
      `## ${violatingCardId} 제목 문법을 고의로 벗어뜨린 카드`,
      `- 상황: 이 카드 몸에는 ${secretMarker} 비밀 표식이 있다.`,
      '- 신호(관측): 제목이 K-<자리>-<번호> 뒤에 글자를 붙여 문법을 벗어뜨렸다.',
    ].join('\n');
    write('docs/roles/OP/KNOWHOW.md', `${original}${original.endsWith('\n') ? '' : '\n'}${planted}\n`);
    const run = spawnSync(process.execPath, ['scripts/coord-role-pack.ts', '--role', 'coordinator', '--json'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60000,
    });
    // 관측: CLI 실행 결과에서 심은 카드가 어찌 다뤄졌는지 읽는다.
    const output = `${run.stdout}${run.stderr}`;
    const explicitFailure = run.status !== 0
      && run.stderr.includes(violatingCardId)
      && run.stderr.includes('카드 제목 형식이 K-<자리>-<번호>를 벗어남');
    const explicitExclusion = run.status === 0
      && (JSON.parse(run.stdout) as RolePack).excludedCardIds.includes(violatingCardId);
    // 독립 기대값과의 대조 — (a) 이 카드는 명시적으로 실패하거나 제외된다. (b) 비밀 표식은 출력에 나오지 않는다.
    // 카드가 조용히 사라지면(실패도 제외도 없으면) 첫 단정이, 표식이 출력에 새면 둘째 단정이 잡는다.
    expect(explicitFailure || explicitExclusion).toBe(true);
    expect(output.includes(secretMarker)).toBe(false);
  } finally {
    rmSync(join(root, 'src'), { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
