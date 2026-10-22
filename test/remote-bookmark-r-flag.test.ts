// `-r` 북마크 해석 — «어느 북마크를 고르나» ⊕ «우주를 따르나».
//
// 🩸 이 시험이 있는 이유: 처음 판정할 때 나는 `attach -r iso --message` 가 왕복하는 것을 보고
//    「-r 이 돈다」로 읽었다. ⛔ 틀렸다 — 그 북마크가 «default» 여서, `-r` 을 «안 줘도»
//    똑같이 갔다. 즉 그 시험은 default 를 쟀지 `-r <name>` 을 «가르지» 못했다.
//    ⇒ 그래서 여기서는 ***북마크를 «둘» 두고, default 가 «아닌» 쪽을 -r 로 고른다.***
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { filterDashboardArgs, program } from '../src/index.js';
import { RemotesStore } from '../src/cli/remotes.js';
import { setElanousConfigDir, getElanousConfigDirOverride, resetElanousConfigDir } from '../src/elanous-config-dir.js';
import { ROOT_FLAGS_TAKING_VALUE, bookmarkAttachDefaults, bookmarkToElanousRemote, readRemoteFlag, stripRemoteFlags } from '../src/cli/remote-resolve.js';
import { registerPtyTakeoverCommands, type PtyTakeoverCommandDeps } from '../src/cli/pty-takeover-cli.js';

let dir: string;
let prevConfigDir: string | undefined;

function entry(port: number, tokenFile: string) {
  return {
    acp_url: `ws://127.0.0.1:${port}/v1/acp`,
    voice_url: `ws://127.0.0.1:${port}/v1/voice/ws`,
    token_required: true,
    token_file: tokenFile,
    server_label: `test-${port}`,
    added_at: new Date(0).toISOString(),
  } as unknown as Parameters<RemotesStore['addRemote']>[1];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elanous-remotes-'));
  prevConfigDir = getElanousConfigDirOverride();
  setElanousConfigDir(dir);
});
afterEach(() => {
  // ⛔ 「없었음」과 「어떤 값이었음」을 다른 처리로 — setElanousConfigDir(undefined) 는 던진다.
  if (prevConfigDir === undefined) resetElanousConfigDir();
  else setElanousConfigDir(prevConfigDir);
  rmSync(dir, { recursive: true, force: true });
});

