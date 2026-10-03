// ch5730-watch.sh `delivery` — 「살아있음」과 「배달된다」는 «다른 층»이다.
//
// ⛔ 왜 이 파일이 있나 (2026-08-08 · `[S]` 57차 실측 → `[T]` 60차 착지):
//    `[S]` 가 조율 감시자를 `nohup … > <파일> 2>&1 &` 로 걸었더니
//      ✅ ps 살아 있음 · ✅ status "감시 살아있음"  ⇒ 🚨 배달은 «0»
//    stdout 이 «파일»로 갔기 때문이다. ***모든 자가 초록인데 아무것도 안 온다.***
//    ⇒ 이 테스트는 그 판정기가 «각 대상을 다른 값으로» 내는지를 전수로 문다.
//
// ⭐ 네트워크를 «안» 탄다 — `delivery` 하위 명령이 잠금·PID 파일·GitHub 를 무접촉이고
//    임의 pid 의 fd 1 만 본다. 그래서 이 파일이 결정론 게이트에서 돈다.
import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const SCRIPT = 'scripts/ch5730-watch.sh';
const children: Array<{ kill: () => void }> = [];
const dirs: string[] = [];

afterEach(() => {
  while (children.length) children.pop()!.kill();
  while (dirs.length) {
    const d = dirs.pop()!;
    try { chmodSync(d, 0o700); } catch { /* 이미 지워졌거나 권한 없음 */ }
    try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

/**
 * stdout 을 지정한 곳으로 «고정»한 자식을 띄우고 그 pid 를 준다. `cat` 은 stdin 이 열려 있으면 산다.
 * ⭐ `argvAs` 를 주면 argv 만 «감시자 모양»으로 바꾼다(`exec -a`) — 2026-08-17 에 `adopt` 가
 *   「살아 있나」에 더해 「감시자인가」를 묻게 됐기 때문이다(조회 자식을 등록하면 곧 죽어
 *   holder 가 사라지고 다음 ensure 가 «둘째»를 띄운다 — 중복 방지 명령이 중복을 만드는 경로).
 */
function childWithStdout(redirect: string, argvAs?: string): number {
  const cmd = argvAs ? `exec -a ${JSON.stringify(argvAs)} cat ${redirect}` : `exec cat ${redirect}`;
  const proc = Bun.spawn(['bash', '-c', cmd], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
  children.push({ kill: () => { try { proc.kill(9); } catch { /* noop */ } } });
  return proc.pid;
}

function delivery(pid: string | number, env: Record<string, string> = {}): string {
  const r = spawnSync('bash', [SCRIPT, 'delivery', '--pid', String(pid), '--track', 'TT'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
}

describe('ch5730-watch delivery — 배달 목적지를 «다른 값»으로 낸다', () => {
  test('🚨 «파일» — [S] 가 밟은 그 상태. 살아 있어도 그 창엔 안 온다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ch5730-delivery-'));
    dirs.push(dir);
    const out = delivery(childWithStdout(`> ${join(dir, 'leak.log')}`));
    expect(out).toContain('🚨');
    expect(out).toContain('«파일»');
    expect(out).toContain('leak.log');
    // ⛔ 「정상」 문면이 «같이» 나오면 안 된다 — 그것이 이 결함의 형태였다.
    expect(out).not.toContain('✅');
  });

  test('🚨 /dev/null — 산출이 버려진다', () => {
    const out = delivery(childWithStdout('> /dev/null'));
    expect(out).toContain('🚨');
    expect(out).toContain('/dev/null');
    expect(out).not.toContain('✅');
  });

  test('✅ 스트리밍 — 호출자에게 간다(Monitor 안이 이 모양)', () => {
    // Bun.spawn 의 stdout:'pipe' 는 이 플랫폼에서 파이프/유닉스 소켓으로 잡힌다.
    const out = delivery(childWithStdout(''));
    expect(out).toContain('✅');
    expect(out).toContain('스트리밍');
  });

  test('⚠️ 비-tty 문자 장치는 「터미널」이 «아니다» — /dev/zero 를 정상으로 오판하지 않는다', () => {
    const out = delivery(childWithStdout('> /dev/zero'));
    expect(out).toContain('⚠️');
    expect(out).toContain('«모름»');
    expect(out).not.toContain('터미널');
  });

  test('⚠️ 죽은 pid — 「정상」이 아니라 «모름»', async () => {
    const proc = Bun.spawn(['bash', '-c', 'exec cat'], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
    const pid = proc.pid;
    proc.kill(9);
    // ⛔ 종료를 «기다린다» — kill 직후 조회하면 아직 살아 있는 것을 lsof 가 보고 테스트가 흔들린다
    //    (리뷰 should-fix ①). `kill` 의 반환은 「신호를 보냈다」이지 「죽었다」가 아니다 —
    //    이 스크립트의 kill_and_verify 가 이미 같은 교훈으로 서 있다.
    await proc.exited;
    const out = delivery(pid);
    expect(out).toContain('⚠️');
    expect(out).toContain('«못 쟀다»');
  });

  test('⚠️ pid 가 «수»가 아니면 재기 전에 «모름»으로 끝낸다', () => {
    const out = delivery('not-a-pid');
    expect(out).toContain('⚠️');
    expect(out).toContain('«못 쟀다»');
  });

  test('⚠️ lsof 가 «없으면» 「정상」이라 말하지 않는다', () => {
    // PATH 를 최소로 깎아 lsof 만 없앤다(스크립트가 delivery 경로에서 쓰는 것은 tr·sed·head).
    const bin = mkdtempSync(join(tmpdir(), 'ch5730-nolsof-'));
    dirs.push(bin);
    // ⚠️ `bash` 를 빼면 스크립트가 «뜨지도» 못하고 산출이 빈다 — 그러면 이 테스트는
    //    「lsof 없음을 옳게 말한다」가 아니라 「아무 말도 못 한다」를 통과시킨다(첫 판에 그랬다).
    for (const tool of ['bash', 'tr', 'sed', 'head', 'cat']) {
      const real = spawnSync('bash', ['-lc', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      if (real) symlinkSync(real, join(bin, tool));
    }
    const out = delivery(childWithStdout('> /dev/null'), { PATH: bin });
    expect(out).toContain('⚠️');
    expect(out).toContain('lsof');
    expect(out).not.toContain('✅');
  });
});

describe('ch5730-watch status — «성공» 분기가 배달 줄을 실제로 붙인다', () => {
  test('✅ 살아있음 + 📮 배달 줄이 «같이» 나온다 (adopt 로 임의 pid 를 소유로 등록)', () => {
    // ⭐ adopt 를 쓰면 «감시자를 안 띄우고» status 의 성공 분기를 탈 수 있다 ⇒ 네트워크 무접촉.
    const sandbox = mkdtempSync(join(tmpdir(), 'ch5730-status-'));
    dirs.push(sandbox);
    const dir = mkdtempSync(join(tmpdir(), 'ch5730-statuslog-'));
    dirs.push(dir);
    // ⛔ argv 를 «감시자 모양»으로 준다 — adopt 가 「감시자인가」를 묻기 때문(위 childWithStdout 머리말).
    const pid = childWithStdout(`> ${join(dir, 'leak.log')}`, 'bash scripts/coord-channel-watch.sh ensure --track QQ');
    const env = { ...process.env, TMPDIR: sandbox };
    const adopted = spawnSync('bash', [SCRIPT, 'adopt', '--pid', String(pid), '--track', 'QQ'], { encoding: 'utf8', env });
    expect(`${adopted.stdout}`).toContain('잠금에 등록');
    const r = spawnSync('bash', [SCRIPT, 'status', '--track', 'QQ'], { encoding: 'utf8', env });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out).toContain('감시 살아있음');
    // ⛔ 종전 결함의 형태: 「살아있음」만 있고 배달 줄이 «없었다».
    expect(out).toContain('📮 배달 →');
    expect(out).toContain('«파일»');
    expect(out).toContain('leak.log');
  });
});

describe('ch5730-watch ensure — 소유자를 «증명 못 하면» ✅ 라 말하지 않는다', () => {
  test('⚠️ 잠금은 남의 것인데 holder 를 증명 못 하는 상태에서 「이미 감시 중」이라 하지 않는다', () => {
    // 쓰기 불가 TMPDIR ⇒ mkdir(잠금) 이 항상 실패하고 PID 파일도 없다 ⇒ 소유자 증명 불가.
    const ro = mkdtempSync(join(tmpdir(), 'ch5730-ro-'));
    dirs.push(ro);
    mkdirSync(join(ro, 'inner'));
    const inner = join(ro, 'inner');
    chmodSync(inner, 0o500);
    const r = spawnSync('bash', [SCRIPT, 'ensure', '--track', 'XX'], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: inner, CH_INTERVAL: '3600' },
      timeout: 15_000,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out).toContain('⚠️');
    expect(out).toContain('«모름»');
    // ⛔ 종전 회귀: 빈 pid 로 `✅ … 이미 감시 중 · pid=` 를 냈다.
    expect(out).not.toContain('이미 감시 중');
    chmodSync(inner, 0o700);
  });
});
