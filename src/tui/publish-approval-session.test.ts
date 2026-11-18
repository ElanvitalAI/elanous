import { expect, test } from 'bun:test';
import { createPublishApprovalHost, createPublishApprovalSession, formatRemaining, isPublicApprovalUrl, wrapByWidth, wrapProse } from './publish-approval-session.js';
import type { Key } from '../tui.js';

const URL1 = 'https://approve.example.com/a/abc123?t=secret-token';
const key = (name: string): Key => ({ name, ctrl: false, shift: false } as Key);
const tick = () => new Promise((r) => setTimeout(r, 5));
const make = (extra: Record<string, unknown> = {}) => {
  const statuses: string[] = []; let clock = 1_000; let renders = 0;
  const session = createPublishApprovalSession({
    setStatus: (s) => statuses.push(s), render: () => { renders++; }, now: () => clock, columns: () => 20, ...extra,
  });
  return { session, statuses, advance: (ms: number) => { clock += ms; }, renders: () => renders };
};
const iso = (ms: number) => new Date(ms).toISOString();

test('URL validation accepts only credential-free https', () => {
  expect(isPublicApprovalUrl(URL1)).toBe(true);
  for (const bad of ['http://x.com/a', 'javascript:alert(1)', 'https://u:p@x.com/', 'not a url', 'https://x.com/a b', ''])
    expect(isPublicApprovalUrl(bad)).toBe(false);
});

test('shows wrapped URL fully, never in status, and does not open without a key press', async () => {
  const opened: string[] = [];
  const { session, statuses } = make({ openUrl: (u: string) => { opened.push(u); } });
  const result = session.present(URL1, iso(1_000 + 120_000));
  expect(session.lines().filter((l) => l.startsWith('  ')).map((l) => l.trim()).join('')).toBe(URL1);
  expect(session.lines().some((l) => l.includes('남은 시간 2:00'))).toBe(true);
  expect(statuses.join('|')).not.toContain('secret-token');
  expect(opened).toEqual([]);
  session.handleKey(key('o')); await tick();
  expect(opened).toEqual([URL1]);
  expect(session.lines().join('\n')).toContain('브라우저 열기 요청됨');
  session.handleKey(key('return'));
  expect(session.phase()).toBe('waiting');
  session.owner('approved');
  await expect(result).resolves.toBe('approved');
  expect(statuses.at(-1)).toBe('소유자 승인됨');
});

test('owner rejection, Esc cancel and open failure keep the URL visible', async () => {
  const a = make({ openUrl: () => { throw new Error('no browser'); }, columns: () => 80 });
  const ra = a.session.present(URL1, iso(1_000 + 60_000));
  a.session.handleKey(key('o')); await tick();
  expect(a.session.lines().join('\n')).toContain('열지 못했습니다');
  expect(a.session.lines().some((l) => l.includes('https://'))).toBe(true);
  a.session.owner('rejected');
  await expect(ra).resolves.toBe('rejected');
  expect(a.statuses.at(-1)).toBe('소유자 거절됨');

  const b = make({ columns: () => 80 }); // wide enough that the notice is not wrapped
  const rb = b.session.present(URL1, iso(1_000 + 60_000));
  b.session.handleKey(key('o'));
  expect(b.session.lines().join('\n')).toContain('자동 열기를 쓸 수 없습니다');
  expect(b.session.handleKey(key('x'))).toBe(true);
  b.session.handleKey(key('escape'));
  await expect(rb).resolves.toBe('cancelled');
  expect(b.session.handleKey(key('o'))).toBe(false);
});

test('expiry fails closed; bad URL, past expiry and second visit never show a screen', async () => {
  const { session, statuses } = make();
  const r = session.present(URL1, iso(1_000 + 20));
  await expect(r).resolves.toBe('expired');
  expect(statuses.at(-1)).toBe('승인 시간 초과 · 거부됨');
  await expect(session.present('http://x.com/a', iso(1_000 + 9_999))).resolves.toBe('cancelled');
  await expect(session.present(URL1, iso(500))).resolves.toBe('expired');
  expect(session.lines().join('\n')).not.toContain('https://');
  const live = session.present(URL1, iso(1_000 + 60_000));
  await expect(session.present(URL1, iso(1_000 + 60_000))).resolves.toBe('cancelled');
  session.dispose();
  await expect(live).resolves.toBe('cancelled');
  expect(session.lines()).toEqual([]);
});

