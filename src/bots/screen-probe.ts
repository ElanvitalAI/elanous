/**
 * 🛰️ `screen-url.ts` 가 «묻는» 두 가지를 이 기계에 실제로 묻는 자리.
 *
 * ⛔ 순수 코어(`screen-url.ts`)와 «가른» 이유: 이 파일만 바깥(ssh·tailscale)에 닿는다.
 *    시험은 코어를 리터럴로 물고, 이 파일은 「명령이 «있나»」만 문제가 된다.
 * ⛔⭐ **「못 물었다」를 «빈 값»으로 접지 않는다** — 명령이 없거나 죽으면 `null` 을 낸다.
 *    빈 배열(`[]`)은 「물었는데 피어가 0」이고 `null` 은 「«못» 물었다」다. 그 둘이 다른 처방을 부른다.
 * 🧭 **묶임 선언**(`binding-intent`): ***«호스트»에 묶인다*** — 시간창·우주·상한을 쓰지 않는다.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTailnetPeers } from './screen-url.js';
import type { TailnetPeer, TailnetProbe } from './screen-url.js';

/** 데몬의 PATH 는 «좁다» — 그래서 후보를 «세어» 둔다(⛔ 하나만 박으면 조용히 못 문다). */
const TAILSCALE_CANDIDATES = [
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  'tailscale',
] as const;

/** 봇이 사는 기계의 ssh 별칭. `scripts/botlab/bot.sh` 와 «같은» 계약을 읽는다. */
export function botlabHostAlias(env: NodeJS.ProcessEnv = process.env): string {
  return env.BOTLAB_HOST?.trim() || 'gcpvm';
}

function run(file: string, args: readonly string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout);
    });
  });
}

/**
 * 🩸⭐⭐ **비정상 종료의 «말»을 버리지 않는 실행기.** — 2차 리뷰가 짚었고 실측이 그것을 확인했다:
 * ```
 * bash bot.sh 9 shot …  ⇒ rc=1 ⊕ 「⛔ 촬영 실패 — 화면 :9 이 없나?」
 * 옛 run()              ⇒ ***null***  ⇒ 내 자가 「답을 «안 냈다»(시한 20000ms)」라고 답했다
 * ```
 * ⇒ 🔑 ***도구가 «말했는데» 내가 안 듣고 「말 안 했다」로 옮겼다.*** 사람은 그 답을 보고 «엉뚱한 곳»을 본다
 *    (시한·네트워크를 뒤진다 — 진짜는 「화면이 없다」인데).
 * ⛔ 그래서 이 실행기는 셋을 «가른다»: 못 띄웠다/시한(`null`) · 돌았고 «말했다»(rc 무관하게 그 말) .
 */
export function runKeepingWords(file: string, args: readonly string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const said = `${stdout ?? ''}${stderr ?? ''}`.trim();
      // ⛔ 시한으로 «죽인» 것은 「말했다」가 아니다 — 그것만 null 로 남긴다.
      const killed = Boolean(err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed);
      if (killed) return resolve(null);
      // 못 띄웠으면(ENOENT 등) 말도 없다.
      if (err && said.length === 0) return resolve(null);
      resolve(said);
    });
  });
}

/** `ssh -G <별칭>` 의 `hostname` 줄. ⛔ 별칭이 없으면 ssh 가 «별칭 자신»을 낸다 — 그것도 답이다. */
async function sshHostname(alias: string, timeoutMs = 4000): Promise<string | null> {
  const out = await run('ssh', ['-G', alias], timeoutMs);
  if (out === null) return null;
  for (const line of out.split('\n')) {
    const match = /^hostname\s+(\S+)\s*$/.exec(line);
    if (match) return match[1];
  }
  return null;
}

/** 한 후보를 «돌려 본» 결과. `null` = 그 후보로는 못 물었다. */
export type CommandRunner = (file: string, args: readonly string[]) => Promise<string | null>;

