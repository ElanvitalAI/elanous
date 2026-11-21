import { expect, test } from 'bun:test';
import { buildReplTools } from './index.js';
import { detachExplicitBackground, dispatchBash, hasBackgroundJob } from '../skills/tools/index.js';

test('Next turn abort stops a running Bash child and settles within five seconds', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => { started = resolve; });
  const tools = buildReplTools({
    getSignal: () => controller.signal,
    dispatchBash: (args, options) => {
      started();
      return dispatchBash(args, options);
    },
  });
  const pending = tools.dispatch('Bash', { command: 'sleep 20 & child=$!; echo "child_pid=$child"; wait "$child"' });
  await dispatched;
  await Bun.sleep(100);
  controller.abort(); // Next TUI Esc → confirmed stop reaches this turn signal.
  const result = await Promise.race([
    pending,
    Bun.sleep(5_000).then(() => { throw new Error('Bash child did not settle within five seconds'); }),
  ]) as { aborted?: boolean; stdout?: string };
  expect(result.aborted).toBe(true);
  const childPid = Number(result.stdout?.match(/child_pid=(\d+)/)?.[1]);
  expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
  expect(() => process.kill(childPid, 0)).toThrow();
}, 10_000);

test('ELN-BASH-BG-DETACH: an explicit background sleep survives the tool return', async () => {
  const result = await dispatchBash({ command: 'sleep 30 &' }, { cwd: process.cwd(), defaultTimeoutMs: 8_000 });
  expect(result.timedOut).toBe(false);
  expect(result.exitCode).toBe(0);
  await Bun.sleep(400);
  const ps = Bun.spawnSync(['ps', '-ax', '-o', 'pid=,command='], { stdout: 'pipe' });
  const hit = ps.stdout.toString().split('\n').find((line) => /^\s*\d+\s+sleep 30$/.test(line));
  expect(hit).toBeTruthy();
  process.kill(Number(hit!.trim().split(/\s+/)[0]), 'SIGKILL');
}, 10_000);

test('ELN-BASH-BG-DETACH r4: a separator, a newline, a pipeline, or an and-list keeps the original text', () => {
  expect(detachExplicitBackground('make &> build.log')).toBe('make &> build.log');
  // A leading foreground before `;` or a newline would stay behind while a fresh bash
  // runs the job without the shell's local variables and functions (JUD #120509): keep it whole.
  expect(detachExplicitBackground('npm install; npm start &')).toBe('npm install; npm start &');
  expect(detachExplicitBackground('echo ready\nsleep 30 &')).toBe('echo ready\nsleep 30 &');
  // Not one simple command: bash backgrounds the whole and-list or pipeline itself.
  expect(detachExplicitBackground('npm install && npm start &')).toBe('npm install && npm start &');
  expect(detachExplicitBackground('curl example.com | grep title &')).toBe('curl example.com | grep title &');
  // A comment owns the rest of the line: the `&` inside it is not a job at all.
  expect(detachExplicitBackground('echo hi # note &')).toBe('echo hi # note &');
});

test('ELN-BASH-BG-DETACH r4: one simple command detaches verbatim — nohup kept, quotes intact', () => {
  const quoted = detachExplicitBackground(`nohup bash -c 'cd app && npm start' > log 2>&1 &`);
  expect(quoted.startsWith('python3 -c')).toBe(true);
  expect(quoted).toContain(`'nohup bash -c '\\''cd app && npm start'\\'' > log 2>&1'`);
  expect(quoted).not.toContain('JSON');
  const dollars = detachExplicitBackground(`nohup sh -c 'echo $$ > pid' &`);
  expect(dollars).toContain(`'nohup sh -c '\\''echo $$ > pid'\\'''`);
  expect(dollars).not.toContain('"$');
  // nohup is part of the command, not noise to peel: stripping it would change the
  // command's own signal behavior (JUD #120509 mustFix).
  expect(detachExplicitBackground('nohup sleep 30 &')).toContain(`'nohup sleep 30'`);
  // A loop or a group is not a simple command.
  expect(detachExplicitBackground('while true; do x; sleep 5; done &')).toBe('while true; do x; sleep 5; done &');
  expect(detachExplicitBackground('( a; b ) &')).toBe('( a; b ) &');
});

