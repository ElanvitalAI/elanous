import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

// ⛔⭐⭐⭐ 이 파일이 있는 이유 — ***「0개 검사」를 «통과»라 말하면 안 된다.***
//   근거(2026-08-04 `[S]` 실측 · `MEAS-S42`): `self typecheck` 는 커밋되지 «않은» 변경만 본다
//   (`git diff HEAD` ⊕ untracked). 커밋 «뒤»에 돌리면 볼 것이 없는데 종전 문면은
//   `✅ … 통과 (0개 파일 검사)` 였고, 그것을 착지 판정으로 읽으면 ***한 번도 안 잰 변경을
//   「통과」로 착각한다***(상대 세션이 두 번 속을 뻔했다).
//   ⇒ `harness clean` 이 `#6984` 에서 닫은 「0건과 «안 봤다»를 가른다」와 같은 병이다.
const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

describe('elanous self typecheck — 「0개 검사」는 «통과»가 아니다', () => {
  test('검사 대상이 0개면 «안 쟀다»라고 말하고 그 이유와 잴 수 있는 길을 준다', () => {
    const root = mkdtempSync(join(tmpdir(), 'self-typecheck-zero-'));
    try {
      git(root, 'init', '-q', '-b', 'main');
      git(root, 'config', 'user.email', 'test@example.com');
      git(root, 'config', 'user.name', 'Test');
      writeFileSync(join(root, 'README.md'), 'initial\n');
      git(root, 'add', '.');
      git(root, 'commit', '-qm', 'initial');
      // ⭐ 전제를 먼저 못 박는다 — 실제로 «변경 0» 인지 확인하지 않으면 이 테스트가 조용히 무의미해진다.
      expect(spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout).toBe('');

      const r = spawnSync(process.execPath, [join(sourceRoot, 'bin/elanous.mjs'), 'self', 'typecheck'], {
        cwd: root, encoding: 'utf8', timeout: 120_000,
      });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

      // ⛔ 핵심 — 「통과」라고 말하지 «않는다».
      expect(out).not.toContain('타입 검사 통과');
      // ✅ 그리고 「안 쟀다」와 «왜»와 «길»을 준다 — 셋을 다 물어야 문면만 바꾼 회피를 막는다.
      expect(out).toContain('안 쟀다');
      expect(out).toContain('커밋되지');
      expect(out).toContain('TSC_BASE_REF');
      // ⚠️ 종료 코드는 «0» 을 유지한다 — 이 명령을 부르는 자동 경로가 「변경 없음」에서 깨지면 안 된다.
      expect(`status=${r.status}`).toBe('status=0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