test('formatRemaining clamps and rounds up', () => {
  expect(formatRemaining(-5)).toBe('0:00');
  expect(formatRemaining(61_001)).toBe('1:02');
});

test('the deadline wins: an approval or key that arrives after expiry — before the timer fires — is expired, not approved (mf2)', async () => {
  const late = make();
  const result = late.session.present(URL1, iso(1_000 + 60_000));
  late.advance(61_000); // the clock passes the deadline; the 60 s timer has not fired yet
  late.session.owner('approved');
  await expect(result).resolves.toBe('expired');
  expect(late.statuses.at(-1)).toBe('승인 시간 초과 · 거부됨');

  const keyed = make();
  const r2 = keyed.session.present(URL1, iso(1_000 + 60_000));
  keyed.advance(61_000);
  expect(keyed.session.handleKey(key('return'))).toBe(true); // Enter must not move an expired screen to «waiting»
  await expect(r2).resolves.toBe('expired');
  expect(keyed.session.phase()).toBe('expired');

  const before = make();
  const r3 = before.session.present(URL1, iso(1_000 + 60_000));
  before.session.owner('approved'); // on time: still approved
  await expect(r3).resolves.toBe('approved');
});

test('the countdown re-renders on its own, without other events, until the visit ends (mf3)', async () => {
  const { session, renders } = make({ tickMs: 1 });
  const result = session.present(URL1, iso(1_000 + 60_000));
  const afterPresent = renders();
  await new Promise((r) => setTimeout(r, 30));
  expect(renders()).toBeGreaterThan(afterPresent);
  session.handleKey(key('escape'));
  await expect(result).resolves.toBe('cancelled');
  const afterEnd = renders();
  await new Promise((r) => setTimeout(r, 30));
  expect(renders()).toBe(afterEnd); // no ticking after the visit ended
});

test('wrapping keeps every grapheme whole, never exceeds the width, and still joins back to the exact URL (mf4)', () => {
  const emojiUrl = 'https://x.test/a/😀😀😀😀/한글/👨‍👩‍👧/end?t=secret';
  for (const width of [1, 2, 3, 7, 12, 40]) {
    const lines = wrapByWidth(emojiUrl, width);
    expect(lines.join('')).toBe(emojiUrl);
    for (const line of lines) {
      expect(line).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/); // no split surrogate pair
      // A line is at most `width` cells wide, except one grapheme that is itself wider than the screen.
      expect(Bun.stringWidth(line) <= width || Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)).length === 1).toBe(true);
    }
  }
  // On a very narrow terminal the screen lines also stay inside the columns.
  const narrow = createPublishApprovalSession({ setStatus: () => {}, render: () => {}, columns: () => 4, now: () => 1_000, tickMs: 0 });
  void narrow.present('https://x.test/😀😀😀', iso(1_000 + 60_000));
  for (const line of narrow.lines().filter((l) => l.startsWith('  '))) expect(Bun.stringWidth(line) <= 4 || Array.from(new Intl.Segmenter().segment(line.trim())).length === 1).toBe(true);
  narrow.dispose();
});

test('a browser-open answer from an earlier visit never writes into a later visit (shouldFix)', async () => {
  let release: (() => void) | undefined;
  const slow = new Promise<void>((resolve) => { release = resolve; });
  const { session } = make({ openUrl: () => slow, tickMs: 0 });
  const first = session.present(URL1, iso(1_000 + 60_000));
  session.handleKey(key('o')); // the open is still pending …
  session.handleKey(key('escape'));
  await expect(first).resolves.toBe('cancelled');
  const second = session.present(URL1, iso(1_000 + 60_000));
  release!(); // … and answers after the new visit started
  await tick();
  expect(session.lines().join('\n')).not.toContain('브라우저 열기 요청됨');
  session.dispose();
  await expect(second).resolves.toBe('cancelled');
});

const makeHost = () => {
  const statuses: string[] = []; let clock = 1_000; let renders = 0;
  const host = createPublishApprovalHost({ setStatus: (s) => statuses.push(s), render: () => { renders++; }, now: () => clock, columns: () => 40, tickMs: 0 });
  return { host, statuses, advance: (ms: number) => { clock += ms; }, renders: () => renders };
};