/**
 * 후보를 «차례로» 써 본다. ⛔ 두 실패를 가른다:
 *   후보가 죽거나 산출이 status 꼴이 «아니면» ⇒ ***다음 후보로*** (그 후보가 딴 `tailscale` 일 수 있다)
 *   후보가 «답을 냈으면» ⇒ 그 답을 그대로 낸다 — «피어 0개»여도 그것은 «답»이다.
 * 🩸 5차 리뷰가 「이 되돌림 고리를 시험이 못 문다」고 지적해 실행기를 인자로 뺐다.
 */
export async function probeTailnetPeers(
  runner: CommandRunner,
  candidates: readonly string[] = TAILSCALE_CANDIDATES,
): Promise<readonly TailnetPeer[] | null> {
  for (const bin of candidates) {
    const out = await runner(bin, ['status', '--json']);
    if (out === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch {
      continue;
    }
    // ⛔ 푸는 일은 «순수 함수»에 맡긴다 — 그래야 「0개 ↔ 못 물었다」 갈림을 시험이 문다.
    const peers = parseTailnetPeers(parsed);
    if (peers === null) continue;
    return peers;
  }
  return null;
}

export const defaultTailnetProbe: TailnetProbe = {
  sshHostname: (alias) => sshHostname(alias),
  peers: () => probeTailnetPeers((file, args) => run(file, args, 6000)),
};

/**
 * 실행 결과 — ⛔ 「말」만으로는 «못 가르는» 것이 있어서 ***종료 코드를 남긴다***.
 * `null` = 못 띄웠다/시한.
 */
export interface RunOutcome {
  readonly code: number;
  readonly said: string;
}

/**
 * 🩸⭐ 2차 리뷰가 낳았다: ssh 실패를 «문면 목록»으로 잡으려 했더니 원리상 «불완전»했다
 *    (`kex_exchange_identification: … Connection reset by peer` 같은 꼴이 새 나간다) ⇒
 *    ***목록을 늘리는 대신 «종료 코드»를 가져온다.*** 그러면 판정이 «완전»해진다.
 */
export function runWithStatus(
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<RunOutcome | null> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const said = `${stdout ?? ''}${stderr ?? ''}`;
      const e = err as (Error & { killed?: boolean; code?: unknown }) | null;
      if (e?.killed) return resolve(null); // 시한으로 «죽인» 것
      if (!e) return resolve({ code: 0, said });
      // ⛔ `code` 가 «수»가 아니면 그것은 종료 코드가 아니라 시스템 오류(ENOENT 등)다 ⇒ 「못 띄웠다」.
      if (typeof e.code !== 'number') return resolve(null);
      resolve({ code: e.code, said });
    });
  });
}

/** 화면 한 장. ⛔ 「못 찍었다」를 «빈 버퍼»로 접지 않는다 — 사유를 단다. */
export type ScreenShot =
  | { readonly kind: 'ok'; readonly png: Buffer }
  | { readonly kind: 'failed'; readonly why: string };

/** 촬영 «뒤»에 손에 쥔 사실. ⛔ 판정과 바깥을 가르기 위해 이 꼴로 모은다. */
export interface ShotFacts {
  readonly toolFound: boolean;
  readonly scriptPath: string;
  /** 도구가 «낸 말». `null` = 답을 안 냈다(시한·실패). */
  readonly said: string | null;
  readonly timeoutMs: number;
  readonly fileExists: boolean;
  readonly bytes: number;
}

/**
 * 🧮 **순수 판정** — 「찍혔나」를 넷으로 가른다. ⛔ 넷이 «다른 처방»이라 한 문장으로 접지 않는다:
 *   도구 없음(트리가 안 맞는다) · 답 없음(시한·ssh) · 파일 없음(도구가 거짓말) · 0바이트.
 * 🩸 1차 리뷰가 「이 갈래들에 시험이 없다」고 짚어서 바깥과 갈랐다.
 */
