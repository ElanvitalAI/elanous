#!/usr/bin/env bun
// 텔레그램 무인 테스트 주입 (GramJS 유저봇 · #24 인시던트 후 · 2026-07-21)
//
// 목적: 에이전트/스크립트가 **유저 계정으로** elanous 봇에게 objective 를 무인 전송 → 데몬이 처리.
//   Bot API `sendMessage` 로는 봇 자기트리거 불가(bot-to-bot 서버 차단) → MTProto userbot(GramJS)만 가능.
//   유저 계정으로 보내므로 **그 계정의 텔레그램 앱에도 대화가 보인다**(무인 주입 + 사람 관찰 동시).
//
// 셋업: 내부 문서 `MANUAL-telegram-unmanned-test-2026-07-21` 참조.
//   ① https://my.telegram.org/apps 에서 API_ID/API_HASH 발급
//   ② TELEGRAM_API_ID / TELEGRAM_API_HASH env 설정
//   ③ `bun scripts/telegram-inject.ts --login` → 전화+코드 인증 → SESSION STRING 출력 → TELEGRAM_USER_SESSION 저장
//   ④ `bun scripts/telegram-inject.ts --to @monad_test_bot --text "<objective>"` → 무인 주입
//
// ⚠️ 보안: SESSION STRING = 계정 접근권. git 커밋 금지·안전 저장(예: .elanous-test config·env). API_HASH 도 비밀.

import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { createInterface } from 'node:readline/promises';
import { parseInjectArgs } from './lib/telegram-inject-args.js';

const args = process.argv.slice(2);
const has = (f: string): boolean => args.includes(f);
const val = (f: string): string | undefined => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}

const apiId = Number(process.env.TELEGRAM_API_ID ?? val('--api-id') ?? 0);
const apiHash = process.env.TELEGRAM_API_HASH ?? val('--api-hash') ?? '';

// ★ config fallback(#24 후속·2026-07-22 role 확장) — `--to`/env 미지정 시 user-config 의 봇
//   username 을 대상으로 쓴다. 우선순위: --to > env(TELEGRAM_TEST_BOT) > --role(운영 채널 조회) >
//   testChannel.botUsername > 임의 channels[].botUsername. fail-soft(config 없거나 로드 실패면 무시).
//   `--role mission` → 운영 config 의 해당 role 채널 봇(예: example_monad_bot). 이로써 봇 username 을
//   config 한 곳에서 관리(운영 봇은 channels[].botUsername·테스트 봇은 테스트 config 의 testChannel).
let configBot: string | undefined;
try {
  const { getUserConfig } = await import('../src/user-config.js');
  const tg = getUserConfig().telegram;
  const role = val('--role');
  if (role) configBot = tg?.channels?.find((c) => c.roles?.includes(role))?.botUsername;
  configBot = configBot
    ?? tg?.testChannel?.botUsername
    ?? tg?.channels?.find((c) => c.botUsername)?.botUsername;
} catch { /* config 미존재/로드 실패 — --to/env 만 사용 */ }
if (!apiId || !apiHash) {
  console.error('❌ API_ID/API_HASH 필요 — env TELEGRAM_API_ID/TELEGRAM_API_HASH 또는 --api-id/--api-hash.');
  console.error('   발급: https://my.telegram.org/apps (전화 로그인 → API development tools → 앱 생성).');
  process.exit(2);
}

if (has('--login')) {
  // 1회 인증 → SESSION STRING 출력(이후 무인).
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
  await client.start({
    phoneNumber: async () => ask('전화번호 (+82... 국가코드 포함): '),
    phoneCode: async () => ask('텔레그램 앱으로 온 로그인 코드: '),
    password: async () => ask('2FA 비밀번호 (없으면 엔터): '),
    onError: (e) => console.error('로그인 오류:', e),
  });
  console.log('\n✅ 로그인 성공. 아래 SESSION STRING 을 TELEGRAM_USER_SESSION 에 저장하면 이후 무인:\n');
  console.log('  ' + (client.session.save() as unknown as string));
  console.log('\n⚠️ 이 문자열은 계정 접근권 — git 커밋 금지·안전 저장.');
  await client.disconnect();
  process.exit(0);
}

// --check: SESSION STRING 유효성 확인(getMe) — 3번(인증)까지 잘 됐는지 검증. 메시지 전송 안 함.
if (has('--check')) {
  const sessionStr = process.env.TELEGRAM_USER_SESSION ?? val('--session');
  if (!sessionStr) { console.error('❌ TELEGRAM_USER_SESSION 없음 — 먼저 `--login`.'); process.exit(2); }
  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();
  const me = await client.getMe() as { firstName?: string; username?: string; phone?: string; id?: unknown };
  const authed = await client.checkAuthorization();
  console.log(`✅ 세션 유효 — 로그인됨: ${me.firstName ?? '?'}${me.username ? ` (@${me.username})` : ''} · authorized=${authed}`);
  console.log('   → 4번 무인 주입 준비 완료: `--to @<bot> --text "<objective>"`');
  await client.disconnect();
  process.exit(0);
}

