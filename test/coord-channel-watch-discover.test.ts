// coord-channel-watch `discover`/`adopt` — 「폴 자식」과 「감시자 본체」를 가른다.
//
// ⛔ 왜 이 파일이 있나 (2026-08-17 · `[T]` 99차 실측):
//    `status --track T` 가 이렇게 말했다:
//      ⚠️ 등록 안 된 #8328 감시자가 argv 에 보인다 — 중복의 씨앗이다:
//        pid=61304  gh api --paginate repos/user…
//    🚨 그런데 그 pid 는 감시자가 «아니라» ***등록된 감시자 자신이 매 주기 띄우는 조회 자식***이었다
//       (argv 의 jq 필터가 「[T] 접두 제외」 = 바로 그 감시자의 질의였다).
//    ⇒ `discover_untracked` 가 제외하는 것이 holder pid 와 `$$` «둘뿐»이고 holder 의 «자손»을 안 뺐다.
//
// 🚨 그리고 이 거짓 양성은 «조용한 오보»가 아니다 — 시키는 처방이 진짜 중복을 «만든다»:
//    안내대로 `adopt --pid <그 pid>` 를 치면 몇 초 뒤 죽을 pid 가 PIDFILE 에 박히고 →
//    holder_pid 가 「없음」이 되고 → 다음 `ensure` 가 둘째 감시자를 띄운다.
//    ***중복을 막는 장치가 중복의 원인이 되는 경로.***
//
// ⭐ 네트워크를 «안» 탄다 — 가짜 감시자(argv 만 감시자 모양) ⊕ 가짜 조회 자식(`exec -a`)으로
//    프로세스 «모양»만 세운다. GitHub 도 잠금도 안 건드린다(TMPDIR 격리).
import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const SCRIPT = 'scripts/coord-channel-watch.sh';
// ⛔ 실물 채널(#8328)과 «다른» 번호 — 이 테스트가 사람의 감시자를 보거나 건드리면 안 된다.
// ⛔⭐ 그리고 시험마다 «다른» 번호를 쓴다 — 1차 판은 번호를 공유해서 앞 시험이 남긴
//    «고아 조회 자식»(부모를 kill -9 하면 자식은 launchd 로 재부모화된다)을 다음 시험이 집었고,
//    그 고아는 조상에 감시자가 «없어» 초록이어야 할 단언이 빨강으로 보였다.
//    📌 즉 이 테스트 자신이 「그럴듯한 오탐」을 한 번 만들었다 — 대상과 같은 병이다.
let prSeq = 909900;
const nextPr = (): string => String((prSeq += 1));

const running: Array<{ kill: () => void }> = [];
const dirs: string[] = [];

afterEach(() => {
  while (running.length) running.pop()!.kill();
  while (dirs.length) {
    const d = dirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

/**
 * 가짜 감시자를 띄운다 — argv 가 «감시자 모양»(스크립트 이름)이고, 자식으로
 * 「조회 프로세스 모양」(`gh api … issues/<PR>/comments`)을 하나 띄운다.
 * ⇒ 실물과 같은 부모-자식 쌍을 «주기 기다림 없이» 세운다.
 */
function fakeWatcher(dir: string): { watcherPid: number; pollPid: number; pr: string } {
  const pr = nextPr();
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, 'coord-channel-watch.sh');
  writeFileSync(
    path,
    `#!/usr/bin/env bash\n( exec -a "gh api --paginate repos/o/r/issues/${pr}/comments --jq .x" sleep 120 ) &\nwait\n`,
    { mode: 0o755 },
  );
  const proc = Bun.spawn(['bash', path], { stdout: 'ignore', stderr: 'ignore' });
  const pollPid = waitForPollPid(pr);
  // ⛔ 부모만 죽이면 자식이 «고아로 산다» — 이 테스트가 1차에 그것으로 스스로 오탐했다.
  running.push({
    kill: () => {
      if (pollPid > 0) { try { process.kill(pollPid, 'SIGKILL'); } catch { /* 이미 죽음 */ } }
      try { proc.kill(9); } catch { /* noop */ }
    },
  });
  return { watcherPid: proc.pid, pollPid, pr };
}

/**
 * 조회 자식이 «실제로 떴는지»를 ps 로 확인한다 — 뜨기 «전»에 단언하면 초록이 거짓이 된다.
 * ⛔ 못 찾으면 0 을 낸다(테스트가 그것을 잡는다) — 없는 것을 있는 척 넘기지 않는다.
 */
function waitForPollPid(pr: string): number {
  for (let i = 0; i < 60; i += 1) {
    const r = spawnSync(
      'bash',
      ['-c', `ps -eo pid=,command= | grep "issues/${pr}/comments" | grep -v grep | awk '{print $1}' | head -1`],
      { encoding: 'utf8' },
    );
    const pid = Number((r.stdout ?? '').trim());
    if (pid > 0) return pid;
    spawnSync('sleep', ['0.1']);
  }
  return 0;
}

function run(args: string[], dir: string, pr: string): { out: string; code: number } {
  const r = spawnSync('bash', [SCRIPT, ...args, '--track', 'TT'], {
    encoding: 'utf8',
    env: { ...process.env, CH_PR: pr, TMPDIR: dir },
  });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), code: r.status ?? -1 };
}