export function judgeShot(facts: ShotFacts): { readonly kind: 'ok' } | { readonly kind: 'failed'; readonly why: string } {
  if (!facts.toolFound) {
    // ⛔ 「찍을 수 없다」가 아니라 ***「그 도구를 «못 찾았다»」***다 — 처방이 다르다.
    return { kind: 'failed', why: `촬영 도구를 «못 찾았다»: ${facts.scriptPath}` };
  }
  if (facts.said === null) {
    return { kind: 'failed', why: `bot.sh shot 이 «답을 안 냈다»(시한 ${facts.timeoutMs}ms)` };
  }
  if (!facts.fileExists) {
    // ⛔ 「찍었다는데」로 쓰지 않는다 — 그것은 「도구가 «성공이라 했다»」를 함의하는 «단정»이고,
    //    실제로는 도구가 실패를 «말했을» 수 있다(rc≠0 이어도 그 말을 이제 여기까지 가져온다).
    return { kind: 'failed', why: `찍힌 파일이 «없다» — 도구가 한 말: ${facts.said.trim().slice(0, 240) || '(아무 말도 안 했다)'}` };
  }
  // ⛔ 「0바이트」를 성공으로 읽지 않는다 — 이 저장소가 여러 번 밟은 그 꼴이다.
  if (facts.bytes === 0) return { kind: 'failed', why: '찍힌 파일이 «0바이트»다' };
  return { kind: 'ok' };
}

/**
 * 요청마다 «제 방»을 판다. ⛔ 봇번호+PID 로는 «같은 프로세스의 두 요청»이 서로를 덮는다(1차 리뷰).
 * ⚠️ 부르는 쪽이 반드시 `rmSync` 로 치운다.
 */
export function makeShotDir(botNumber: number): string {
  return mkdtempSync(join(tmpdir(), `elanous-bot${botNumber}-shot-`));
}

/**
 * 🖼️ 봇 화면을 «찍는다». ⛔⭐ **새 캡처기를 «짓지 않는다»** — `scripts/botlab/bot.sh <N> shot` 이
 *    이미 그 일(원격 `scrot` ⊕ 회수)을 하고, 그 파일이 「화면 :N 이 없다」까지 «말한다».
 *    ⇒ 여기서 ssh·scrot 를 다시 쓰면 그 말이 «두 벌»이 되고 한 벌이 늙는다.
 * 📏 실측(2026-09-01): 0.67초 · 58KB ⇒ 채팅에서 «자리표시자 없이» 답할 수 있다.
 * 🧭 묶임 선언(`binding-intent`): ***«호스트»에 묶인다*** — 시간창·우주·상한을 쓰지 않는다.
 */
export async function captureBotScreen(botNumber: number, timeoutMs = 25_000): Promise<ScreenShot> {
  const script = join(import.meta.dir, '../../scripts/botlab/bot.sh');
  const toolFound = existsSync(script);
  if (!toolFound) return judgeShot({ toolFound, scriptPath: script, said: null, timeoutMs, fileExists: false, bytes: 0 }) as ScreenShot;
  // ⛔ 봇번호+pid 로는 «같은 프로세스의 두 요청»이 서로를 덮는다(1차 리뷰) ⇒ 요청마다 «제 방»을 판다.
  const dir = makeShotDir(botNumber);
  const out = join(dir, 'screen.png');
  try {
    const said = await runKeepingWords('bash', [script, String(botNumber), 'shot', out], timeoutMs);
    // ⛔⭐ 읽기가 «던지면» 사람은 사진 대신 스택 트레이스를 본다(6차 리뷰) — 권한·TOCTOU·경로가 디렉터리.
    //    ⇒ 그 예외도 ***사람용 진단***으로 접는다. 「없다」와 「못 읽었다」를 «다른 문면»으로.
    let png = Buffer.alloc(0);
    let fileExists = false;
    try {
      fileExists = existsSync(out);
      if (fileExists) png = readFileSync(out);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return { kind: 'failed', why: `찍힌 파일을 «못 읽었다»: ${why.slice(0, 200)}` };
    }
    const verdict = judgeShot({ toolFound, scriptPath: script, said, timeoutMs, fileExists, bytes: png.length });
    return verdict.kind === 'ok' ? { kind: 'ok', png } : verdict;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 치우기 실패는 판정을 바꾸지 않는다 */
    }
  }
}

/**
 * ⏰ crontab 한 덩이를 «묻는다». ⛔ 셋을 가른다:
 *   `null`  = 못 물었다(명령이 죽었거나 ssh 가 안 됐다)
 *   `''`    = 크론탭이 «비었다»(물어서 확인했다 — 「못 물었다」와 «다른 값»)
 *   그 밖   = 산출
 * ⛔ `crontab -l` 은 예약이 «하나도 없으면» rc≠0 ⊕ 「no crontab for …」를 낸다 —
 *    그것은 «실패»가 아니라 ***답***이다. 그래서 말을 남기는 실행기를 쓴다.
 * 🧭 묶임 선언(`binding-intent`): ***«호스트»에 묶인다***.
 */
