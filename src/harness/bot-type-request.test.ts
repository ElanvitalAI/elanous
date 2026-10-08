import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { judgeTypeRequest, TYPE_TEXT_MAX, type TypeTarget } from './bot-type-request.js';

const HOSTS = ['news.ycombinator.com'];
const target = (over: Partial<TypeTarget> = {}): TypeTarget => ({
  tag: 'input', type: 'text', name: 'q', id: null, contentEditable: false, inForm: true, ...over,
});
const judge = (over: Partial<Parameters<typeof judgeTypeRequest>[0]> = {}) => judgeTypeRequest({
  url: 'https://news.ycombinator.com/', selector: '#q', text: 'ai news',
  actionHosts: HOSTS, armed: true, target: target(), ...over,
});

describe('⌨️ judgeTypeRequest — 「이 칸에 이 글을 쳐도 되나」', () => {
  test('✅ 통과하면 «무엇을 어디에» 쳤는지 말한다 ⊕ 폼 안이면 그 사실도', () => {
    const v = judge();
    expect(v.allowed).toBe(true);
    expect(v.reason).toContain('news.ycombinator.com');
    // ⭐ 폼 «안»은 거부 사유가 «아니라» 말할 값이다 — 제출은 «다른 관문»이 막는다.
    expect(v.reason).toContain('제출 버튼은 여전히 못 누른다');
  });

  test('⛔ 무장하지 않으면 안 친다 — 클릭과 «같은» 문턱이다', () => {
    expect(judge({ armed: false }).allowed).toBe(false);
  });

  test('⛔ 경계 밖 ⊕ http(s) 가 아닌 스킴은 거부한다', () => {
    expect(judge({ url: 'https://evil.test/' }).allowed).toBe(false);
    // 🪞 오늘 아침에 배운 것 — 호스트가 «같아도» 스킴이 다르면 다른 것이다.
    expect(judge({ url: 'javascript://news.ycombinator.com/x' }).allowed).toBe(false);
    expect(judge({ url: 'about:blank' }).allowed).toBe(false);
  });

  test('⛔ 빈 경계는 «전부 허용»이 아니다(fail-closed)', () => {
    expect(judge({ actionHosts: [] }).allowed).toBe(false);
  });

  test('⛔ 대상을 «못 읽으면» 안 친다 — 「모른다」를 「괜찮다」로 읽지 않는다', () => {
    const v = judge({ target: null });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('모르는 곳에는');
  });

  test('⛔⭐⭐ 비밀번호·자격 칸은 «절대» 거부 — type 이든 «이름»이든', () => {
    expect(judge({ target: target({ type: 'password' }) }).allowed).toBe(false);
    for (const name of ['user_pwd', 'apiToken', 'card_cvc', 'my-secret', 'passphrase']) {
      const v = judge({ target: target({ name }) });
      expect(v.allowed).toBe(false);
      expect(v.reason).toContain('자격으로 보이는');
    }
  });

  test('⛔ 칠 수 «없는» 칸은 거부 — 무엇이 일어날지 모른다', () => {
    for (const t of [target({ tag: 'button', type: null }), target({ type: 'checkbox' }),
      target({ type: 'file' }), target({ tag: 'div', contentEditable: false, type: null })]) {
      expect(judge({ target: t }).allowed).toBe(false);
    }
    // ✅ textarea · contenteditable 은 «칠 수 있다».
    expect(judge({ target: target({ tag: 'textarea', type: null }) }).allowed).toBe(true);
    expect(judge({ target: target({ tag: 'div', type: null, contentEditable: true }) }).allowed).toBe(true);
  });

  test('⛔⭐ 개행은 «제출과 같다» — 그래서 금지한다', () => {
    for (const text of ['ai\nnews', 'ai\r\nnews', 'ai\r']) {
      const v = judge({ text });
      expect(v.allowed).toBe(false);
      expect(v.reason).toContain('개행');
    }
  });

  test('⛔ 빈 글 ⊕ 상한 — 긴 글은 «타이핑»이 아니다', () => {
    expect(judge({ text: '   ' }).allowed).toBe(false);
    expect(judge({ text: 'x'.repeat(TYPE_TEXT_MAX) }).allowed).toBe(true);
    expect(judge({ text: 'x'.repeat(TYPE_TEXT_MAX + 1) }).allowed).toBe(false);
  });

  test('⛔ 하위 도메인은 되고 «접미 흉내»는 안 된다', () => {
    expect(judge({ url: 'https://blog.news.ycombinator.com/' }).allowed).toBe(true);
    expect(judge({ url: 'https://news.ycombinator.com.attacker.test/' }).allowed).toBe(false);
  });
});