test('ELN-BASH-BG-DETACH r4: a `;` in the command keeps the whole original text — no split, no peel', () => {
  expect(detachExplicitBackground('echo "go"; sleep 30 &')).toBe('echo "go"; sleep 30 &');
  // An unsafe shape — a compound behind a foreground, or an unbalanced quote — keeps the original text.
  expect(detachExplicitBackground('echo go; while true; do sleep 5; done &')).toBe('echo go; while true; do sleep 5; done &');
  expect(detachExplicitBackground('echo "unclosed; sleep 30 &')).toBe('echo "unclosed; sleep 30 &');
});

test('ELN-BASH-BG-DETACH r4: redirect scope stays inside the verbatim detached command', () => {
  const quotedTarget = detachExplicitBackground(`echo hi > 'my log' &`);
  expect(quotedTarget.startsWith('python3 -c')).toBe(true);
  expect(quotedTarget).toContain(`'echo hi > '\\''my log'\\''`);
  const stderrRedirect = detachExplicitBackground('npm start 2> err.log &');
  expect(stderrRedirect).toContain(`'npm start 2> err.log'`);
  // Here-documents and input redirects are not modeled: keep the original text.
  expect(detachExplicitBackground('cat <<EOF &')).toBe('cat <<EOF &');
  expect(detachExplicitBackground('sort < in.txt &')).toBe('sort < in.txt &');
});

test('ELN-BASH-BG-DETACH r4: a `;`-form runs verbatim and its foreground still prints', async () => {
  const result = await dispatchBash({ command: 'echo "go"; sleep 30 &' }, { cwd: process.cwd(), defaultTimeoutMs: 8_000 });
  expect(result.timedOut).toBe(false);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('go');
});

test('ELN-BASH-BG-DETACH r3: abort stops the leading foreground before the trailing job starts', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => { started = resolve; });
  const tools = buildReplTools({
    getSignal: () => controller.signal,
    dispatchBash: (args, options) => {
      started();
      return dispatchBash(args, options);
    },
  });
  // The leading foreground stays in the shell's process group, so abort
  // stops it — and bash dies before it reaches the trailing `&` job, so no
  // detached child leaks past the abort.
  const pending = tools.dispatch('Bash', { command: 'sleep 5; sleep 30 &' });
  await dispatched;
  await Bun.sleep(200);
  controller.abort();
  const result = await Promise.race([
    pending,
    Bun.sleep(5_000).then(() => { throw new Error('Bash child did not settle within five seconds'); }),
  ]) as { aborted?: boolean };
  expect(result.aborted).toBe(true);
  await Bun.sleep(300);
  const ps = Bun.spawnSync(['ps', '-ax', '-o', 'pid=,command='], { stdout: 'pipe' });
  const leaked = ps.stdout.toString().split('\n').filter((line) => /\bsleep 30\b/.test(line));
  expect(leaked).toHaveLength(0);
}, 10_000);

// ELN-BASH-BG-DETACH r6 — JUD hold-39412-0e006d8a9f88: heredoc 본문의 `&`는 데이터이지 잡이 아니다.
// 실제 잡 확인 시에만 정착·그룹 수거 경로에 들어가야 한다 — 리터럴과 실제 잡을 각각 검증한다.

test('ELN-BASH-BG-DETACH r6: heredoc 데이터의 `&`는 잡이 아니다(리터럴)', () => {
  expect(hasBackgroundJob("cat >f <<'EOF'\nwait & see\nEOF")).toBe(false);
  expect(hasBackgroundJob('cat <<-EOF\na & b\nEOF')).toBe(false);
  expect(hasBackgroundJob('cat <<"EOF"\n|x & y|\nEOF')).toBe(false);
  expect(hasBackgroundJob("tee <<'EOF'\nrun & done\nEOF\necho after")).toBe(false);
});

