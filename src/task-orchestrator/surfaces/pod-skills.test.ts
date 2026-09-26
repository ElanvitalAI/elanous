import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { podSkillFiles, podSkillsDigest, readSkillEnvFiles, resolvePodSkills, stagePodSkills } from './pod-skills.js';
import { podImageFreshness, podJobManifest, podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';

function skillsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pod-skills-'));
  const s = join(root, 'crawl');
  mkdirSync(join(s, 'src'), { recursive: true });
  mkdirSync(join(s, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(s, 'SKILL.md'), '---\nname: crawl\n---\n');
  writeFileSync(join(s, 'src', 'main.ts'), 'export {};\n');
  writeFileSync(join(s, '.env'), 'TAVILY_KEY=secret-value-1\n');
  writeFileSync(join(s, '.env.local'), 'X=secret-value-2\n');
  writeFileSync(join(s, 'auth.json'), '{"token":"secret-value-3"}');
  writeFileSync(join(s, 'client.pem'), 'secret-value-4');
  writeFileSync(join(s, 'node_modules', 'x', 'i.js'), '');
  symlinkSync('/etc/hosts', join(s, 'link'));
  return root;
}

describe('pod skills — code into the image, keys only into the run', () => {
  test('list: env wins over file; names outside the rule are reported, not silently dropped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-skills-list-'));
    const file = join(dir, 'pod-skills.txt');
    writeFileSync(file, '# essentials\nomni-crawl\nyoutube-master  # video\nbad name\n');
    expect(resolvePodSkills({}, file)).toEqual({ skills: ['omni-crawl', 'youtube-master'], source: 'file', invalid: ['bad name'] });
    expect(resolvePodSkills({ ELANOUS_POD_SKILLS: 'a,b' }, file)).toEqual({ skills: ['a', 'b'], source: 'env', invalid: [] });
    expect(resolvePodSkills({}, join(dir, 'absent.txt'))).toEqual({ skills: [], source: 'none', invalid: [] });
  });

  test('the image copy never carries secrets, node_modules or symlinks', () => {
    const root = skillsRoot();
    expect(podSkillFiles(join(root, 'crawl'))).toEqual(['SKILL.md', 'src/main.ts']);
    const dest = mkdtempSync(join(tmpdir(), 'pod-skills-dest-'));
    const r = stagePodSkills(['crawl', 'absent'], dest, root);
    expect(r.staged).toEqual(['crawl']);
    expect(r.missing).toEqual(['absent']);
    expect(readdirSync(join(dest, 'crawl')).sort()).toEqual(['SKILL.md', 'src']);
    expect(existsSync(join(dest, 'crawl', '.env'))).toBe(false);
  });

  test('host home paths in skill docs become ~ (the Pod home differs)', () => {
    const root = skillsRoot();
    writeFileSync(join(root, 'crawl', 'SKILL.md'), 'cd /Users/someone/.claude/skills/crawl/references\n');
    const dest = mkdtempSync(join(tmpdir(), 'pod-skills-home-'));
    stagePodSkills(['crawl'], dest, root, '/Users/someone');
    expect(readFileSync(join(dest, 'crawl', 'SKILL.md'), 'utf8')).toBe('cd ~/.claude/skills/crawl/references\n');
  });

  test('digest follows code changes, not key changes', () => {
    const root = skillsRoot();
    const before = podSkillsDigest(['crawl'], root).digest;
    writeFileSync(join(root, 'crawl', '.env'), 'TAVILY_KEY=rotated\n');
    expect(podSkillsDigest(['crawl'], root).digest).toBe(before);
    writeFileSync(join(root, 'crawl', 'src', 'main.ts'), 'export const x = 1;\n');
    expect(podSkillsDigest(['crawl'], root).digest).not.toBe(before);
    expect(podSkillsDigest([], root).digest).toBe('none');
  });

  test('keys are read only for skills that have a .env', () => {
    const root = skillsRoot();
    mkdirSync(join(root, 'nokeys'));
    expect(readSkillEnvFiles(['crawl', 'nokeys'], root)).toEqual({ crawl: 'TAVILY_KEY=secret-value-1\n' });
  });

  test('manifest installs each skill .env from the run secret at 0600', () => {
    const job = JSON.stringify(podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60, skillEnvs: ['crawl'] }));
    expect(job).toContain('install -m 600 /creds/skillenv-$n ~/.claude/skills/$n/.env');
    expect(JSON.stringify(podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }))).not.toContain('skillenv');
  });

  test('opt-in: the secret carries the keys, the log carries only the skill names', async () => {
    const applied: string[] = [];
    const kubectl: Kubectl = (args, input) => {
      if (input) applied.push(input);
      if (args.includes('current-context')) return { status: 0, stdout: 'k3d-elanous-h1\n', stderr: '' };   // 컨텍스트 확인(Pod Job 이 어느 클러스터로 가나)
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const logs: string[] = [];
    const spy = spyOn(debug, 'log').mockImplementation((_c, event, data) => { logs.push(`${event} ${JSON.stringify(data)}`); });
    try {
      const run = (skillEnv: boolean) => podSelfImplementSpawn({
        kubectl, pollMs: 1, imageCommit: null, sleep: async () => {}, skillEnv,
        readSkillEnv: () => ({ crawl: 'TAVILY_KEY=secret-value-1\n' }),
        credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 't' }),
      })({ spaceId: 's', feature: 'f' } as Parameters<ReturnType<typeof podSelfImplementSpawn>>[0]).done;
      await run(true);
      expect(applied.find((a) => a.includes('"kind":"Secret"'))).toContain('secret-value-1');
      expect(logs.some((l) => l.startsWith('skill-env') && l.includes('"crawl"'))).toBe(true);
      expect(logs.some((l) => l.includes('secret-value-1'))).toBe(false);
      applied.length = 0;
      await run(false);
      expect(applied.join('')).not.toContain('secret-value-1');
    } finally { spy.mockRestore(); }
  });

  test('a changed skill set makes the image stale even at the same commit', () => {
    const run = (cmd: string, args: readonly string[]) => {
      if (cmd === 'git') return { status: 0, stdout: 'abc\n' };
      if (args.includes('{{index .Config.Labels "elanous.pod-skills"}}')) return { status: 0, stdout: 'old\n' };
      return { status: 0, stdout: 'abc\n' };
    };
    expect(podImageFreshness({ run, skillsDigest: () => 'new' })).toMatchObject({ fresh: false });
    expect(podImageFreshness({ run, skillsDigest: () => 'old' })).toMatchObject({ fresh: true });
    expect(podImageFreshness({ run })).toMatchObject({ fresh: true });   // 주입 시험은 스킬을 안 잰다
  });
});

// 🔐 2026-09-27: 개인 데이터·상태(data/ · .elanous/ · DB 파일)는 이미지로 가지 않는다 — 코드와 참조 자료만.
test('podSkillFiles leaves out personal data dirs and database files but keeps code and references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-pod-skill-'));
  try {
    for (const d of ['data/prep', '.elanous/debug', 'references', 'scripts']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '#');
    writeFileSync(join(dir, 'scripts', 'run.sh'), 'echo');
    writeFileSync(join(dir, 'references', 'ref.md'), 'r');
    writeFileSync(join(dir, 'data', 'yt-vault.db'), 'x');
    writeFileSync(join(dir, 'data', 'prep', 'a.json'), '{}');
    writeFileSync(join(dir, '.elanous', 'debug', 'x.jsonl'), '{}');
    writeFileSync(join(dir, 'cache.sqlite3'), 'x');
    expect(podSkillFiles(dir)).toEqual(['SKILL.md', 'references/ref.md', 'scripts/run.sh']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