// 🧭 드라이버는 `scripts/botlab/bot-type.ts` 에 남았고 이 시험만 #20345 에서 `src/harness/` 로 옮겨졌다
//    (옛 `./bot-type.ts` 는 ENOENT 로 파일 전체를 [error] 로 만들었다). 공개본은 `scripts/botlab/**` 를
//    빼므로(release/public-export.yaml) 그때만 계약 시험을 건너뛴다.
const BOT_TYPE_DRIVER = new URL('../../scripts/botlab/bot-type.ts', import.meta.url).pathname;

describe.skipIf(!existsSync(BOT_TYPE_DRIVER))('🔒 드라이버의 «계약» — 안전 주장이 코드에서 조용히 무너지지 못하게', () => {
  const RAW = existsSync(BOT_TYPE_DRIVER) ? readFileSync(BOT_TYPE_DRIVER, 'utf8') : '';
  /**
   * ⛔⭐ **주석을 «빼고» 본다** — 첫 판은 `/json/new` 와 `process.exit(` 를
   *    ***「그것을 쓰지 마라」고 적은 주석»***에서 찾아 «거짓 빨강»을 냈다.
   *    🪞 오늘 두 번째 같은 실수다(`늦은갈래` · `tabs(못 읽음)`) — ***낱말이 아니라 «코드»를 물어야 한다.***
   */
  //    ⛔⭐ 그리고 `//.*$` 로 지우면 ***`http://` 의 슬래시 둘***을 주석으로 먹는다(첫 판이 그랬다).
  //       ⇒ ***줄 «전체»가 주석일 때만*** 지운다.
  const CODE = RAW.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const SRC = CODE;
  /** 🪵 로그 싱크를 «켠 뒤»의 구간 — 그 앞의 `process.exit` 는 남길 관측이 «없다». */
  const AFTER_SINK = CODE.slice(CODE.indexOf('enableLogStore();'));

  test('⛔⭐⭐ 키 이벤트를 «안» 보낸다 — Enter 를 보낼 길을 «아예 안 만든다»', () => {
    /**
     * 🚨 지금까지 이 주장은 ***«주석의 약속»***이었다.
     *    ⇒ 누가 `dispatchKeyEvent` 한 줄을 더하면 ***제출 금지가 조용히 무너진다***
     *      (관문은 「글」만 보고 「키」는 안 본다).
     * 🔑 그래서 ***그 낱말이 이 파일에 «없다»***를 시험이 문다.
     */
    expect(SRC).not.toContain('dispatchKeyEvent');
    expect(SRC).not.toContain('Input.dispatchKey');
    // ✅ 그리고 «쓰는 것»은 insertText 하나뿐이다.
    expect(SRC).toContain("'Input.insertText'");
    expect(SRC.match(/'Input\.[A-Za-z]+'/g) ?? []).toEqual(["'Input.insertText'"]);
  });

  test('⛔⭐ 새 탭을 «안 만든다» — 카나리아 `tabs`(정확히 1)를 깨뜨리면 안 된다', () => {
    expect(SRC).not.toContain('/json/new');
    expect(SRC).not.toContain('createPageTarget');
    // ✅ «있는» 페이지에 붙는다.
    expect(SRC).toContain('/json/list');
  });

  test('⛔⭐ `process.exit()` 를 안 부른다 — 관측이 flush 되기 «전»에 죽는다', () => {
    // 🚨 실측(38차): debug.log 뒤에 process.exit 를 불러 스토어 281개 전수에 ***0건***이었다.
    //    ⇒ 제1원칙(「관측을 반드시 남긴다」)이 그 원칙을 쓰려고 만든 도구에서 깨졌다.
    // ⛔ 「싱크를 켠 뒤」에만 금지한다 — 인자 오류로 죽는 자리는 남길 관측이 «없다».
    expect(AFTER_SINK).not.toContain('process.exit(');
    expect(SRC).toContain('process.exitCode');
  });

  test('⛔ 관문을 «거치지 않는» 길이 없다 — insertText 는 judge 뒤에만 나온다', () => {
    const judgeAt = SRC.indexOf('judgeTypeRequest({');
    const typeAt = SRC.indexOf("'Input.insertText'");
    expect(judgeAt).toBeGreaterThan(-1);
    expect(typeAt).toBeGreaterThan(judgeAt);
  });

  test('⛔ 관측을 «남긴다» — 받은 것도 거부한 것도', () => {
    expect(SRC).toContain("debug.log('botlab.type', verdict.allowed ? 'allowed' : 'refused'");
    expect(SRC).toContain("debug.log('botlab.type', landed ? 'typed' : 'typed-unverified'");
  });
});
