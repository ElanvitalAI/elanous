// ⭐⭐ **실물 진입점 시험** — `bun bin/elanous.mjs` 를 «진짜로 띄운다».
//
// 🚨 이 파일이 있는 이유(리뷰 must-fix · 2026-09-01):
//    단위 시험은 `stripRemoteFlags` 의 «반환값»만 보고 「그래서 commander 가 -r 을 본다」고
//    주장했다. 그건 Goodhart 다 — ***그 함수가 실행 경로에 있는지를 원리상 못 답한다.***
//    ⇒ 그래서 여기서는 argv 를 실제 프로세스에 밀어 넣고 «화면 문면»으로 판정한다.
//
// 📏 판정선은 라이브로 «먼저 재서» 골랐다(추측이 아니다):
//    탈취가 일어나면  → "no default remote bookmark" / "attaching to remote"
//    안 일어나면      → 그 서브커맨드 자신의 산출
//    두 문면이 «갈린다»는 것을 코드를 깨서 확인한 뒤에 이 시험을 썼다.

import { setDefaultTimeout, describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const CLI = join(import.meta.dir, '..', 'bin', 'elanous.mjs');

let dir: string;
/** ⛔ 운영 `~/.elanous` 에 «절대» 닿지 않는다 — config·state 를 둘 다 격리한다.
 *  (실측 사고: --config-dir 만 준 격리 실험이 운영 remotes.json 을 덮었다.) */
let env: Record<string, string>;

function run(args: string[], timeoutMs = 90_000): { out: string; code: number | null } {
  const p = Bun.spawnSync([process.execPath, CLI, ...args], {
    env, timeout: timeoutMs, stdout: 'pipe', stderr: 'pipe',
  });
  return {
    out: `${p.stdout.toString()}\n${p.stderr.toString()}`,
    code: p.exitCode,
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'elanous-r-int-'));
  mkdirSync(join(dir, 'remotes'), { recursive: true });
  writeFileSync(join(dir, 'remotes', 'probe.token'), 'tok-abc');
  writeFileSync(join(dir, 'remotes', 'other.token'), 'tok-other');
  writeFileSync(join(dir, 'remotes.json'), JSON.stringify({
    version: 1,
    default: 'probe',
    remotes: {
      probe: {
        host: '127.0.0.1:31999',
        // ⭐ 실물 필수 필드 — 이걸 빼고 돌렸다가 「조용히 로컬로 떨어지며
        //    'attaching to remote' 를 찍는」 결함을 잡았다. 그래서 여기 있다.
        acp_url: 'ws://127.0.0.1:31999/v1/acp',
        token_file: join(dir, 'remotes', 'probe.token'),
        addedAt: '2026-09-01T00:00:00Z',
        label: 'probe-host',
      },
      // ⭐ default 와 «다른 포트» — 「이름으로 골랐나」를 포트로 가른다.
      //    같은 포트면 두 갈래가 같은 값을 내서 시험이 아무것도 못 잰다.
      other: {
        host: '127.0.0.1:32777',
        acp_url: 'ws://127.0.0.1:32777/v1/acp',
        token_file: join(dir, 'remotes', 'other.token'),
        addedAt: '2026-09-01T00:00:00Z',
        label: 'other-host',
      },
    },
  }));
  env = { ...process.env, ELANOUS_STATE_DIR: dir, ELANOUS_CONFIG_DIR: dir } as Record<string, string>;
});

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('`-r` through the REAL entrypoint', () => {
  // ⭐ B-1 — 이 창에서 진입점이 «산출을 내나». 아니면 아래 판정이 전부 무효다.
  test('B-1: the entrypoint produces output at all', () => {
    const r = run(['--version']);
    expect(r.out).toMatch(/\d+\.\d+\.\d+/);
  });

  test('수용기준 1 — `elanous -r <subcommand>` attaches AND the subcommand survives', () => {
    const r = run(['-r', 'autopilot', '--help']);
    // ⓐ -r 이 원격 해석기까지 «닿았다»
    expect(r.out).toContain('attaching to remote: probe');
    // ⓑ 그리고 `autopilot` 이 «먹히지 않았다» — 자기 도움말을 낸다.
    //    ⛔ 옛 판은 여기서 "unknown bookmark: autopilot" 을 냈다.
    expect(r.out).toContain('Usage: elanous autopilot');
    expect(r.out).not.toContain('unknown bookmark');
  });

  // 🚨 리뷰 지적: 수용기준 1 의 «정확한 형태»는 대표 가 요청한 `elanous -r` «무인자»다.
  //    ⛔ 그건 대시보드 TUI 를 띄워 «안 끝난다» ⇒ 짧은 timeout 으로 띄우고
  //       ***TUI 가 그려지기 «전»에 나오는 문면***으로 판정한다.
  //    📌 spawnSync 의 timeout 은 «죽이기 전까지의 산출»을 그대로 준다(실측).
  // 🚨 리뷰 지적: 이 시험이 «8초 timeout 뒤의 부분 출력»에 기대면 느린 기계에서 flaky 하다.
  //    🩹 ⇒ ***산출을 «감지»하고 그 자리에서 죽인다.*** 시간이 아니라 «문면»이 종료 조건이다.
  //       (timeout 은 이제 «상한»일 뿐이고, 정상 경로에서는 닿지 않는다.)
  test('수용기준 1(정확형) — bare `elanous -r` uses the DEFAULT bookmark end-to-end', async () => {
    const proc = Bun.spawn([process.execPath, CLI, '-r'], {
      env, stdout: 'pipe', stderr: 'pipe',
    });
    let out = '';
    const deadline = Date.now() + 60_000;   // ⛔ 상한 — 여기 닿으면 그건 «진짜 실패»다
    // ⭐ 종료 조건은 ***이 PR 의 코드가 «직접» 내는 문면 하나***다.
    // 🩸 처음엔 deprecation 안내 둘을 종료 조건에 넣었는데 «틀렸다»(리뷰 지적):
    //    그 안내가 정리되는 날 이 시험은 ***60초를 기다렸다가 실패***한다.
    //    ⇒ 남의 문면을 종료 조건으로 쓰지 않는다.
    const seenAll = () => out.includes('attaching to remote: probe');
    // ⛔⭐ **두 스트림을 «다» 읽는다.** 🩸 stdout 만 읽었다가 한 번 틀렸다 —
    //    deprecation 안내는 ***stderr*** 로 나가고, 그게 판정 문면 둘이었다.
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const dec = new TextDecoder();
      while (!seenAll() && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        out += dec.decode(value, { stream: true });
      }
    };
    try {
      await Promise.race([
        Promise.all([pump(proc.stdout), pump(proc.stderr)]),
        (async () => { while (!seenAll() && Date.now() < deadline) await Bun.sleep(25); })(),
      ]);
    } finally {
      proc.kill();
    }
    // ⭐ 이 시험이 «주장하는 것»은 하나다 — 대표 가 요청한 «정확한 형태»가
    //    default 북마크를 «고른다». 그 이상은 여기서 안 주장한다.
    expect(out).toContain('attaching to remote: probe');
    // ⛔ 로컬로 떨어지지 않았다.
    expect(out).not.toContain('no default remote bookmark');
    // 📌 「그래서 host·token 이 «실제로 전달되나」」는 ***다른 시험 둘***이 답한다:
    //    · `attach -r` / `attach -r other`  — 북마크의 «포트»가 접속 대상에 나타난다(31999·32777)
    //    · `a MALFORMED remotes.json …`     — 그 호출부가 «실행된다»는 것을 throw 로 증명한다
    //    ⇒ 한 시험이 전부를 주장하지 않게 갈랐다(리뷰 지적).
  }, 90_000);

  test('수용기준 3 — a subcommand own `-r` is NOT stolen', () => {
    // `autopilot link` 의 `-r, --relation <kind>`. 미션이 없으니 "미션 없음" 이 정상 산출이다.
    const r = run(['autopilot', 'link', '__nope_a', '__nope_b', '-r', 'friend']);
    expect(r.out).toContain('미션 없음');
    // ⛔ 탈취가 일어나면 여기서 원격 해석기 문면이 «대신» 나온다.
    //    📏 실제로 확인했다: isLeadingFlag 를 `return true` 로 깨면
    //       이 명령이 "no default remote bookmark" 를 낸다.
    expect(r.out).not.toContain('no default remote bookmark');
  });

  test('수용기준 4 — `--resume` still reaches the dashboard path, unchanged', () => {
    // 🩸 이 시험은 처음에 `['--resume','nexus','--help']` 로 「서브커맨드가 산다」를 쟀는데
    //    ***전제가 틀렸다***: 루트 `--resume` 는 «값을 하나 먹는» 대시보드 플래그라
    //    `nexus` 가 그 값으로 소비되고 루트 도움말이 나온다(filterDashboardArgs).
    //    ⇒ 「소비자가 읽는 것」을 잰다 — 소비 자체는 아래 filterDashboardArgs 단위시험이 고정하고,
    //       여기서는 ***원격 축이 그 경로를 «가로채지 않는다»***만 실물로 확인한다.
    const r = run(['--resume', '0000e49c-f9e8-4117-9d5f-795e57b541e9', '--help']);
    expect(r.out).toContain('Usage: elanous');
    // ⛔ 원격 축이 «가로챘다»는 신호가 나오면 안 된다.
    // 🩸 처음엔 '원격 북마크' 로 쟀는데 «틀렸다» — `-r` 을 --help 에 노출한 뒤로
    //    ***도움말 «본문»에 그 낱말이 들어간다.*** 오류 문면과 도움말이 같은 말을 쓴 것이다.
    //    ⇒ 오류 «고유»의 문면으로 좁힌다.
    expect(r.out).not.toContain('세션을 이어 하려면');
    expect(r.out).not.toContain('unknown bookmark');
  });

  test('`attach -r` fills host + token-file from the DEFAULT bookmark', () => {
    const r = run(['attach', '-r']);
    // ⭐ 「만들었다」가 아니라 ***「흐른다」***를 잰다 — 북마크의 포트가 실제 접속 대상에 나타난다.
    expect(r.out).toContain('31999');
    // ⛔ 로컬 소켓으로 떨어지면 이 문면이 나온다. 그러면 북마크가 «안 흐른» 것이다.
    expect(r.out).not.toContain('elanous.sock');
  });

  // 🚨 리뷰 지적: unknown 경로만 재고 ***성공 경로***를 안 쟀다.
  //    ⇒ default(31999) 와 «다른» named 북마크(32777)를 골라 포트로 가른다.
  test('`attach -r <name>` picks THAT bookmark — not the default', () => {
    const r = run(['attach', '-r', 'other']);
    expect(r.out).toContain('32777');          // ⭐ 이름으로 고른 쪽
    expect(r.out).not.toContain('31999');      // ⛔ default 로 새면 여기서 걸린다
    expect(r.out).not.toContain('elanous.sock'); // ⛔ 로컬로 떨어져도 걸린다
  });

  // 🚨 리뷰 지적: `bookmarkToElanousRemote` 정책 변경이 «기존 호출자»를 깨지 않는지 실물로 보라.
  //    📌 그 호출자는 둘이고, 여기서 «둘 다» 정상 북마크로 통과하는 것을 확인한다.
  test('the EXISTING callers still work with a well-formed bookmark', () => {
    const r = run(['-r', 'nexus', '--help']);
    // ⓐ 호출자 A — bookmarkAttachDefaults → host
    expect(r.out).toContain('attaching to remote: probe');
    // ⓑ 호출자 B — src/index.ts 의 `process.env.ELANOUS_REMOTE = bookmarkToElanousRemote(entry)`.
    //    ⛔ 여기서 deprecation 안내로 증명하지 «않는다» — 그 문면은 남의 것이고 사라질 수 있다.
    //       그 호출부가 «실행된다»는 것은 ***손상 시험***이 throw 로 증명한다
    //       (`a MALFORMED remotes.json fails LOUDLY on BOTH entrances` 의 ⓐ 갈래).
    //    ⇒ 이 시험은 「정상 북마크에서 «안 터진다»」만 본다.
    expect(r.out).not.toContain('acp_url');
    // ⓒ 그리고 서브커맨드는 그대로 흐른다.
    expect(r.out).toContain('Usage: elanous nexus');
  });

  test('`attach -r <name>` names an unknown bookmark instead of guessing', () => {
    const r = run(['attach', '-r', 'no-such-bookmark']);
    expect(r.out).toContain('no-such-bookmark');
    expect(r.out).toContain('unknown bookmark');
  });

  // 🚨 리뷰 지적: 수용기준 5(config-dir 격리 ⊕ -r)를 «env 와 단위시험»으로만 쟀다.
  //    ⇒ 여기서는 ***실제 프로세스에 `--config-dir <tmp>` 를 플래그로 주고*** 잰다.
  //       env(ELANOUS_CONFIG_DIR)와 플래그는 «다른 경로»다 — 하나가 되고 하나가 안 될 수 있다.
  test('수용기준 5 — `--config-dir <tmp> -r` picks THAT dir bookmark, in either order', () => {
    // ⛔ env 격리를 «떼고» 순수 플래그만으로 돌린다. 안 그러면 무엇이 이겼는지 못 가른다.
    const bare = { ...process.env } as Record<string, string>;
    delete bare.ELANOUS_CONFIG_DIR; delete bare.ELANOUS_STATE_DIR;
    const runFlagOnly = (args: string[]) => {
      const p = Bun.spawnSync([process.execPath, CLI, ...args], {
        env: bare, timeout: 90_000, stdout: 'pipe', stderr: 'pipe',
      });
      return `${p.stdout.toString()}\n${p.stderr.toString()}`;
    };
    // ⓐ 플래그가 «앞»에 — 3R 이전에는 여기서 `-r` 이 아예 안 잡혔다.
    const a = runFlagOnly(['--config-dir', dir, '-r', 'nexus', '--help']);
    expect(a).toContain('attaching to remote: probe');
    expect(a).toContain('Usage: elanous nexus');
    // ⓑ 순서를 바꿔도 같은 답 — 「옵션 순서로 동작이 갈린다」가 지적의 본체였다.
    const b = runFlagOnly(['-r', '--config-dir', dir, 'nexus', '--help']);
    expect(b).toContain('attaching to remote: probe');
    expect(b).toContain('Usage: elanous nexus');
    // ⛔⭐ 그리고 ***운영 경로를 안 건드린다*** — 그 tmp 의 북마크(31999)를 골랐다는 증거.
    expect(a).toContain('probe');
  });

  // 🚨 리뷰 지적(2R 연속): 손상 북마크 정책 변경을 «양쪽 진입»에서 E2E 로 보라.
  //    ⇒ 별도 remotes.json 을 «망가뜨려» 두고 root 와 attach 를 «둘 다» 친다.
  //    ⛔ 원 픽스처를 건드리지 않는다 — 다른 시험이 그것을 쓴다.
  test('a MALFORMED remotes.json fails LOUDLY on BOTH entrances — root and attach', () => {
    const bad = mkdtempSync(join(tmpdir(), 'elanous-r-bad-'));
    try {
      mkdirSync(join(bad, 'remotes'), { recursive: true });
      writeFileSync(join(bad, 'remotes', 'broken.token'), 'tok');
      writeFileSync(join(bad, 'remotes.json'), JSON.stringify({
        version: 1,
        default: 'broken',
        // ⭐ `acp_url` 이 «없다» — 사람이 손으로 고친 remotes.json 의 실제 모양이다.
        remotes: {
          broken: {
            host: '127.0.0.1:31999',
            token_file: join(bad, 'remotes', 'broken.token'),
            addedAt: '2026-09-01T00:00:00Z',
          },
        },
      }));
      const badEnv = { ...process.env, ELANOUS_STATE_DIR: bad, ELANOUS_CONFIG_DIR: bad } as Record<string, string>;
      const runBad = (args: string[]) => {
        const p = Bun.spawnSync([process.execPath, CLI, ...args], {
          env: badEnv, timeout: 90_000, stdout: 'pipe', stderr: 'pipe',
        });
        return `${p.stdout.toString()}\n${p.stderr.toString()}`;
      };

      // ⓐ 루트 진입 — 전에는 "attaching to remote: broken" 을 찍고 «조용히» 로컬로 갔다.
      const root = runBad(['-r', 'nexus', '--help']);
      expect(root).toContain('acp_url');
      // ⭐ 사람이 고칠 «대상»을 이름으로 댄다(오류 문면은 entry.host 를 쓴다).
      expect(root).toContain('127.0.0.1:31999');
      // ⛔ 그리고 ***거짓 안심 문면이 나오면 안 된다.***
      expect(root).not.toContain('ELANOUS_REMOTE is deprecated');
      expect(root).not.toContain('attaching to');
      // ⛔⭐ **스택 트레이스면 실패다** — 사람에게 `elanous: <이유>` 한 줄이 가야 한다.
      //    🩸 이 단언이 실물 결함을 잡았다: 루트의 오류 가드가 «해석»만 감싸고
      //       «사용»은 안 감싸서 그 자리에서 스택이 그대로 나왔다.
      expect(root).toContain('elanous: remote bookmark');
      expect(root).not.toContain('at bookmarkToElanousRemote');

      // ⓑ attach 진입 — 같은 손상에 같은 이름을 댄다.
      const att = runBad(['attach', '-r']);
      expect(att).toContain('acp_url');
      expect(att).not.toContain('elanous.sock');
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });

  test('an old-habit `-r <uuid>` is told to use --resume — through the real CLI', () => {
    const r = run(['-r', '0000e49c-f9e8-4117-9d5f-795e57b541e9']);
    expect(r.out).toContain('--resume');
    expect(r.code).toBe(1);
  });

  // ⛔⭐⭐ **「`--` 회귀를 실물로 못 잰다」를 «주장»으로 두지 않고 «시험»으로 만든다.**
  //
  // 📏 리뷰 요구: *"배포 런처 수준의 동작을 문서화하거나 보존 가능한 진입점에서 E2E"*.
  //    전수로 훑은 결과 — ***보존하는 진입점이 이 저장소엔 없다***:
  //    ```
  //    bun probe.mjs -- -r        → ["-r"]        ⇐ bun 이 먹는다
  //    bun run probe.mjs -- -r    → ["-r"]
  //    bun -- probe.mjs -- -r     → ["-r"]
  //    node probe.mjs -- -r       → ["--","-r"]   ⇐ ***보존한다. 그러나…***
  //    node bin/elanous.mjs         → ERR_MODULE_NOT_FOUND  ⇐ …elanous 를 «못 띄운다»
  //    배포 런처                   ~/.bun/bin/elanous → bin/elanous.mjs (셔뱅 `#!/usr/bin/env bun`)
  //    ```
  // ⇒ 그래서 사용자의 `elanous -- -r` 은 ***오늘 이미*** `elanous -r` 이다(탈취가 사용자에게 안 보인다).
  // 🔑 그렇다고 수리가 «불필요»한 게 아니다 — argv 는 프로그램 호출로도 오고, 런처는 바뀐다.
  //    ⇒ ***런처가 바뀌면 이 시험이 «먼저» 말한다.***
  test('launcher contract: bun REMOVES `--`, so it never reaches elanous (watched, not assumed)', () => {
    const probe = join(dir, 'argv-probe.mjs');
    writeFileSync(probe, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    const seen = (argv: string[]) => {
      const p = Bun.spawnSync([process.execPath, probe, ...argv], { stdout: 'pipe', stderr: 'pipe' });
      return p.stdout.toString().trim();
    };
    // ⭐ 자를 «먼저» 누른다 — 평범한 인자는 그대로 와야 한다(안 오면 이 탐침이 깨진 것이다).
    expect(seen(['-r', 'x'])).toBe('["-r","x"]');
    // ⭐ 본 판정: 오늘의 런처는 `--` 를 «먹는다».
    //    ⛔ 이 단언이 깨지면 = 런처가 `--` 를 보존하기 시작한 것 ⇒ 그때는 위 `--` 회귀를
    //       ***실물 E2E 로 올려야 한다.*** 이 시험이 그 순간을 알린다.
    expect(seen(['--', '-r'])).toBe('["-r"]');
  });
});