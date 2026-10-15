import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildCoordRolePack, buildCoordRolePackManifest } from './coord-role-pack.js';

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
    expect(first.excludedCardIds).toEqual([]);
    expect(first.body).not.toMatch(/K-1014-\d+|## K-OP-\d+|\/Users\/[A-Za-z0-9._-]+|\u{1F451}/u);
  }
});

test('knowledge file is outside the role pack input', () => {
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
    write('docs/roles/OP/KNOWHOW.md', '## K-OP-004\nNEVER_INCLUDE_UNVERIFIED\n');
    const after = buildCoordRolePackManifest('coordinator', root);
    expect(after).toEqual(before);
    expect(after.body).not.toContain('NEVER_INCLUDE_UNVERIFIED');
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
