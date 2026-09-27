import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPrerelease, isReleaseVersion, planPublish, publishRelease, verifyChecksums, verifyRelease, releaseNotesPageUrl, type ReleaseManifest, type Runner } from './release-cli.js';

function fixture() {
  const out = mkdtempSync(join(tmpdir(), 'release-cli-'));
  const dist = join(out, 'dist');
  mkdirSync(dist);
  const files = ['elanous.tgz', 'install.sh', 'install.ps1'].map((name) => {
    const body = `content of ${name}`;
    writeFileSync(join(dist, name), body);
    return { name, sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length };
  });
  writeFileSync(join(dist, 'SHA256SUMS'), files.map((f) => `${f.sha256}  ${f.name}`).join('\n') + '\n');
  const manifest: ReleaseManifest = {
    version: '0.1.1', tag: 'v0.1.1', prerelease: false, publicRepo: 'ElanvitalAI/elanous', sourceRef: 'origin/main',
    sourceCommit: 'a'.repeat(40), publicCommit: 'b'.repeat(40), publicDir: join(out, 'public'), distDir: dist,
    // files = release-build 가 내는 그대로 — SHA256SUMS 는 «목록에 없다»
    files, webUi: true, e2e: { ran: true, ok: true, versionLine: `0.1.1 ${'b'.repeat(40)}` },
    preparedAt: '2026-09-25T00:00:00Z',
  };
  writeFileSync(join(out, 'release.json'), JSON.stringify(manifest));
  const notes = join(out, 'notes.md');
  writeFileSync(notes, 'notes');
  return { out, dist, manifest, notes };
}

describe('release — 버전·자산', () => {
  test('버전 모양: x.y.z 와 -rc/-alpha/-beta.N 만 · 접두 v 는 아니다', () => {
    expect(['0.1.0', '0.2.0-rc.1', '1.0.0-beta.2'].every(isReleaseVersion)).toBe(true);
    expect(['v0.1.0', '0.1', '0.1.0-dev', ''].some(isReleaseVersion)).toBe(false);
    expect(isPrerelease('0.2.0-rc.1')).toBe(true);
    expect(isPrerelease('0.2.0')).toBe(false);
  });

  test('체크섬 재대조가 바뀐 파일의 «이름»을 댄다', () => {
    const f = fixture();
    try {
      expect(verifyChecksums(f.dist)).toEqual([]);
      writeFileSync(join(f.dist, 'install.sh'), 'tampered');
      expect(verifyChecksums(f.dist)).toEqual(['install.sh']);
    } finally { rmSync(f.out, { recursive: true, force: true }); }
  });
});

describe('release publish — 되돌릴 수 없으니 기본은 «보기만»', () => {
  test('계획: 공개 커밋 푸시 → 태그 릴리스(자산 전부 · 공개 커밋을 target · prerelease 면 표시)', () => {
    const f = fixture();
    try {
      const steps = planPublish(f.manifest, f.notes);
      expect(steps.map((s) => s.command)).toEqual(['git', 'gh']);
      expect(steps[0]!.args).toEqual(['push', 'origin', 'HEAD:main']);
      expect(steps[1]!.args).toContain('--target');
      expect(steps[1]!.args[steps[1]!.args.indexOf('--target') + 1]).toBe('b'.repeat(40));
      expect(steps[1]!.args).not.toContain('--prerelease');
      expect(planPublish({ ...f.manifest, prerelease: true }, f.notes)[1]!.args).toContain('--prerelease');
      // ⛔ 설치기가 읽는 SHA256SUMS 를 반드시 올린다(release-build 의 files 에는 없다)
      expect(steps[1]!.args).toContain(join(f.dist, 'SHA256SUMS'));
      expect(steps[1]!.args.filter((a) => a.startsWith(f.dist))).toHaveLength(4);
    } finally { rmSync(f.out, { recursive: true, force: true }); }
  });

  test('--yes 없으면 아무것도 실행하지 않는다 · 이미 있는 태그는 거부 · 자산이 바뀌었으면 거부', async () => {
    const f = fixture();
    const calls: string[] = [];
    const noRelease: Runner = (c, a) => { calls.push(`${c} ${a[0]} ${a[1]}`); return { status: c === 'gh' && a[1] === 'view' ? 1 : 0, stdout: '', stderr: '' }; };
    try {
      const dry = await publishRelease({ dir: f.out, notesFile: f.notes, log: () => {} }, noRelease);
      expect(dry.published).toBe(false);
      expect(calls).toEqual(['gh release view']);
      const exists: Runner = () => ({ status: 0, stdout: '', stderr: '' });
      await expect(publishRelease({ dir: f.out, notesFile: f.notes, yes: true, log: () => {} }, exists)).rejects.toThrow('이미 있는 릴리스');
      writeFileSync(join(f.dist, 'elanous.tgz'), 'changed');
      await expect(publishRelease({ dir: f.out, notesFile: f.notes, yes: true, log: () => {} }, noRelease)).rejects.toThrow('elanous.tgz');
    } finally { rmSync(f.out, { recursive: true, force: true }); }
  });

  test('--yes 면 푸시 → 릴리스 순서로 실행한다', async () => {
    const f = fixture();
    const calls: string[] = [];
    const run: Runner = (c, a) => { calls.push(`${c} ${a[0]} ${a[1]}`); return { status: c === 'gh' && a[1] === 'view' ? 1 : 0, stdout: '', stderr: '' }; };
    try {
      const r = await publishRelease({ dir: f.out, notesFile: f.notes, yes: true, log: () => {} }, run);
      expect(r.published).toBe(true);
      expect(calls).toEqual(['gh release view', 'git push origin', 'gh release create']);
    } finally { rmSync(f.out, { recursive: true, force: true }); }
  });
});