describe('coord-channel-watch — 조회 자식을 «감시자»로 세지 않는다', () => {
  test('🚨 회귀: 등록된 감시자의 «조회 자식»은 미등록 감시자로 안 뜬다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coord-discover-'));
    dirs.push(dir);
    const { watcherPid, pollPid, pr } = fakeWatcher(dir);
    expect(pollPid).toBeGreaterThan(0);

    // 감시자 «본체»를 잠금에 등록한다 — 이제 그 자손은 전부 「내 것」이다.
    const adopted = run(['adopt', '--pid', String(watcherPid)], dir, pr);
    expect(adopted.code).toBe(0);

    const found = run(['discover'], dir, pr);
    // ⛔ 「없다」가 아니라 「argv 에 안 잡힘」 문면이어야 한다 — 그 둘을 이 스크립트는 구분해 말한다.
    expect(found.out).toContain('argv 에 안 잡힘');
    expect(found.out).not.toContain(String(pollPid));
  });

  test('미등록 감시자는 «여전히» 뜬다 — 그리고 조회 pid 가 아니라 «본체» pid 로 뜬다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coord-discover-'));
    dirs.push(dir);
    const { watcherPid, pollPid, pr } = fakeWatcher(dir);

    const found = run(['discover'], dir, pr); // 등록 «안» 했다
    expect(found.out).toContain('감시자 본체');
    // ⭐ 행의 «주어»가 본체 pid 여야 한다 — 조회 pid 는 근거로 «뒤에» 붙는 것은 좋다(추적용).
    //   ⛔ 주어가 조회 pid 면 adopt 가 「곧 죽을 pid」를 등록하게 되고, 그것이 이 수리의 표적이다.
    expect(found.out).toMatch(new RegExp(`^\\s*pid=${watcherPid}\\s`, 'm'));
    expect(found.out).not.toMatch(new RegExp(`^\\s*pid=${pollPid}\\s`, 'm'));
  });

  test('🚨 adopt 는 «조회 자식»을 거부하고 본체 pid 를 가리킨다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coord-discover-'));
    dirs.push(dir);
    const { watcherPid, pollPid, pr } = fakeWatcher(dir);

    const r = run(['adopt', '--pid', String(pollPid)], dir, pr);
    expect(r.code).toBe(1);
    expect(r.out).toContain('감시자가 아니다');
    expect(r.out).toContain(String(watcherPid)); // ⇒ 「대신 이것을 줘라」
  });

  test('adopt 는 감시자와 무관한 pid 도 거부한다 (살아 있다는 것만으론 부족)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coord-discover-'));
    dirs.push(dir);
    const proc = Bun.spawn(['sleep', '120'], { stdout: 'ignore', stderr: 'ignore' });
    running.push({ kill: () => { try { proc.kill(9); } catch { /* noop */ } } });

    const r = run(['adopt', '--pid', String(proc.pid)], dir, nextPr());
    expect(r.code).toBe(1);
    expect(r.out).toContain('감시자가 아니다');
    expect(r.out).toContain('ensure');
  });
});