describe('-r bookmark resolution', () => {
  test('`--remote <name>` selects THAT bookmark — not the default', () => {
    const tok = join(dir, 'tok');
    mkdirSync(dir, { recursive: true });
    writeFileSync(tok, 'test-token');
    const store = new RemotesStore();
    store.addRemote('good', entry(31416, tok), { setDefault: true });
    store.addRemote('other', entry(31999, tok));

    // ⭐ 핵심 — default 는 good 인데 other 를 «이름으로» 고른다.
    const chosen = store.getRemote('other');
    expect(chosen).toBeDefined();
    const defaults = bookmarkAttachDefaults(chosen!);
    expect(defaults.host).toContain('31999');
    expect(defaults.host).not.toContain('31416');

    // 대조 — 이름을 안 주면 default 다.
    const fallback = store.getDefaultRemote();
    expect(bookmarkAttachDefaults(fallback!).host).toContain('31416');
  });

  // ⛔ 대표 지적: 같은 플래그가 «값 유무»로 뜻이 갈리면 배울 수 없다.
  //    ⇒ `-r` 은 «언제나» 원격이다. 옛 루트 별칭(-r → --resume)은 뗐다.
  //    📏 뗀 근거: 그 별칭은 commander option 으로 선언된 적 없고 --help 에도 없었으며
  //       docs/scripts/test 사용 0건이었다. --resume(긴 형태 · 58파일)은 그대로다.
  //
  // 🩸🩸 그리고 이 시험 뭉치는 «두 번» 틀렸다. 둘 다 남긴다 — 다음 사람이 같은 길을 판다.
  //   ①  처음: 「자리에 따라 뜻이 «안» 바뀐다」 ⇒ 틀렸다. 자리는 갈려야 한다(탈취 방지).
  //   ②  다음: 「뒤 토큰이 «실제 북마크»면 값으로 먹는다」 ⇒ ***더 틀렸다.***
  //       ***같은 명령줄이 remotes.json 의 «내용»에 따라 다른 뜻이 된다.***
  //       사람이 배울 수 없고, 시험이 고정할 수도 없다(4R 리뷰 지적).
  //   ⇒ 최종: ***`-r` 은 «절대» 값을 먹지 않는다.*** 이름을 대려면 `--remote <name>`.

  test('`-r` NEVER takes a value — the meaning cannot depend on remotes.json', () => {
    // ⭐ 이 셋이 «같은 값»이어야 한다. 뒤에 무엇이 오든 -r 은 bare 다.
    expect(readRemoteFlag(['-r'])).toEqual({ present: true, value: '' });
    expect(readRemoteFlag(['-r', 'attach'])).toEqual({ present: true, value: '' });
    expect(readRemoteFlag(['-r', 'a-name-that-could-be-a-bookmark'])).toEqual({ present: true, value: '' });
  });

  // 🩸 실측으로 잡은 함정: `elanous -r attach` 가 "unknown bookmark: attach" 를 냈다 —
  //    사람이 가장 자연스럽게 치는 문면인데 막혔다. 이제는 흐른다.
  test('bare `-r` followed by a SUBCOMMAND does not eat it', () => {
    expect(stripRemoteFlags(['-r', 'attach'])).toEqual(['attach']);
    // ⭐ 값을 «안» 먹으므로 뒤 토큰들은 «전부» commander 로 간다.
    expect(stripRemoteFlags(['-r', 'other', 'attach'])).toEqual(['other', 'attach']);
  });

  // 🚨 실측으로 잡은 «탈취» — 전역 선처리가 argv 전체의 -r 을 먹으면
  //    다른 명령의 -r 까지 가져간다. src/index.ts:6207 에 `-r, --relation <kind>` 가 있다.
  //    📏 전:  ["autopilot","link","A","B","-r","friend"] → flag={present:true}
  //            strip=[...,"friend"]  ⇒ commander 가 -r 을 못 보고 --relation 이 기본값으로 떨어진다
  test('a SUBCOMMAND own `-r` is NOT stolen by the global preparse', () => {
    const argv = ['autopilot', 'link', 'A', 'B', '-r', 'friend'];
    expect(readRemoteFlag(argv)).toEqual({ present: false, value: '' });
    // argv 가 «그대로» 넘어가야 commander 가 --relation 을 본다.
    expect(stripRemoteFlags(argv)).toEqual(argv);
  });

  test('`attach -r <name>` is left for the attach command itself', () => {
    // 전역은 안 먹는다(선행 플래그가 아니다) — attach 액션이 bookmarkAttachDefaults 로 편다.
    expect(readRemoteFlag(['attach', '-r', 'other'])).toEqual({ present: false, value: '' });
    expect(stripRemoteFlags(['attach', '-r', 'other'])).toEqual(['attach', '-r', 'other']);
  });

  test('bookmarkAttachDefaults maps a bookmark to host + token-file (used by attach)', () => {
    const tok = join(dir, 'tok');
    writeFileSync(tok, 'test-token');
    const store = new RemotesStore();
    store.addRemote('other', entry(31999, tok));
    const d = bookmarkAttachDefaults(store.getRemote('other')!);
    expect(d.host).toContain('31999');
    expect(d.tokenFile).toBe(tok);
  });

  test('`--remote` (long form) REQUIRES its value — main 의 기존 계약 그대로', () => {
    // 긴 형태는 값을 요구하므로 데이터에 안 묻는다.
    expect(readRemoteFlag(['--remote', 'attach'])).toEqual({ present: true, value: 'attach' });
    expect(stripRemoteFlags(['--remote', 'attach', 'x'])).toEqual(['x']);
    // ⛔ 값이 없거나 플래그면 «조용히 default 로 떨어지지 않고» 말한다.
    //    (main 이 이미 그랬다 — 이 판이 그것을 완화하지 «않는다»는 고정이다.)
    expect(() => readRemoteFlag(['--remote'])).toThrow(/requires a bookmark name/);
    expect(() => readRemoteFlag(['--remote', '--debug'])).toThrow(/requires a bookmark name/);
  });

  // 🚨 리뷰 지적: `--remote x -r` 에서 파서는 `--remote` 를 읽는데 stripper 가 `-r` 을
  //    «남겨» commander 가 "unknown option '-r'" 을 냈다. 두 규칙이 갈린 것이다.
  //    🩹 `--remote` 의 «자기 값»은 arity 를 우리가 아는 «유일한» 경우라, 그 값만
  //       선행 구간을 안 끊게 했다. ⇒ 첫 번째가 이기고, 둘 다 걷힌다.
  test('duplicate remote flags: the FIRST wins and BOTH are stripped', () => {
    expect(readRemoteFlag(['--remote', 'mbp', '-r'])).toEqual({ present: true, value: 'mbp' });
    expect(stripRemoteFlags(['--remote', 'mbp', '-r'])).toEqual([]);
    // ⊕ 뒤에 서브커맨드가 오는 실제 모양에서도 갈리지 않는다.
    expect(stripRemoteFlags(['--remote', 'mbp', '-r', 'nexus'])).toEqual(['nexus']);
    // ⊕ 반대 순서도 같은 답(첫 번째 `-r` 이 이기고 값을 «안» 먹는다).
    expect(readRemoteFlag(['-r', '--remote', 'mbp'])).toEqual({ present: true, value: '' });
  });

  // 🩸 실물로 잡았다(2026-09-01): 픽스처에서 `acp_url` 을 빠뜨렸더니 호출부의
  //    `bookmarkHost ? …` 가 falsy 로 읽어 ***로컬 소켓으로 조용히 떨어지면서***
  //    화면엔 "attaching to remote: probe" 가 찍혔다 — 도구가 «거짓말»을 했다.
  //    remotes.json 은 사람이 고칠 수 있는 파일이라 이 상태가 실재한다.
  test('a MALFORMED bookmark names itself instead of silently going local', () => {
    const broken = {
      host: 'probe', acp_url: undefined as unknown as string,
      token_file: '/tmp/x', addedAt: '2026-09-01T00:00:00Z',
    };
    expect(() => bookmarkToElanousRemote(broken)).toThrow(/acp_url/);
    expect(() => bookmarkToElanousRemote(broken)).toThrow(/probe/);
    // ⊕ 빈 문자열도 같은 취급 — 「있다」와 「쓸 수 있다」는 다른 값이다.
    expect(() => bookmarkToElanousRemote({ ...broken, acp_url: '' })).toThrow(/acp_url/);
    // ✅ 대조 — 멀쩡한 것은 그대로 통과한다(가드가 «전부»를 막으면 그것도 결함이다).
    expect(bookmarkToElanousRemote({ ...broken, acp_url: 'ws://h/v1/acp' })).toBe('ws://h/v1/acp');
  });

  // 🩸 이 자리에는 원래 `leading-run limitation` 이라는 시험이 있었다 —
  //    「`--config-dir /x -r` 은 원리상 못 잡는다」를 «고정»하는 시험이었다.
  //    ⛔ 리뷰가 그것을 ***Goodhart*** 라 불렀다: 수용기준 미달을 검증으로 포장한 것.
  //    📏 세어 보니 루트에서 값을 받는 플래그는 `--config-dir` «하나»였다 — 열거 가능했다.
  //    ⇒ 한계를 «고쳤고», 시험도 「안 되는 것」에서 ***「되는 것」***으로 바꿨다.
  // 🚨 리뷰 must-fix: `--` 는 «플래그»가 아니라 ***옵션의 끝***이다.
  //    옛 판은 `--` 도 `-` 로 시작하니 플래그로 세었고, `elanous -- -r` 의 «위치 인자» `-r` 을
  //    원격 플래그로 탈취했다.
  //
  // ⚠️⭐ **이 축은 «실물 CLI 시험으로 못 잰다» — 그리고 그것을 여기 적는다.**
  //    📏 실측: `bun <script> -- -r` 은 ***bun 자신이 `--` 를 먹어*** argv 로 `["-r"]` 만 준다.
  //       (`bun -e 'console.log(process.argv.slice(2))' -- -r` → `[]` ·
  //        `bun probe.mjs -- -r` → `["-r"]`)
  //    ⇒ 그래서 이 저장소의 진입점(bun 런처)으로는 `--` 가 «도달하지 않는다».
  //       ⛔ 그걸 「버그가 없다」로 읽지 않는다 — argv 는 다른 런처·프로그램 호출로도 온다.
  //       ⇒ ***소비자 함수에 직접 대는 것이 이 축의 «유일한» 자다.***
  test('`--` ends the leading run — a positional `-r` after it is NOT stolen', () => {
    expect(readRemoteFlag(['--', '-r'])).toEqual({ present: false, value: '' });
    expect(stripRemoteFlags(['--', '-r'])).toEqual(['--', '-r']);
    // ⊕ 앞에 진짜 루트 플래그가 있어도 `--` 뒤는 위치 인자다.
    expect(readRemoteFlag(['--config-dir', '/x', '--', '-r'])).toEqual({ present: false, value: '' });
    expect(stripRemoteFlags(['--config-dir', '/x', '--', '-r'])).toEqual(['--config-dir', '/x', '--', '-r']);
    // ⊕ 긴 형태도 같다.
    expect(readRemoteFlag(['--', '--remote', 'mbp'])).toEqual({ present: false, value: '' });
    // ✅ 대조 — `--` «앞»의 `-r` 은 여전히 우리 것이다(가드가 «전부»를 막으면 그것도 결함이다).
    expect(readRemoteFlag(['-r', '--', 'x'])).toEqual({ present: true, value: '' });
    expect(stripRemoteFlags(['-r', '--', 'x'])).toEqual(['--', 'x']);
  });

  test('수용기준 5 — `--config-dir <path>` before `-r` no longer breaks the leading run', () => {
    expect(readRemoteFlag(['--config-dir', '/x', '-r'])).toEqual({ present: true, value: '' });
    expect(stripRemoteFlags(['--config-dir', '/x', '-r'])).toEqual(['--config-dir', '/x']);
    // ⊕ 순서를 바꿔도 같은 답이어야 한다 — 「옵션 순서로 동작이 갈린다」가 지적의 본체였다.
    expect(readRemoteFlag(['-r', '--config-dir', '/x'])).toEqual({ present: true, value: '' });
    expect(stripRemoteFlags(['-r', '--config-dir', '/x'])).toEqual(['--config-dir', '/x']);
    // ⊕ 이름 있는 형태도.
    expect(readRemoteFlag(['--config-dir', '/x', '--remote', 'mbp'])).toEqual({ present: true, value: 'mbp' });
    expect(stripRemoteFlags(['--config-dir', '/x', '--remote', 'mbp'])).toEqual(['--config-dir', '/x']);
    // ⛔ 그래도 «서브커맨드»는 여전히 구간을 끊는다 — 탈취 방지가 이 축의 이유다.
    expect(readRemoteFlag(['--config-dir', '/x', 'autopilot', 'link', '-r', 'friend']))
      .toEqual({ present: false, value: '' });
  });

  test('`--tui` consumes its value before a root `-r` bookmark flag', () => {
    expect(readRemoteFlag(['--tui', 'next', '-r'])).toEqual({ present: true, value: '' });
    expect(stripRemoteFlags(['--tui', 'next', '-r'])).toEqual(['--tui', 'next']);
    expect(readRemoteFlag(['--tui', 'next', 'autopilot', 'link', '-r', 'friend']))
      .toEqual({ present: false, value: '' });
  });

  // ⭐⭐⭐ **목록이 늙는 것을 시험이 «먼저» 잡는다 — 이제 «소스 텍스트»가 아니라
  //    commander 자신의 «옵션 메타데이터»로 판정한다.**
  //
  // 🩸 이 시험은 «세 번» 고쳤고 그 궤적이 요점이다:
  //   ① 없었다                      ⇒ 손으로 적은 집합이 조용히 늙는다
  //   ② 소스 정규식으로 훑었다        ⇒ `-x, --foo <x>` · `[x]` · 큰따옴표를 놓쳤다(리뷰)
  //   ③ 넓힌 정규식 + 사각 가드       ⇒ 여전히 «선언 API 를 바꾸면» 놓친다(리뷰)
  //   ④ ***commander 메타데이터***    ⇒ 어떤 API(`option`/`addOption`)로 선언하든,
  //      어디에 적든, 무슨 인용을 쓰든 ***결과는 같은 객체에 모인다.***
  // 🔑 ***자를 「소스 문자열」에서 「그 소스가 «만든 것»」으로 옮긴 것***이 이 수리의 전부다.
  test('root value-taking flags are enumerated — checked against commander metadata', () => {
    // ⛔ 자를 «먼저» 눌러 본다 — 옵션이 하나도 없으면 이 시험은 무엇이든 통과한다.
    expect(program.options.length).toBeGreaterThan(0);

    // commander 가 스스로 말한다: `<값>` = required · `[값]` = optional · 없으면 불리언.
    const valueTaking = program.options
      .filter((o) => o.required || o.optional)
      .map((o) => o.long)
      .filter((l): l is string => typeof l === 'string');

    // ⊕ 알려진 양성 — 이게 안 나오면 필터가 깨진 것이다.
    expect(valueTaking).toContain('--config-dir');
    // ⊕ 알려진 음성 — 불리언이 섞여 들면 집합을 억지로 키운다.
    expect(valueTaking).not.toContain('--test');

    // ⭐ 본 판정: 값을 받는 루트 옵션이 전부 «제품» 집합 안에 있어야 한다.
    // ⛔ 집합을 여기서 «다시 적지» 않는다 — 사본을 검사하면 제품을 못 지킨다.
    for (const flag of valueTaking) {
      expect({ flag, known: ROOT_FLAGS_TAKING_VALUE.has(flag) }).toEqual({ flag, known: true });
    }
  });

  test('an old-habit `-r <sessionId>` is told where to go — not silently routed', () => {
    // ⛔ 이 갈래가 없으면 그 사람은 「엉뚱한 원격에 붙은 뒤 unknown command」를 본다.
    // 📏 모양은 «실물»에서 왔다 — ~/.elanous/sessions/ 의 파일명은 전부 완전한 UUID 다.
    expect(() => readRemoteFlag(['-r', '0000e49c-f9e8-4117-9d5f-795e57b541e9']))
      .toThrow(/--resume/);
    // ⊕ 대문자 UUID 도 같은 안내(파일명이 소문자여도 사람은 붙여넣는다).
    expect(() => readRemoteFlag(['-r', '0000E49C-F9E8-4117-9D5F-795E57B541E9']))
      .toThrow(/--resume/);

    // ⛔⭐ 그리고 ***너무 넓지 않다*** — 리뷰 지적으로 좁힌 축이다.
    //    옛 판(`session-[A-Za-z0-9]`)은 아래 이름들을 전부 삼켰다.
    for (const notASession of ['mbp', 'session-home', 'elanous-session-abc', 'prod-1', 'a1b2c3d4-1111-']) {
      expect(readRemoteFlag(['-r', notASession])).toEqual({ present: true, value: '' });
    }
  });

  test('`--resume` is NOT captured by the remote flag', () => {
    // 긴 형태는 58개 파일이 쓴다 — 원격이 «가로채면» 그것이 회귀다.
    expect(readRemoteFlag(['--resume', 'sess-1'])).toEqual({ present: false, value: '' });
    expect(stripRemoteFlags(['--resume', 'sess-1'])).toEqual(['--resume', 'sess-1']);
  });

  test('stripRemoteFlags removes the flags so commander never sees them', () => {
    expect(stripRemoteFlags(['--local', 'attach'])).toEqual(['attach']);
  });

  test('an unknown name resolves to nothing — the caller must say what to do', () => {
    const store = new RemotesStore();
    expect(store.getRemote('nope')).toBeUndefined();
    expect(store.getDefaultRemote()).toBeUndefined();
  });

  // ⭐⭐ 「-r 을 resume 에서 뗐다」의 ***소비자***는 이 함수다(src/index.ts 의 대시보드 진입).
  //    ⛔ strip/read 만 재면 이 축은 «안 걸린다» — 다른 함수가 argv 를 또 훑기 때문이다.
  test('filterDashboardArgs: `--resume` still consumes its value — and `-r` no longer does', () => {
    // ⓐ 긴 형태는 «그대로» — 플래그와 그 값 둘 다 대시보드가 먹는다.
    expect(filterDashboardArgs(['--resume', 'sess-1'])).toEqual([]);
    // ⚠️ 남는 토큰은 «대시보드 플래그가 아닌» 것으로 골라야 한다 — `--debug` 는
    //    DASHBOARD_FLAGS 라 같이 걸러진다(그 가정으로 이 시험이 한 번 틀렸다).
    expect(filterDashboardArgs(['--resume', 'sess-1', 'zzz'])).toEqual(['zzz']);
    // ⓑ ⛔ 그리고 `-r` 은 «더 이상» resume 이 아니다 — 여기서 아무것도 안 먹는다.
    //    (원격 축이 이미 걷어낸 뒤에 이 함수가 도는 것이 실제 순서지만,
    //     ***이 함수 «자신»이 -r 을 resume 으로 읽지 않는다***는 것이 이 판의 주장이다.)
    expect(filterDashboardArgs(['-r', 'sess-1'])).toEqual(['-r', 'sess-1']);
    // ⓒ 서브커맨드로 시작하면 루트 플래그를 안 건드린다(기존 계약 — 회귀 방지).
    expect(filterDashboardArgs(['nexus', '--resume', 'x'])).toEqual(['nexus', '--resume', 'x']);
  });

  test('the bookmark store follows the CONFIG DIR — never the real ~/.elanous', () => {
    // ⛔ 이 회귀가 실제로 났다: --config-dir <격리> 로 nexus connect 를 쳤는데
    //    토큰·북마크가 «운영» ~/.elanous 에 쓰였고 default 가 테스트 데몬을 가리켰다.
    const tok = join(dir, 'tok');
    writeFileSync(tok, 'test-token');
    const store = new RemotesStore();
    store.addRemote('iso', entry(31416, tok), { setDefault: true });
    // ⭐ 자격 경로가 이 회귀의 «핵심»이다 — 운영 ~/.elanous/remotes/ 에 토큰이 쓰였던 것.
    store.saveToken('iso', 'secret-token-value');

    expect(existsSync(join(dir, 'remotes.json'))).toBe(true);
    const raw = readFileSync(join(dir, 'remotes.json'), 'utf-8');
    expect(raw).toContain('iso');

    // ⭐ 그리고 «설정 디렉터리 밖»에는 안 생긴다.
    // ⛔ 실제 홈(~/.elanous)을 읽어 비교하지 «않는다» — 그건 개인 설정에 따라 갈리는
    //    환경 의존 시험이 된다(리뷰 지적). 대신 ***경로 자체가 config-dir 를 따르는지***를 문다:
    //    그것이 이 회귀의 «원인»이었다(전: homedir() 하드코딩 · 후: getElanousConfigDir()).
    //    ⇒ 「config-dir 안에 생겼다」로 문다. 그게 회귀의 원인이었던 그 축이다.
    expect(existsSync(join(dir, 'remotes.json'))).toBe(true);
    expect(existsSync(join(dir, 'remotes', 'iso.token'))).toBe(true);
    // ⊕ 토큰 «내용»도 config-dir 안에 있다(경로만 맞고 값이 비면 반쪽이다).
    expect(readFileSync(join(dir, 'remotes', 'iso.token'), 'utf-8').trim().length).toBeGreaterThan(0);
  });
});

