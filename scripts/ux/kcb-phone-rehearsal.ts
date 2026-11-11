/** Three-phone KCB timing rehearsal. Fake mode uses real member handlers and fake Google/LLM edges. */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { KCB_EVENT_CODE } from '../../src/nexus/members/kcb-try.js';
import { kcbPhoneVerdicts, type KcbPhoneReceipt } from '../../src/ux-sim/kcb-phone-rehearsal.js';
import { createFakeMemberOidcWorld, FAKE_MEMBER_OIDC_REDIRECT_URI } from '../../src/ux-sim/fake-member-oidc-world.js';

const origin = 'https://app.example.test';
const api = 'https://members.example.test';
const examples = ['article-brief', 'system-diagram', 'day-plan'] as const;

async function fakePhone(index: number): Promise<KcbPhoneReceipt> {
  let now = Date.parse('2026-11-13T01:00:00.000Z') + index * 300_000;
  const qrScannedAt = new Date(now).toISOString();
  const example = examples[index - 1]!;
  const world = createFakeMemberOidcWorld({ now: () => now, runTryExample: async () => {
    now += 30_000;
    return '가짜 LLM 첫 결과';
  } });
  world.memberStore.provisionEventCode({ code: KCB_EVENT_CODE, maxUses: 300,
    startsAt: '2026-11-12T15:00:00Z', endsAt: '2026-11-15T15:00:00Z' });
  try {
    const qr = new URL(`${origin}/app/signup/?code=${KCB_EVENT_CODE}`);
    now += 15_000; // Observer opens QR and consents.
    const start = await world.membersApi.handle(new Request(`${api}/v1/members`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ eventCode: qr.searchParams.get('code'), consents: { privacy: 'privacy-v1', terms: 'terms-v1' } }),
    }), `203.0.113.${40 + index}`);
    if (start?.status !== 201) throw new Error(`signup start failed: ${start?.status} ${await start?.text()}`);
    const { authorizationUrl } = await start.json() as { authorizationUrl: string };
    const stateCookie = start.headers.get('set-cookie')?.split(';', 1)[0];
    if (!stateCookie) throw new Error('missing OAuth state cookie');
    now += 20_000; // Fake Google login.
    const auth = world.googleWorld.authorize(authorizationUrl);
    const callback = await world.membersApi.handle(new Request(
      `${FAKE_MEMBER_OIDC_REDIRECT_URI}?code=${auth.code}&state=${auth.state}`, { headers: { cookie: stateCookie } },
    ));
    if (callback?.status !== 200) throw new Error(`signup callback failed: ${callback?.status}`);
    const memberCookie = callback.headers.get('set-cookie')?.split(';', 1)[0];
    if (!memberCookie) throw new Error('missing member cookie');
    const result = await world.membersApi.handle(new Request(`${api}/v1/members/try`, {
      method: 'POST', headers: { origin, cookie: memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ exampleId: example, input: example === 'article-brief' ? '기사 제목: 행사 시작' : '행사 준비와 마무리' }),
    }));
    if (result?.status !== 200 || !(await result.json() as { result?: string }).result) throw new Error(`first result failed: ${result?.status}`);
    return { device: `phone-${index}`, mode: 'fake-oidc', qrScannedAt,
      firstResultAt: new Date(now).toISOString(), example, note: '합성 지연 15초+20초+30초; 실물 시간 아님' };
  } finally { world.close(); }
}

async function capture(device: string, example: KcbPhoneReceipt['example']): Promise<KcbPhoneReceipt> {
  if (!/^phone-[1-3]$/.test(device) || !examples.includes(example)) throw new Error('usage: capture phone-1|phone-2|phone-3 article-brief|system-diagram|day-plan');
  const prompts = createInterface({ input: process.stdin, output: process.stderr });
  try {
    await prompts.question(`${device}: QR을 스캔하는 순간 Enter → `);
    const qrScannedAt = new Date().toISOString();
    const outcome = await prompts.question(`${device}: 첫 결과가 보이면 Enter, 실패했으면 fail 입력 → `);
    return { device, mode: 'phone', qrScannedAt,
      firstResultAt: outcome.trim().toLowerCase() === 'fail' ? null : new Date().toISOString(), example,
      ...(outcome.trim().toLowerCase() === 'fail' ? { note: '첫 결과 없음; 화면 메시지와 실패 원인을 별도 기록' } : {}) };
  } finally { prompts.close(); }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'simulate' && args.length === 0) {
    const verdicts = kcbPhoneVerdicts(await Promise.all([1, 2, 3].map(fakePhone)));
    process.stdout.write(`${JSON.stringify(verdicts, null, 2)}\n`);
    return;
  }
  if (command === 'capture' && args.length === 2) {
    const receipt = await capture(args[0]!, args[1] as KcbPhoneReceipt['example']);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return;
  }
  if (command === 'report' && args.length >= 1 && args.length <= 3) {
    const receipts = args.flatMap(file => {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return Array.isArray(parsed) ? parsed as KcbPhoneReceipt[] : [parsed as KcbPhoneReceipt];
    });
    const verdicts = kcbPhoneVerdicts(receipts);
    const pass = verdicts.every(row => row.withinTwoMinutes) && new Set(verdicts.map(row => row.mode)).size === 1;
    process.stdout.write(`${JSON.stringify({ mode: verdicts[0]?.mode, pass, devices: verdicts }, null, 2)}\n`);
    if (!pass) process.exitCode = 1;
    return;
  }
  throw new Error('usage: bun scripts/ux/kcb-phone-rehearsal.ts simulate | capture <phone-1|phone-2|phone-3> <example> | report <one array or three receipt JSON files>');
}

await main();
