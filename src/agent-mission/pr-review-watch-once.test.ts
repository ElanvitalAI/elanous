import { describe, expect, test } from 'bun:test';
import { withFakeBins } from '../ux-sim/fake-bin.js';
import { simInProcessCli } from '../ux-sim/in-process-cli.js';

// 장치 두 개로 돈다(TEST-AUDIT-1105): gh 는 PATH 가짜(fake-bin) · CLI 는 같은 프로세스의 등록된 Commander 트리(in-process-cli).
// 예전엔 `bun bin/elanous.mjs` 를 세 번 띄웠다 — 판정(목록 실패 분류·빈 목록 정상 종료)은 그대로, 부팅 세 번만 뺐다.
const reviewWatchOnce = () => simInProcessCli(
  ['agent-mission', 'review-watch', '--once', '--dry-run'],
  { allowPaths: [['agent-mission', 'review-watch']] },
);

describe('agent-mission review-watch --once', () => {
  test('목록 조회 실패는 안내를 출력하고 scanned 없이 비정상 종료한다; 진짜 빈 목록은 정상 종료한다', async () => {
    const failed = await withFakeBins({ gh: { stderr: 'HTTP 401: Bad credentials\n', exitCode: 1 } }, reviewWatchOnce);
    const failedOut = failed.stdout + failed.stderr;
    expect(failed.exitCode).toBe(1);
    expect(failedOut).toContain('목록 조회 실패 (auth): gh auth login');
    expect(failedOut).not.toContain('scanned=');

    const missing = await withFakeBins({ gh: { stderr: 'HTTP 404: Not Found\n', exitCode: 1 } }, reviewWatchOnce);
    const missingOut = missing.stdout + missing.stderr;
    expect(missing.exitCode).toBe(1);
    expect(missingOut).toContain('목록 조회 실패 (not-found): gh repo view');
    expect(missingOut).not.toContain('scanned=');

    const empty = await withFakeBins({ gh: { stdout: '[]\n' } }, reviewWatchOnce);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toContain('scanned=0 triggered=0');
  }, 60_000);
});