describe('pty list -r / --remote grammar', () => {
  const listDeps = (store: RemotesStore, fetchRemoteTerminals: NonNullable<PtyTakeoverCommandDeps['fetchRemoteTerminals']>): PtyTakeoverCommandDeps => ({
    getPty: () => undefined,
    requestPtyTakeover: () => false,
    requestRemote: async () => ({ status: 'unknown-pty' as const }),
    log: () => {},
    remotesStore: () => store,
    fetchRemoteTerminals,
    listRefs: () => [{ id: 'pty_local_only', kind: 'shell', source: 'local', alive: true }],
  });

  test('pty list `-r` selects only the default bookmark', async () => {
    const tok = join(dir, 'tok');
    writeFileSync(tok, 'default-token');
    const store = new RemotesStore();
    store.addRemote('good', entry(31416, tok), { setDefault: true });
    store.addRemote('other', entry(31999, tok));
    const seen: Array<{ url: string; token: string }> = [];
    const stdout: string[] = [];
    const originalOut = process.stdout.write;
    process.stdout.write = ((chunk: string) => { stdout.push(chunk); return true; }) as typeof process.stdout.write;
    try {
      const cli = new Command();
      registerPtyTakeoverCommands(cli, listDeps(store, async (url, token) => {
        seen.push({ url, token });
        return { ok: true, terminals: [{ id: 'pty_from_default', kind: 'shell', alive: true }] };
      }));
      await cli.parseAsync(['node', 'elanous', 'pty', 'list', '-r']);
      expect(seen).toEqual([{ url: 'http://127.0.0.1:31416/v1/terminals', token: 'default-token' }]);
      expect(stdout.join('')).toContain('pty_from_default');
      expect(stdout.join('')).not.toContain('pty_local_only');
    } finally {
      process.stdout.write = originalOut;
      process.exitCode = 0;
    }
  });

  test('pty list `-r other` does not consume the following token as a bookmark name', async () => {
    const tok = join(dir, 'tok');
    writeFileSync(tok, 'default-token');
    const store = new RemotesStore();
    store.addRemote('good', entry(31416, tok), { setDefault: true });
    store.addRemote('other', entry(31999, tok));
    const seen: Array<{ url: string; token: string }> = [];
    const cli = new Command();
    cli.exitOverride();
    registerPtyTakeoverCommands(cli, listDeps(store, async (url, token) => {
      seen.push({ url, token });
      return { ok: true, terminals: [{ id: 'pty_should_not_list', kind: 'shell', alive: true }] };
    }));
    await expect(cli.parseAsync(['node', 'elanous', 'pty', 'list', '-r', 'other'])).rejects.toThrow(/too many arguments/i);
    expect(seen).toEqual([]);
  });

  test('pty list `--remote <name>` selects that named bookmark', async () => {
    const tok = join(dir, 'tok');
    writeFileSync(tok, 'named-token');
    const store = new RemotesStore();
    store.addRemote('good', entry(31416, tok), { setDefault: true });
    store.addRemote('other', entry(31999, tok));
    const seen: Array<{ url: string; token: string }> = [];
    const stdout: string[] = [];
    const originalOut = process.stdout.write;
    process.stdout.write = ((chunk: string) => { stdout.push(chunk); return true; }) as typeof process.stdout.write;
    try {
      const cli = new Command();
      registerPtyTakeoverCommands(cli, listDeps(store, async (url, token) => {
        seen.push({ url, token });
        return { ok: true, terminals: [{ id: 'pty_from_named', kind: 'shell', alive: true }] };
      }));
      await cli.parseAsync(['node', 'elanous', 'pty', 'list', '--remote', 'other']);
      expect(seen).toEqual([{ url: 'http://127.0.0.1:31999/v1/terminals', token: 'named-token' }]);
      expect(stdout.join('')).toContain('pty_from_named');
    } finally {
      process.stdout.write = originalOut;
      process.exitCode = 0;
    }
  });

  test('pty list `-r` with no bookmarks names the missing default and does not list locally', async () => {
    const store = new RemotesStore();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalOut = process.stdout.write;
    const originalErr = process.stderr.write;
    process.stdout.write = ((chunk: string) => { stdout.push(chunk); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => { stderr.push(chunk); return true; }) as typeof process.stderr.write;
    try {
      const cli = new Command();
      registerPtyTakeoverCommands(cli, listDeps(store, async () => { throw new Error('must not fetch'); }));
      await cli.parseAsync(['node', 'elanous', 'pty', 'list', '-r']);
      expect(process.exitCode).toBe(1);
      expect(stderr.join('')).toMatch(/no default remote bookmark/);
      expect(stdout.join('')).not.toContain('pty_local_only');
      expect(stderr.join('')).not.toContain('pty_local_only');
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
      process.exitCode = 0;
    }
  });

  test('pty list `--remote nope` names the unknown bookmark and does not list locally', async () => {
    const tok = join(dir, 'tok');
    writeFileSync(tok, 'default-token');
    const store = new RemotesStore();
    store.addRemote('good', entry(31416, tok), { setDefault: true });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalOut = process.stdout.write;
    const originalErr = process.stderr.write;
    process.stdout.write = ((chunk: string) => { stdout.push(chunk); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => { stderr.push(chunk); return true; }) as typeof process.stderr.write;
    try {
      const cli = new Command();
      registerPtyTakeoverCommands(cli, listDeps(store, async () => { throw new Error('must not fetch'); }));
      await cli.parseAsync(['node', 'elanous', 'pty', 'list', '--remote', 'nope']);
      expect(process.exitCode).toBe(1);
      expect(stderr.join('')).toMatch(/unknown bookmark/);
      expect(stderr.join('')).toContain('nope');
      expect(stdout.join('')).not.toContain('pty_local_only');
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
      process.exitCode = 0;
    }
  });

  test('pty list `-r` with http acp_url reaches GET /v1/terminals, not /v1/acp/v1/terminals', async () => {
    const seen: Array<{ path: string; auth: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push({ path: url.pathname, auth: req.headers.get('authorization') });
        if (url.pathname === '/v1/terminals') {
          return Response.json({ terminals: [{ id: 'pty_from_http_acp', kind: 'shell', alive: true }] });
        }
        return new Response('not-found', { status: 404 });
      },
    });
    const tok = join(dir, 'tok');
    writeFileSync(tok, 'http-token');
    const store = new RemotesStore();
    store.addRemote('iso', {
      host: 'iso',
      acp_url: `http://127.0.0.1:${server.port}/v1/acp`,
      token_file: tok,
      addedAt: new Date(0).toISOString(),
    }, { setDefault: true });
    const stdout: string[] = [];
    const originalOut = process.stdout.write;
    process.stdout.write = ((chunk: string) => { stdout.push(chunk); return true; }) as typeof process.stdout.write;
    try {
      const cli = new Command();
      registerPtyTakeoverCommands(cli, {
        getPty: () => undefined,
        requestPtyTakeover: () => false,
        requestRemote: async () => ({ status: 'unknown-pty' as const }),
        log: () => {},
        remotesStore: () => store,
        listRefs: () => [{ id: 'pty_local_only', kind: 'shell', source: 'local', alive: true }],
      });
      await cli.parseAsync(['node', 'elanous', 'pty', 'list', '-r']);
      expect(seen).toEqual([{ path: '/v1/terminals', auth: 'Bearer http-token' }]);
      expect(seen.some((hit) => hit.path === '/v1/acp/v1/terminals')).toBe(false);
      expect(stdout.join('')).toContain('pty_from_http_acp');
      expect(stdout.join('')).not.toContain('pty_local_only');
      expect(process.exitCode).toBe(0);
    } finally {
      process.stdout.write = originalOut;
      process.exitCode = 0;
      server.stop(true);
    }
  });

  test('pty list `-r` reaches GET /v1/terminals on the bookmarked host with the bookmark token', async () => {
    const seen: Array<{ path: string; auth: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push({ path: url.pathname, auth: req.headers.get('authorization') });
        if (url.pathname === '/v1/terminals') {
          return Response.json({ terminals: [{ id: 'pty_from_http', kind: 'shell', alive: true }] });
        }
        return new Response('not-found', { status: 404 });
      },
    });
    const tok = join(dir, 'tok');
    writeFileSync(tok, 'http-token');
    const store = new RemotesStore();
    store.addRemote('iso', {
      host: 'iso',
      acp_url: `ws://127.0.0.1:${server.port}/v1/acp`,
      token_file: tok,
      addedAt: new Date(0).toISOString(),
    }, { setDefault: true });
    const stdout: string[] = [];
    const originalOut = process.stdout.write;
    process.stdout.write = ((chunk: string) => { stdout.push(chunk); return true; }) as typeof process.stdout.write;
    try {
      const cli = new Command();
      registerPtyTakeoverCommands(cli, {
        getPty: () => undefined,
        requestPtyTakeover: () => false,
        requestRemote: async () => ({ status: 'unknown-pty' as const }),
        log: () => {},
        remotesStore: () => store,
        listRefs: () => [{ id: 'pty_local_only', kind: 'shell', source: 'local', alive: true }],
      });
      await cli.parseAsync(['node', 'elanous', 'pty', 'list', '-r']);
      expect(seen).toEqual([{ path: '/v1/terminals', auth: 'Bearer http-token' }]);
      expect(stdout.join('')).toContain('pty_from_http');
      expect(stdout.join('')).not.toContain('pty_local_only');
      expect(process.exitCode).toBe(0);
    } finally {
      process.stdout.write = originalOut;
      process.exitCode = 0;
      server.stop(true);
    }
  });
});