export async function readCrontab(
  sshAlias: string | null,
  timeoutMs = 12_000,
  runner: typeof runWithStatus = runWithStatus,
): Promise<string | null> {
  const out =
    sshAlias === null
      ? await runner('crontab', ['-l'], timeoutMs)
      : await runner('ssh', ['-o', 'ConnectTimeout=8', sshAlias, 'crontab -l'], timeoutMs);
  return interpretCrontab(out);
}

/**
 * 📈⭐⭐ **종목 하나를 그 봇 화면에 «그림으로»** — 2026-09-01 · 42차.
 *
 * 🚨 계기(대표): *"텔레그램, PWA 에서 그냥 메뉴가 있고 눌러야 하는 수준 아니면 슬래시 명령어로 아니면 NL 로"*
 *    ⇒ 그리기 축이 «터미널에만» 있었다. ***이 저장소가 늘 고치는 그 병을 내 안내가 저질렀다.***
 * ⛔ 새 로직을 «안 만든다» — `scripts/botlab/chart-symbol.ts` 를 프로세스로 부른다
 *    (41차의 `captureBotScreen` 이 `bot.sh` 를 부르는 것과 «같은 꼴»).
 * ⛔ `'bun'` 을 PATH 에서 찾지 «않는다» — `process.execPath`(지금 나를 돌리는 실행기)를 쓴다.
 */
export type ChartSymbolResult =
  | { kind: 'ok'; said: string }
  | { kind: 'failed'; why: string };

/**
 * 🗣️ `chart-symbol.ts` 가 «한 말»을 셋으로 가른다. 순수.
 * ⛔ `runKeepingWords` 는 rc 를 «안 준다» — 셋을 가르는 것은 「무슨 말을 했나」다:
 *    `null`(못 띄웠거나 시한) · `⛔`로 시작(그 도구가 «스스로» 실패라 말했다) · 그 밖(성공).
 * 🔑 41차의 그 규율 그대로 — ***도구가 «한 말»을 버리지 않는다.***
 */
export function interpretChartSaid(said: string | null): ChartSymbolResult {
  if (said === null) {
    return { kind: 'failed', why: '차트 도구가 «답을 안 냈다» — 못 띄웠거나 시한을 넘겼다' };
  }
  const trimmed = said.trim();
  if (trimmed.length === 0) return { kind: 'failed', why: '차트 도구가 «아무 말도 안 했다»' };
  if (trimmed.startsWith('⛔')) return { kind: 'failed', why: trimmed.slice(0, 400) };
  return { kind: 'ok', said: trimmed };
}

export async function runChartSymbol(
  input: { readonly symbol: string; readonly port: number; readonly from: string; readonly id: string },
  timeoutMs = 180_000,
  runner: typeof runKeepingWords = runKeepingWords,
): Promise<ChartSymbolResult> {
  // ⛔ `bot.sh` 를 찾는 것과 «같은 꼴» — 이 파일 기준 상대 경로다(cwd 에 안 묶인다).
  const script = join(import.meta.dir, '../../scripts/botlab/chart-symbol.ts');
  return interpretChartSaid(await runner(process.execPath, [
    script, input.symbol, '--port', String(input.port), '--from', input.from, '--id', input.id,
  ], timeoutMs));
}