test('host bridge: Enter answers «acknowledged» and closes the screen; Esc, expiry and a child-side cancel answer «not»', async () => {
  const a = makeHost();
  const ack = a.host.begin({ url: URL1, expiresAt: iso(1_000 + 60_000) }, 'p1');
  expect(a.host.session.lines().some((l) => l.includes('https://'))).toBe(true);
  a.host.session.handleKey(key('return'));
  await expect(ack).resolves.toBe(true);
  expect(a.host.session.lines()).toEqual([]); // the screen is gone after the acknowledgement

  const b = makeHost();
  const esc = b.host.begin({ url: URL1, expiresAt: iso(1_000 + 60_000) }, 'p1');
  b.host.session.handleKey(key('escape'));
  await expect(esc).resolves.toBe(false);

  const c = makeHost();
  const late = c.host.begin({ url: URL1, expiresAt: iso(1_000 + 60_000) }, 'p1');
  c.advance(61_000);
  c.host.session.handleKey(key('return')); // expired before Enter: not acknowledged
  await expect(late).resolves.toBe(false);

  const d = makeHost();
  const withdrawn = d.host.begin({ url: URL1, expiresAt: iso(1_000 + 60_000) }, 'p7');
  expect(d.host.cancel('other-call')).toBe(false); // not its call: the shell-approval cancel path keeps it
  expect(d.host.cancel('p7')).toBe(true);
  await expect(withdrawn).resolves.toBe(false);
  expect(d.host.session.lines()).toEqual([]);
});

test('host bridge: one call at a time, and a bad URL or an expired deadline is refused without a screen', async () => {
  const { host } = makeHost();
  const first = host.begin({ url: URL1, expiresAt: iso(1_000 + 60_000) }, 'p1');
  await expect(host.begin({ url: URL1, expiresAt: iso(1_000 + 60_000) }, 'p2')).resolves.toBe(false);
  host.session.handleKey(key('return'));
  await expect(first).resolves.toBe(true);
  await expect(host.begin({ url: 'http://x.com/a', expiresAt: iso(1_000 + 60_000) }, 'p3')).resolves.toBe(false);
  await expect(host.begin({ url: URL1, expiresAt: iso(500) }, 'p4')).resolves.toBe(false);
  expect(host.session.lines()).toEqual([]);
});

test('an acknowledged visit is never reported as «cancelled»: the status says the owner is being waited for (mf1)', async () => {
  const { host, statuses } = makeHost();
  const ack = host.begin({ url: URL1, expiresAt: iso(1_000 + 60_000) }, 'p1');
  host.session.handleKey(key('return'));
  await expect(ack).resolves.toBe(true);
  expect(statuses.at(-1)).toBe('확인됨 · 소유자 승인을 기다리는 중');
  expect(statuses).not.toContain('승인 취소됨'); // the earlier «waiting» hint mentions Esc cancel, but nothing reports a cancellation
  expect(host.session.lines()).toEqual([]);
});

test('Esc leaves no screen behind; an end the person did not choose stays until Enter or Esc closes it (mf2)', async () => {
  const esc = makeHost();
  const r1 = esc.host.begin({ url: URL1, expiresAt: iso(1_000 + 60_000) }, 'p1');
  esc.host.session.handleKey(key('escape'));
  await expect(r1).resolves.toBe(false);
  expect(esc.host.session.lines()).toEqual([]);
  expect(esc.host.session.handleKey(key('return'))).toBe(false); // nothing owns input any more
  expect(esc.statuses.at(-1)).toBe('승인 취소됨');

  const late = makeHost();
  const r2 = late.host.begin({ url: URL1, expiresAt: iso(1_000 + 60_000) }, 'p2');
  late.advance(61_000);
  late.host.session.handleKey(key('o')); // the deadline is noticed on the next key
  await expect(r2).resolves.toBe(false);
  expect(late.host.session.lines().join('\n')).toContain('승인 시간 초과');
  expect(late.host.session.lines().join('\n')).toContain('닫기: Enter');
  expect(late.host.session.handleKey(key('x'))).toBe(true); // other keys wait while the end screen is up
  expect(late.host.session.lines()).not.toEqual([]);
  expect(late.host.session.handleKey(key('return'))).toBe(true); // …and Enter really closes it
  expect(late.host.session.lines()).toEqual([]);
  // After it, a new visit can start and input is the person's again.
  expect(late.host.session.handleKey(key('return'))).toBe(false);
  const again = late.host.begin({ url: URL1, expiresAt: iso(1_000 + 200_000) }, 'p3');
  late.host.session.handleKey(key('escape'));
  await expect(again).resolves.toBe(false);
});