describe('pty remote control -r / --remote grammar', () => {
  const controlDeps = (store: RemotesStore, postRemoteTerminalControl: NonNullable<PtyTakeoverCommandDeps['postRemoteTerminalControl']>, requestRemote = async () => ({ status: 'unknown-pty' as const })): PtyTakeoverCommandDeps => ({
    getPty: () => undefined, requestPtyTakeover: () => false, requestRemote, log: () => {}, remotesStore: () => store, postRemoteTerminalControl,
  });
  async function parseControl(args: readonly string[], deps: PtyTakeoverCommandDeps) {
    const stdout: string[] = []; const stderr: string[] = []; const originalOut = process.stdout.write; const originalErr = process.stderr.write;
    process.stdout.write = ((chunk: string) => { stdout.push(chunk); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => { stderr.push(chunk); return true; }) as typeof process.stderr.write;
    try { const cli = new Command(); registerPtyTakeoverCommands(cli, deps); await cli.parseAsync(['node', 'elanous', 'pty', ...args]); return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: process.exitCode }; }
    finally { process.stdout.write = originalOut; process.stderr.write = originalErr; process.exitCode = 0; }
  }
  test('pty text `-r` posts exact default-bookmark control URL and Enter body', async () => {
    const tok = join(dir, 'tok'); writeFileSync(tok, 'default-token'); const store = new RemotesStore(); store.addRemote('good', entry(31416, tok), { setDefault: true });
    const seen: Array<{ url: string; token: string; body: unknown }> = [];
    const result = await parseControl(['text', 'pty_r', 'hi', '--enter', '-r'], controlDeps(store, async (url, token, body) => { seen.push({ url, token, body }); return { ok: true, status: 200, json: { status: 'success' } }; }));
    expect(result.exitCode).toBe(0); expect(result.stdout).toContain('delivered to pty_r');
    expect(seen).toEqual([{ url: 'http://127.0.0.1:31416/v1/terminals/pty_r/control', token: 'default-token', body: { action: 'input-text', chars: 'hi\r' } }]);
  });
  test('pty key `--remote <name>` posts resolved repeated special key without local IPC', async () => {
    const tok = join(dir, 'tok'); writeFileSync(tok, 'named-token'); const store = new RemotesStore(); store.addRemote('lab', entry(31999, tok)); const seen: Array<{ url: string; body: unknown }> = []; let ipcCalls = 0;
    const result = await parseControl(['key', 'pty_r', 'enter', '-n', '2', '--remote', 'lab'], controlDeps(store, async (url, _token, body) => { seen.push({ url, body }); return { ok: true, status: 200, json: { status: 'success' } }; }, async () => { ipcCalls += 1; return { status: 'unknown-pty' as const }; }));
    expect(result.exitCode).toBe(0); expect(seen).toEqual([{ url: 'http://127.0.0.1:31999/v1/terminals/pty_r/control', body: { action: 'input-key', chars: '\r\r' } }]); expect(ipcCalls).toBe(0);
  });
  test('pty snapshot `--remote <name>` maps the returned remote screen', async () => {
    const tok = join(dir, 'tok'); writeFileSync(tok, 'named-token'); const store = new RemotesStore(); store.addRemote('lab', entry(31999, tok)); const seen: unknown[] = [];
    const result = await parseControl(['snapshot', 'pty_r', '--ansi', '--remote', 'lab'], controlDeps(store, async (_url, _token, body) => { seen.push(body); return { ok: true, status: 200, json: { status: 'success', screen: 'REMOTE SCREEN' } }; }));
    expect(result.exitCode).toBe(0); expect(result.stdout).toContain('REMOTE SCREEN'); expect(seen).toEqual([{ action: 'snapshot', ansi: true }]);
  });
  test.each([
    [404, 'unknown-pty', 'gone', /was not found/],
    [409, 'denied', 'write-arbiter', /denied/],
    [502, 'write-failed', 'adapter-write', /failed for pty_r \(adapter-write\)/],
    [504, 'owner-unreachable', 'owner-offline', /owner for pty_r is unreachable/],
  ] as const)('pty text maps HTTP %i JSON %s through mapResult', async (httpStatus, status, reason, message) => {
    const tok = join(dir, `tok-${httpStatus}`); writeFileSync(tok, 'named-token'); const store = new RemotesStore(); store.addRemote('lab', entry(31999, tok));
    const result = await parseControl(['text', 'pty_r', 'x', '--remote', 'lab'], controlDeps(store, async () => ({ ok: true, status: httpStatus, json: { status, reason } })));
    expect(result.exitCode).toBe(1); expect(result.stderr).toMatch(message);
  });
  test('pty text maps a live HTTP 404 JSON control response through mapResult', async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ status: 'unknown-pty', reason: 'gone' }, { status: 404 }) });
    const tok = join(dir, 'live-tok'); writeFileSync(tok, 'live-token'); const store = new RemotesStore();
    store.addRemote('live', entry(server.port!, tok), { setDefault: true });
    try {
      const result = await parseControl(['text', 'pty_r', 'x', '-r'], {
        getPty: () => undefined, requestPtyTakeover: () => false, requestRemote: async () => ({ status: 'unknown-pty' as const }), log: () => {}, remotesStore: () => store,
      });
      expect(result.exitCode).toBe(1); expect(result.stderr).toContain('pty_r was not found');
    } finally { server.stop(true); }
  });
  test.each([
    ['text', ['text', 'pty_r', 'x', '-r']],
    ['key', ['key', 'pty_r', 'enter', '-r']],
    ['snapshot', ['snapshot', 'pty_r', '-r']],
  ] as const)('pty %s `-r` names a missing default bookmark for that command and does not invoke local IPC', async (command, args) => {
    let ipcCalls = 0;
    const result = await parseControl(args, controlDeps(new RemotesStore(), async () => { throw new Error('must not post'); }, async () => { ipcCalls += 1; return { status: 'unknown-pty' as const }; }));
    expect(result.exitCode).toBe(1); expect(result.stderr).toContain(`pty ${command}: no default remote bookmark`); expect(ipcCalls).toBe(0);
  });
  test('pty key `-r` names remote and URL when transport throws without local IPC fallback', async () => {
    const tok = join(dir, 'tok'); writeFileSync(tok, 'default-token'); const store = new RemotesStore(); store.addRemote('good', entry(31416, tok), { setDefault: true }); let ipcCalls = 0;
    const result = await parseControl(['key', 'pty_r', 'enter', '-r'], controlDeps(store, async () => { throw new Error('offline'); }, async () => { ipcCalls += 1; return { status: 'unknown-pty' as const }; }));
    expect(result.exitCode).toBe(1); expect(result.stderr).toContain('good'); expect(result.stderr).toContain('http://127.0.0.1:31416/v1/terminals/pty_r/control'); expect(ipcCalls).toBe(0);
  });
  test.each([
    ['text', ['text', 'pty_r', 'x', '--remote', 'lab', '--actor', 'garbage']],
    ['key', ['key', 'pty_r', 'enter', '--remote', 'lab', '--actor', 'garbage']],
  ] as const)('pty %s validates actor before remote control transport', async (_command, args) => {
    const tok = join(dir, 'tok'); writeFileSync(tok, 'named-token'); const store = new RemotesStore(); store.addRemote('lab', entry(31999, tok));
    let postCalls = 0; let ipcCalls = 0;
    const result = await parseControl(args, controlDeps(store, async () => { postCalls += 1; return { ok: true, status: 200, json: { status: 'success' } }; }, async () => { ipcCalls += 1; return { status: 'unknown-pty' as const }; }));
    expect(result.exitCode).toBe(1); expect(result.stderr).toContain("--actor must be 'human' or 'agent' (got garbage)"); expect(postCalls).toBe(0); expect(ipcCalls).toBe(0);
  });
});