test('ELN-BASH-BG-DETACH r6: 실제 잡은 여전히 감지한다', () => {
  expect(hasBackgroundJob('sleep 5 &')).toBe(true);
  expect(hasBackgroundJob('echo hi; sleep 5 &')).toBe(true);
  expect(hasBackgroundJob("cat <<'EOF' &\ndata & data\nEOF")).toBe(true); // heredoc 명령 자체가 백그라운드 — 데이터의 & 이전에 명령행 & 가 실제 잡
});

test('ELN-BASH-BG-DETACH r6: heredoc 리터럴 `&` 명령은 완전 종료·출력 보존(통합)', async () => {
  const result = await dispatchBash({ command: "cat <<'EOF'\nwait & see\nEOF" }, { cwd: process.cwd(), defaultTimeoutMs: 8_000 });
  expect(result.exitCode).toBe(0);
  expect(result.aborted).toBe(false);
  expect(result.stdout).toContain('wait & see');
}, 10_000);

// ELN-BASH-BG-DETACH r8 — JUD #123951(8차 HOLD): 지원 범위 밖 형식이 데이터를 잡으로 분류하지 않는다.
// (1) 구분자 앞의 합법 공백(`cat << EOF`, bash 문법)도 heredoc을 연다 — 못 열면 본문의 `&`가 잡으로 오분류된다.
// (2) 한 행에 복수 heredoc(`cat <<A; cat <<B`)은 두 delimiter를 모두 소진한다 — 하나만 추적하면
//     두 번째 본문이 명령 텍스트로 노출되어 데이터 `&`가 잡으로 오분류된다.

test('ELN-BASH-BG-DETACH r8: 구분자 앞 합법 공백 형식도 본문은 데이터다(JUD #123951 ①)', () => {
  expect(hasBackgroundJob('cat << EOF\nwait & see\nEOF')).toBe(false);
  expect(hasBackgroundJob('cat <<  EOF\nrun & done\nEOF\necho after')).toBe(false);
  expect(hasBackgroundJob('cat << -EOF\ntab & body\nEOF')).toBe(false);
});

test('ELN-BASH-BG-DETACH r8: 한 행의 복수 heredoc 본문은 둘 다 데이터다(JUD #123951 ②)', () => {
  expect(hasBackgroundJob('cat <<A; cat <<B\nx & y\nA\nu & v\nB')).toBe(false);
  expect(hasBackgroundJob('cat <<A && cat <<B\nx & y\nA\nu & v\nB\necho after')).toBe(false);
});

// ELN-BASH-BG-DETACH r10 — JUD #124088(10차 HOLD): 확정 못 읽는 heredoc 구문은 건너뛰지 않는다.
// 지원 범위 밖 구분자를 건너뛰거나 단어의 일부를 구분자로 읽으면 본문이 명령 텍스트로 노출되어
// 데이터 `&`가 잡으로 오분류된다 — 구문을 확정 못 읽으면 잡 감지 자체를 중단한다(fail-closed).

test('ELN-BASH-BG-DETACH r10: 확정 못 읽는 구분자는 건너뛰지 않고 잡 감지 자체를 중단한다(JUD #124088 ①)', () => {
  expect(hasBackgroundJob('cat << /tmp/card\nbody wait & see\n/tmp/card')).toBe(false); // `/` — 지원 범위 밖 단어 문자
  expect(hasBackgroundJob('cat <<\nEOF\nwait & see\nEOF')).toBe(false); // 구분자가 다음 행 — 이 행에서 확정 불가
  expect(hasBackgroundJob('cat << &')).toBe(false); // 단어 부재 — bash 구문 오류, 잡이 없다
});

test('ELN-BASH-BG-DETACH r10: 단어의 일부를 구분자로 읽지 않는다(JUD #124088 ②)', () => {
  expect(hasBackgroundJob('cat << a.b\na\nwait & see\na.b')).toBe(false); // 구분자는 a.b 전체 — `a`는 본문
  expect(hasBackgroundJob('cat << EOF"x"\nEOF\nwait & see\nEOFx')).toBe(false); // 닫는 따옴표 뒤 붙은 단어 — 확정 불가
});