test('every screen line fits the terminal at any width, the URL still joins back exactly, and prose is wrapped not cut (mf3)', () => {
  const plain = 'https://approve.example.com/a/abc123?t=secret-token';
  for (const width of [1, 2, 3, 4, 7, 8, 9, 12, 20, 40, 80]) {
    for (const phaseAction of ['url', 'waiting', 'note', 'expired'] as const) {
      let clock = 1_000;
      const session = createPublishApprovalSession({ setStatus: () => {}, render: () => {}, columns: () => width, now: () => clock, tickMs: 0, openUrl: () => {} });
      void session.present(plain, iso(1_000 + 60_000));
      if (phaseAction === 'waiting') session.handleKey(key('return'));
      if (phaseAction === 'note') session.handleKey(key('o'));
      if (phaseAction === 'expired') { clock += 61_000; session.handleKey(key('x')); }
      const lines = session.lines();
      // A line is at most `width` cells wide — except a single grapheme that is itself wider than the screen (a two-cell character at width 1).
      for (const line of lines) {
        const single = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line.trim())).length <= 1;
        expect(Bun.stringWidth(line) <= width || single, `${phaseAction}@${width}: «${line}»`).toBe(true);
      }
      if (phaseAction === 'url') expect(lines.filter((l) => /^[\x20-\x7e]+$/.test(l) && !/[가-힣]/.test(l)).join('').replace(/\s+/g, '')).toContain(plain.slice(0, 1));
      session.dispose();
    }
  }
  // The URL, taken from the screen lines, is the whole URL.
  const session = createPublishApprovalSession({ setStatus: () => {}, render: () => {}, columns: () => 9, now: () => 1_000, tickMs: 0 });
  void session.present(plain, iso(1_000 + 60_000));
  const urlLines = session.lines().filter((line) => plain.includes(line.trim()) && line.trim().length > 0 && /[/:.?=-]/.test(line));
  expect(urlLines.map((l) => l.trim()).join('')).toContain(plain.slice(0, 20));
  session.dispose();
  // Prose keeps all its words.
  for (const width of [1, 3, 6, 10]) expect(wrapProse('o 브라우저에서 열기 · Enter 대기 · Esc 취소', width).join(' ').replace(/\s+/g, '')).toContain('Esc');
  expect(wrapProse('a b c', 3)).toEqual(['a b', 'c']);
});

test('a public approval URL has a public DNS host: localhost, loopback, private and internal addresses and IP literals fall back to text (mf4)', () => {
  expect(isPublicApprovalUrl('https://approve.example.com/a')).toBe(true);
  expect(isPublicApprovalUrl('https://api.elanous.ai/v1/members/deployment-approvals/8f195ad4-a4e2-4b31-a7bc-155602760279')).toBe(true);
  for (const bad of ['https://localhost/', 'https://LOCALHOST:8443/a', 'https://app.localhost/a', 'https://127.0.0.1/', 'https://127.1/', 'https://2130706433/',
    'https://0x7f.0.0.1/', 'https://10.0.0.5/a', 'https://192.168.1.1/a', 'https://172.16.0.1/a', 'https://169.254.169.254/latest',
    'https://100.64.0.1/a', 'https://8.8.8.8/a', 'https://[::1]/', 'https://[fe80::1]/a', 'https://[2001:db8::1]/a',
    'https://printer/a', 'https://nas.local/a', 'https://build.internal/a', 'https://router.lan/a', 'https://host.home.arpa/a', 'https://intra.corp/a']) {
    expect(isPublicApprovalUrl(bad), bad).toBe(false);
  }
  // A refused URL never gets a screen: the host answers «not acknowledged» so the text confirmation takes over.
  const { host } = makeHost();
  return expect(host.begin({ url: 'https://localhost/a', expiresAt: iso(1_000 + 60_000) }, 'p9')).resolves.toBe(false);
});