// 상태 왕복 가짜 — memory add 로 받은 nonce 를 search 가 돌려주고, logs 는 «지금» 쓰인 행을 낸다.
let lastNonce = '';
function stateOk(a: readonly string[]): { status: number; stdout: string; stderr: string } {
  if (a[0] === 'memory' && a[1] === 'add') { lastNonce = String(a[3]).replace('release-verify-', ''); return { status: 0, stdout: 'saved', stderr: '' }; }
  if (a[0] === 'memory' && a[1] === 'search') return { status: 0, stdout: `match release-verify-${lastNonce}`, stderr: '' };
  if (a[0] === 'logs') return { status: 0, stdout: `{"_meta":{}}\n{"id":2,"ts_ms":${Date.now()}}\n`, stderr: '' };
  return { status: 0, stdout: '', stderr: '' };
}

// 노트 페이지 확인 curl(-w %{http_code}) 가짜 — 기본 200.
const notesCurl = (a: readonly string[], code = '200') => (a.includes('-w') ? { status: 0, stdout: code, stderr: '' } : null);

describe('release verify — 공개 주소로 끝까지', () => {
  test('고정 버전이면 download/v<버전> 설치기를 받고, --version 이 그 버전으로 시작해야 ok', async () => {
    const urls: string[] = [];
    const run: Runner = (c, a) => {
      if (c === 'curl') { const n = notesCurl(a); if (n) return n; urls.push(String(a[1])); return { status: 0, stdout: 'echo installer', stderr: '' }; }
      if (a[0] === '--version') return { status: 0, stdout: '0.1.1 cafe\n', stderr: '' };
      return stateOk(a);
    };
    const r = await verifyRelease({ version: '0.1.1', log: () => {} }, run);
    expect(urls).toEqual(['https://github.com/ElanvitalAI/elanous/releases/download/v0.1.1/install.sh']);
    expect(r.ok).toBe(true);
    const wrong: Runner = (c, a) => (c === 'curl' && notesCurl(a) ? notesCurl(a)! : a[0] === '--version' ? { status: 0, stdout: '0.1.0 cafe', stderr: '' } : stateOk(a));
    expect((await verifyRelease({ version: '0.1.1', log: () => {} }, wrong)).ok).toBe(false);
  });

  test('검증 환경은 물려받은 ELANOUS_*·XDG_* 를 걷는다 — 상태 왕복이 운영 저장소에 쓰지 않게', async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const saved = { s: process.env.ELANOUS_STATE_DIR, x: process.env.XDG_DATA_HOME };
    process.env.ELANOUS_STATE_DIR = '/real/state'; process.env.XDG_DATA_HOME = '/real/xdg';
    try {
      const run: Runner = (c, a, cwd, o) => { if (o?.env) seen.push(o.env); return c === 'curl' ? (notesCurl(a) ?? { status: 0, stdout: 'x', stderr: '' }) : a[0] === '--version' ? { status: 0, stdout: '0.1.1 c', stderr: '' } : stateOk(a); };
      await verifyRelease({ version: '0.1.1', log: () => {} }, run);
    } finally {
      if (saved.s === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = saved.s;
      if (saved.x === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = saved.x;
    }
    expect(seen.length).toBeGreaterThan(3);
    for (const env of seen) { expect(env.ELANOUS_STATE_DIR).toBeUndefined(); expect(env.XDG_DATA_HOME).toBeUndefined(); expect(env.HOME).toContain('elanous-release-verify-'); }
  });

  test('--version 이 맞아도 상태 왕복(기억 · 로그)이 안 되면 ok 가 아니다', async () => {
    const base: Runner = (c, a) => (c === 'curl' ? (notesCurl(a) ?? { status: 0, stdout: 'echo installer', stderr: '' }) : a[0] === '--version' ? { status: 0, stdout: '0.1.1 cafe\n', stderr: '' } : stateOk(a));
    const noMemory: Runner = (c, a, cwd, o) => (a[0] === 'memory' && a[1] === 'search' ? { status: 0, stdout: 'no matches', stderr: '' } : base(c, a, cwd, o));
    const oldLogs: Runner = (c, a, cwd, o) => (a[0] === 'logs' ? { status: 0, stdout: '{"id":1,"ts_ms":1}\n', stderr: '' } : base(c, a, cwd, o));
    expect((await verifyRelease({ version: '0.1.1', log: () => {} }, base)).ok).toBe(true);
    expect((await verifyRelease({ version: '0.1.1', log: () => {} }, noMemory)).ok).toBe(false);
    expect((await verifyRelease({ version: '0.1.1', log: () => {} }, oldLogs)).ok).toBe(false);
    // 빈 HOME — 데몬이 한 번도 안 떠 로그 스토어가 없다(📏 09-25 이 맥 실측). 실패도 통과도 아니고 «안 쟀다»고 말한다.
    const lines: string[] = [];
    const noStore: Runner = (c, a, cwd, o) => (a[0] === 'logs' ? { status: 1, stdout: '', stderr: 'elanous logs: 열 수 있는 로그 스토어 없음 — scope={"registeredStores":0,"unopenedStores":0}' } : base(c, a, cwd, o));
    expect((await verifyRelease({ version: '0.1.1', log: (l) => lines.push(l) }, noStore)).ok).toBe(true);
    expect(lines.join('\n')).toContain('로그 왕복 안 잼');
  });
});

import { planYank, yankRelease, type ReleaseInfo } from './release-cli.js';
describe('release yank — 내리기(지우지 않음 · 되돌릴 수 있음)', () => {
  const rel: ReleaseInfo[] = [
    { tagName: 'v0.1.1', isPrerelease: false, isDraft: false, isLatest: true, publishedAt: '2026-09-25T21:05:00Z' },
    { tagName: 'v0.1.0', isPrerelease: false, isDraft: false, isLatest: false, publishedAt: '2026-09-25T11:30:00Z' },
    { tagName: 'v0.2.0-rc.1', isPrerelease: true, isDraft: false, isLatest: false, publishedAt: '2026-09-26T00:00:00Z' },
  ];
  test('내리기 = 대상 강등 ⊕ 직전 «정식» 판(미리보기 제외)을 Latest 로', () => {
    const steps = planYank(rel, 'v0.1.1', 'o/r');
    expect(steps.map((s) => s.args.slice(0, 3).join(' '))).toEqual(['release edit v0.1.1', 'release edit v0.1.0']);
    expect(steps[0]!.args).toContain('--prerelease');
    expect(steps[0]!.args).toContain('--latest=false');
    expect(steps[1]!.args).toContain('--latest');
  });
  test('정식 판이 하나뿐이면 내리지 않는다(Latest 가 비면 한 줄 설치가 전부 실패) · 없는 판·이미 강등된 판은 이름을 댄다', () => {
    expect(() => planYank([rel[0]!], 'v0.1.1', 'o/r')).toThrow('정식 판이 없다');
    expect(() => planYank(rel, 'v9.9.9', 'o/r')).toThrow('없는 릴리스');
    expect(() => planYank(rel, 'v0.2.0-rc.1', 'o/r')).toThrow('이미 pre-release');
  });
  test('--undo = 정식 판 ⊕ Latest ⊕ 제목 원래대로', () => {
    const [s] = planYank(rel, 'v0.1.1', 'o/r', true);
    expect(s!.args).toEqual(['release', 'edit', 'v0.1.1', '--repo', 'o/r', '--prerelease=false', '--latest', '--title', 'elanous v0.1.1']);
  });
  test('--yes 없으면 바꾸지 않는다 · --yes 면 실행 뒤 latest 설치기가 가리키는 판을 잰다', async () => {
    const calls: string[] = [];
    const run: Runner = (c, a) => {
      calls.push(`${c} ${a.slice(0, 3).join(' ')}`);
      if (c === 'gh' && a[1] === 'list') return { status: 0, stdout: JSON.stringify(rel), stderr: '' };
      if (c === 'curl') return { status: 0, stdout: 'HTTP/2 302\nlocation: https://github.com/o/r/releases/download/v0.1.0/install.sh\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    expect((await yankRelease({ version: '0.1.1', publicRepo: 'o/r', log: () => {} }, run)).applied).toBe(false);
    expect(calls.filter((c) => c.startsWith('gh release edit'))).toHaveLength(0);
    const r = await yankRelease({ version: '0.1.1', publicRepo: 'o/r', yes: true, log: () => {}, sleep: async () => {} }, run);
    expect(r).toMatchObject({ applied: true, latestNow: 'v0.1.0', propagated: true, waitedMs: 0 });
    expect(calls.filter((c) => c.startsWith('gh release edit'))).toHaveLength(2);
  });
});

describe('release yank — 설치기 리다이렉트 반영을 기다린다(📏 CDN 약 100~120초)', () => {
  const rel: ReleaseInfo[] = [
    { tagName: 'v0.1.1', isPrerelease: false, isDraft: false, isLatest: true, publishedAt: '2026-09-25T21:05:00Z' },
    { tagName: 'v0.1.0', isPrerelease: false, isDraft: false, isLatest: false, publishedAt: '2026-09-25T11:30:00Z' },
  ];
  const runWith = (redirects: string[]): Runner => (c, a) => {
    if (c === 'gh' && a[1] === 'list') return { status: 0, stdout: JSON.stringify(rel), stderr: '' };
    if (c === 'curl') return { status: 0, stdout: `location: https://github.com/o/r/releases/download/${redirects.shift() ?? 'v0.1.1'}/install.sh`, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  test('옛 판을 주는 동안 기다렸다가, 바뀌면 걸린 시간과 함께 반영됐다고 말한다', async () => {
    const r = await yankRelease({ version: '0.1.1', publicRepo: 'o/r', yes: true, log: () => {}, sleep: async () => {}, pollMs: 10_000 }, runWith(['v0.1.1', 'v0.1.1', 'v0.1.0']));
    expect(r).toMatchObject({ propagated: true, latestNow: 'v0.1.0', waitedMs: 20_000 });
  });
  test('끝내 안 바뀌면 ✅ 가 아니다 — propagated false · rc 2', async () => {
    const lines: string[] = [];
    const before = process.exitCode;
    const r = await yankRelease({ version: '0.1.1', publicRepo: 'o/r', yes: true, log: (l) => lines.push(l), sleep: async () => {}, pollMs: 10_000, timeoutMs: 30_000 }, runWith([]));
    expect(r.propagated).toBe(false);
    expect(lines.join('\n')).toContain('아직 v0.1.1 을 준다');
    expect(process.exitCode).toBe(2);
    process.exitCode = before;
  });
});

describe('release --json — stdout 은 결과 한 줄(T-R 그래프 간선용)', () => {
  test('yank --json 보기만: stdout 이 JSON 한 줄 · ok true · applied false', () => {
    const r = Bun.spawnSync(['bun', 'bin/elanous.mjs', 'release', 'yank', '--version', '9.9.9', '--json', '--public-repo', 'nobody-xyz/none'], { cwd: join(import.meta.dir, '..', '..'), stdout: 'pipe', stderr: 'pipe' });
    const lines = r.stdout.toString().trim().split('\n');
    expect(lines).toHaveLength(1);
    const d = JSON.parse(lines[0]!);
    expect(d.ok).toBe(false);   // 없는 저장소 → 오류도 JSON 한 줄
    expect(typeof d.error).toBe('string');
    expect(r.exitCode).toBe(1);
  }, 60_000);
});

describe('release verify — 노트 페이지가 문서 사이트에 있나(🅕 09-27 · 0.2.2 노트 누락)', () => {
  test('정식 판은 docs 노트 페이지가 200 이어야 ok · 없으면 경로를 말한다 · 선행 판은 안 잰다', async () => {
    const pages: string[] = [];
    const mk = (code: string): Runner => (c, a) => {
      if (c === 'curl' && a.includes('-w')) { pages.push(String(a[a.length - 1])); return { status: 0, stdout: code, stderr: '' }; }
      if (c === 'curl') return { status: 0, stdout: 'echo installer', stderr: '' };
      return a[0] === '--version' ? { status: 0, stdout: '0.2.2 cafe\n', stderr: '' } : stateOk(a);
    };
    const ok = await verifyRelease({ version: '0.2.2', log: () => {} }, mk('200'));
    expect(ok.ok).toBe(true);
    expect(ok.notesPage).toBe('ok');
    expect(pages).toEqual(['https://docs.elanous.ai/releases/0-2-2/']);
    const lines: string[] = [];
    const missing = await verifyRelease({ version: '0.2.2', log: (l) => lines.push(l) }, mk('404'));
    expect(missing.ok).toBe(false);
    expect(missing.notesPage).toBe('missing');
    expect(lines.join('\n')).toContain('release/public/docs/releases/0.2.2.md');
    expect(releaseNotesPageUrl('0.3.0-rc.1')).toBeNull();
  });
});