/**
 * 🕐⭐⭐ **그 기계의 UTC 오프셋을 «분»으로 묻는다** (2026-09-01 · 42차).
 *
 * 🩸 계기: crontab 은 ***그 기계의 시간대***로 해석되는데 `/routines` 는 그것을 «안 물었다».
 *    ⇒ 맥(KST)의 `50 7` 과 VM(UTC)의 `50 7` 이 «똑같이» 보였고, 실제로는 9시간 어긋났다.
 * 📏 그리고 ***`CRON_TZ=Asia/Seoul` 로는 못 고친다*** — 실측(gcpvm · cron 3.0pl1-184ubuntu2):
 *    설치 뒤 syslog 에 `RELOAD` 가 났는데도 그 시각에 «안 터졌다». cron 이 «조용히 무시»한다.
 *    ⇒ 처방은 그 기계 시간대로 «환산한 시각»을 쓰는 것이고, 그러려면 오프셋을 «알아야» 한다.
 *
 * ⛔ `null` = 못 물었다. ***0(UTC)과 «다른 값»이다*** — 이 축이 늘 밟는 그 자리다.
 * 🧭 묶임 선언(`binding-intent`): ***«호스트»에 묶인다*** — 시간대는 「이 기계가 몇 시인가」다.
 */
export async function readHostTzOffsetMinutes(
  sshAlias: string | null,
  timeoutMs = 12_000,
  runner: typeof runWithStatus = runWithStatus,
): Promise<number | null> {
  const out =
    sshAlias === null
      ? await runner('date', ['+%z'], timeoutMs)
      : await runner('ssh', ['-o', 'ConnectTimeout=8', sshAlias, 'date +%z'], timeoutMs);
  return interpretTzOffset(out);
}

/**
 * 🕐 `date +%z`(`+0900` · `-0430` · `+0000`)를 «분»으로. 순수 조각.
 * ⛔ 배너·MOTD 가 섞일 수 있으므로 ***마지막 비어 있지 않은 줄***을 본다 —
 *    그리고 그 줄 «전체»가 그 꼴이어야 한다(부분문자열로 보면 아무 숫자나 통과한다).
 */
export function interpretTzOffset(out: { readonly code: number; readonly said: string } | null): number | null {
  if (out === null || out.code !== 0) return null;
  const lines = out.said.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const last = lines.at(-1);
  if (last === undefined) return null;
  const m = /^([+-])(\d{2})(\d{2})$/.exec(last);
  if (m === null) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  // ⛔ 지구상 오프셋은 ±14시간을 넘지 않는다 — 넘으면 그 줄은 시간대가 «아니다».
  if (minutes > 14 * 60) return null;
  return m[1] === '-' ? -minutes : minutes;
}

/**
 * ⏰ **`crontab -l` 의 «결과»를 세 값으로 읽는다** — 순수 조각(2026-09-01 · `D4b`).
 *
 * 🔑 왜 갈라 냈나: 아침 판정기(`morning-verdict.ts`)가 «동기»로 같은 판단을 해야 하는데,
 *    ***이 화이트리스트를 복제하면 두 자리가 «따로» 늙는다*** — 한쪽만 고친 날 거짓 초록이 난다.
 * ⇒ 실행(비동기 ssh)과 «해석»을 가른다. 해석은 이 함수 하나뿐이다.
 */
export function interpretCrontab(out: { readonly code: number; readonly said: string } | null): string | null {
  if (out === null) return null;
  if (out.code === 0) return out.said;
  // ⛔⭐⭐ rc≠0 에서 「비었다」로 «인정»하는 것은 ***오직 이 한 문면***이다.
  //    🩸 2차 리뷰: 옛 판은 ssh 실패를 «문면 목록»으로 걸러 냈는데 그것은 원리상 «불완전»하고
  //       (`kex_exchange_identification: …` 이 새 나간다) 새 나간 문면은 「예약 0개」라는 ***거짓 초록***이 된다.
  //    ⇒ 이제 «화이트리스트»다: 이 문면이 아니면 rc≠0 은 전부 「못 물었다」.
  // ⛔⭐ ***부분문자열로 보지 않는다***(3차 리뷰) — ssh 배너·MOTD 에 그 낱말이 섞이면
  //    rc≠0 «실패»가 「빈 크론탭」으로 둔갑한다. ⇒ 다듬은 산출이 ***그 한 줄 «전체»***여야 한다.
  //    📏 실측(2026-09-01 · 원격 노드): 정확히 `no crontab for <user>\n` ⊕ rc=1.
  //       (macOS 는 `crontab: ` 접두를 붙이는 판이 있어 그것만 허용한다)
  if (/^(crontab: )?no crontab for \S+$/i.test(out.said.trim())) return '';
  return null;
}