// --read: 봇과의 대화(봇 응답 포함)를 직접 읽는다(#24 후속·완전 무인 왕복). getMessages 히스토리.
//   → 사람에게 "봇이 뭐라 답했나" 부탁 없이 에이전트가 텔레그램 내용을 직접 read(elanous session 의 텔레그램판).
if (has('--read')) {
  const sess = process.env.TELEGRAM_USER_SESSION ?? val('--session');
  const from = val('--from') ?? val('--to') ?? process.env.TELEGRAM_TEST_BOT ?? configBot;
  const limit = Number(val('--limit') ?? 12);
  if (!sess) { console.error('❌ TELEGRAM_USER_SESSION 없음.'); process.exit(2); }
  if (!from) { console.error('사용: --read --from @<bot> [--limit N]'); process.exit(2); }
  const client = new TelegramClient(new StringSession(sess), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();
  const messages = await client.getMessages(from, { limit });   // 최신순
  console.log(`\n═══ ${from} 대화 (최근 ${messages.length}) ═══`);
  for (const m of [...messages].reverse()) {                    // 시간순
    const who = (m as { out?: boolean }).out ? '나(주입)' : '봇';
    const ts = new Date(((m as { date?: number }).date ?? 0) * 1000).toISOString().slice(11, 19);
    const text = (m as { message?: string }).message ?? '';
    const media = describeMedia((m as { media?: unknown }).media);
    // ⛔ 「첨부가 있다」와 「글이 있다」를 «다른 칸»으로 낸다 — 캡션이 있으면 첨부가 «가려진다».
    const body = [media, text.replace(/\n/g, ' ⏎ ')].filter((v) => v !== '').join(' ') || '(비텍스트·첨부 없음)';
    // --full: 절단 없이(긴 에러 원문·BotFather 토큰 등 · 2026-09-25 무인 봇 생성 때 400자 절단이 토큰을 잘랐다).
    console.log(`[${ts}] ${who}: ${has('--full') ? body : body.slice(0, 400)}`);
  }
  await client.disconnect();
  process.exit(0);
}

/**
 * 🖼️⛔⭐⭐ **「첨부가 «실제로» 붙어 왔나」를 무인으로 가른다** (2026-09-02 · 43차 · 대표 물음)
 *
 * 🚨 계기 — 대표: *"뉴스봇 포토 내용 텔레그램 «무인»으로 확인이 되나요?"* ⇒ 재 보니 ***안 됐다***:
 * ```
 * 옛 자: m.message ?? '(비텍스트/미디어)'
 * ⇒ ***캡션이 있는 사진***은 「글」과 «한 글자도 다르지 않게» 찍힌다.
 *   📏 실물(42차의 /chart 회차): 「🖼️ Botlab 4 — 화면 :4 · <ts>」 — 이것이 사진인지 글인지 «못 가른다».
 * ```
 * 🔑 그리고 봇 자신이 그 한계를 «말하고» 있었다 — *「⚠️ 사진이 «안 보이면» 전송이 실패한 것입니다 —
 *    이 답은 그 성패를 «모릅니다»」*. ⇒ ***보낸 쪽도 모르고 읽는 쪽도 몰랐다.***
 *
 * ⇒ ✅ 첨부를 «따로 한 칸»으로 낸다. ⛔ 내용은 «안» 낸다 — 종류와 «크기»만(그것이 판정에 필요한 전부다).
 * ⛔ 「없다」와 「모르는 종류」를 섞지 않는다 — 모르면 클래스 이름을 «그대로» 낸다.
 */
/**
 * 🔢⛔ **자리 구분을 «기계 지역»에 맡기지 않는다** (자기 리뷰 should-fix).
 * 🚨 `toLocaleString()` 은 실행 환경 locale 을 탄다 — 어떤 곳은 `111.135`, 어떤 곳은 `111 135` 다.
 *    ⇒ 이 산출은 ***에이전트가 읽는다*** — 자리 구분이 기계마다 달라지면 그 파싱이 조용히 깨진다.
 * ⇒ `en-US` 로 «못 박는다». ⛔ 「보기 좋게」가 아니라 「어디서든 같게」가 이유다.
 */
function groupBytes(n: number): string {
  return n.toLocaleString('en-US');
}

export function describeMedia(media: unknown): string {
  if (media === undefined || media === null) return '';
  const kind = String((media as { className?: unknown }).className ?? 'Unknown');
  if (kind === 'MessageMediaPhoto') {
    // 📏 크기는 사진의 «가장 큰» 조각에서 — 없으면 지어내지 않고 종류만 낸다.
    const sizes = (media as { photo?: { sizes?: Array<{ size?: number; sizes?: number[] }> } }).photo?.sizes ?? [];
    const bytes = sizes.reduce<number>((max, s) => {
      const direct = typeof s?.size === 'number' ? s.size : 0;
      const stepped = Array.isArray(s?.sizes) && s.sizes.length > 0 ? Math.max(...s.sizes) : 0;
      return Math.max(max, direct, stepped);
    }, 0);
    return bytes > 0 ? `[📷 사진 ${groupBytes(bytes)}B]` : '[📷 사진]';
  }
  if (kind === 'MessageMediaDocument') {
    const doc = (media as { document?: { mimeType?: string; size?: unknown } }).document ?? {};
    const size = typeof doc.size === 'number' ? doc.size : Number(doc.size ?? 0);
    const mime = doc.mimeType ?? '알 수 없는 형식';
    return Number.isFinite(size) && size > 0 ? `[📎 ${mime} ${groupBytes(size)}B]` : `[📎 ${mime}]`;
  }
  if (kind === 'MessageMediaWebPage') return '[🔗 링크 미리보기]';
  return `[첨부:${kind}]`;
}

// --buttons / --click / --react: 부가 UX(HITL 승인 버튼·Q&A·리액션) 무인 조작(#24 후속).
//   무인 HITL — 봇이 보낸 "PR 열까요?" inline 버튼을 에이전트가 직접 클릭. clarify Q&A 도 동일.
if (has('--buttons') || has('--click') || has('--react')) {
  const sess = process.env.TELEGRAM_USER_SESSION ?? val('--session');
  const from = val('--from') ?? val('--to') ?? process.env.TELEGRAM_TEST_BOT ?? configBot;
  if (!sess) { console.error('❌ TELEGRAM_USER_SESSION 없음.'); process.exit(2); }
  if (!from) { console.error('사용: --buttons|--click|--react --from @<bot> [...]'); process.exit(2); }
  const client = new TelegramClient(new StringSession(sess), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();
  const messages = await client.getMessages(from, { limit: Number(val('--limit') ?? 15) });
  // 최근 봇 메시지 중 inline 버튼(reply_markup) 있는 것.
  const withButtons = messages.find((m) => !(m as { out?: boolean }).out && (m as { replyMarkup?: unknown }).replyMarkup);

  if (has('--buttons')) {
    // reply_markup 버튼 read (HITL 승인/Q&A 옵션 확인).
    if (!withButtons) { console.log('최근 봇 메시지에 inline 버튼 없음.'); }
    else {
      const rm = (withButtons as { replyMarkup?: { rows?: Array<{ buttons?: Array<{ text?: string; data?: Uint8Array; url?: string }> }> } }).replyMarkup;
      console.log(`\n═══ 봇 메시지(id=${(withButtons as { id?: number }).id}) 버튼 ═══`);
      for (const row of rm?.rows ?? []) for (const b of row.buttons ?? []) {
        console.log(`  [${b.text}]${b.url ? ` url=${b.url}` : b.data ? ' (callback)' : ''}`);
      }
    }
  }
  if (has('--click')) {
    // HITL 승인 버튼 무인 클릭 — --button "Yes" (텍스트로).
    const label = val('--button');
    if (!withButtons) { console.error('클릭할 버튼 있는 봇 메시지 없음.'); process.exit(1); }
    const res = await (withButtons as unknown as { click: (o: { text?: string }) => Promise<{ message?: string } | undefined> })
      .click(label ? { text: label } : {});
    console.log(`✅ 버튼 클릭 완료${label ? ` ("${label}")` : ''}. 봇 콜백 응답: ${res?.message ?? '(없음)'}`);
  }
  if (has('--react')) {
    // 리액션(이모지) — --emoji 👍. 최근 봇 메시지에.
    const target = messages.find((m) => !(m as { out?: boolean }).out) ?? messages[0];
    const emoji = val('--emoji') ?? '👍';
    await client.invoke(new Api.messages.SendReaction({
      peer: from, msgId: (target as { id?: number }).id ?? 0,
      reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
    }));
    console.log(`✅ 리액션 ${emoji} 전송(msgId=${(target as { id?: number }).id}).`);
  }
  await client.disconnect();
  process.exit(0);
}

// 무인 주입: SESSION STRING 으로 로그인 → 봇에게 메시지.
const sessionStr = process.env.TELEGRAM_USER_SESSION ?? val('--session');
if (!sessionStr) { console.error('❌ TELEGRAM_USER_SESSION 필요 — 먼저 `--login` 으로 발급.'); process.exit(2); }
let inject: ReturnType<typeof parseInjectArgs>;
try {
  inject = parseInjectArgs(args, { TELEGRAM_TEST_BOT: process.env.TELEGRAM_TEST_BOT ?? configBot });
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}
const { to, text, photos, caption } = inject;
const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, { connectionRetries: 5 });
await client.connect();
const msg = photos.length > 0
  ? await client.sendFile(to, { file: photos.length === 1 ? photos[0]! : photos, caption })
  : await client.sendMessage(to, { message: text! });
const sent = Array.isArray(msg) ? msg[0] : msg;
console.log(`✅ 주입 완료 → ${to} (msgId=${(sent as { id?: number } | undefined)?.id ?? '?'}). 이 계정의 텔레그램 앱에도 대화가 보입니다.`);
console.log('   → 데몬 처리 후 watchdog 검증: log/watchdog-stall.log (stall 없으면 A subprocess 격리 정상).');
await client.disconnect();
process.exit(0);
