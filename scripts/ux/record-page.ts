// PWA 한 화면 실녹화 · 캡처 (UX 자리 · 내부 문서 `UX` §3).
// 사용:
//   bun scripts/ux/record-page.ts --url http://127.0.0.1:<port>/app/board/ --out <dir> [--secs 20] [--size 1920x1080]
//        [--mobile] (390x844 @3x 터치) [--type "<한 줄>"] (textarea 에 쳐서 Enter) [--shot] (PNG 한 장만)
//        [--token-stdin] (단기 소유자 토큰을 표준 입력으로만 받는다 — 값은 출력하지 않는다)
// ⭐ URL 에 `capture=public` 을 자동으로 붙이고 15초마다 누설 점검 줄을 찍는다(bad 가 비어 있어야 공개 후보).
// ⛔ 공개는 이 산출이 아니라 1fps 전수 OCR(TC) 통과 뒤다.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Frames, launch, PUBLIC_LEAK_CHECK, sleep } from './lib/cdp.js';

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const flag = (k: string) => process.argv.includes(`--${k}`);
const rawUrl = arg('url'); const out = arg('out');
if (!rawUrl || !out) { console.error('usage: --url <url> --out <dir> [--secs N] [--size WxH] [--mobile] [--type text] [--shot] [--token-stdin] [--eval <js>]'); process.exit(64); }
const mobile = flag('mobile');
const [W, H] = mobile ? [390, 844] : (arg('size') ?? '1920x1080').split('x').map(Number);
const DPR = mobile ? 3 : 1; const SECS = Number(arg('secs') ?? 20);
const u = new URL(rawUrl); u.searchParams.set('capture', 'public');
mkdirSync(out, { recursive: true });

const cdp = await launch({ port: 9480 + Math.floor(Math.random() * 15), timeoutMs: (SECS + 180) * 1000, width: W, height: H, dpr: DPR, mobile });
if (flag('token-stdin')) {
  const temp = /elt_[A-Za-z0-9_-]{16,}/.exec(await Bun.stdin.text())?.[0] ?? '';
  console.log('token', temp ? 'received' : 'none');
  if (temp) { await cdp.send('Page.navigate', { url: `${u.origin}/app/` }); await sleep(3000); await cdp.ev(`localStorage.setItem('elanous.daemon.token', ${JSON.stringify(temp)})`); }
}
await cdp.send('Page.navigate', { url: u.toString() }); await sleep(8000);
// --eval <js>: 녹화 전에 화면 상태를 맞춘다(출처 선택·토글·배너 닫기) — 기록에 남도록 그대로 찍는다.
const pre = arg('eval');
if (pre) { console.log('eval', await cdp.ev<string>(`(()=>{try{${pre};return 'ok'}catch(e){return 'error: '+e}})()`)); await sleep(4000); }
const check = async (tag: string) => console.log(tag, await cdp.ev<string>(PUBLIC_LEAK_CHECK));
await check('before');
if (flag('shot')) { const f = join(out, `shot-${W}x${H}.png`); await cdp.png(f); console.log('png', f); cdp.close(); process.exit(0); }

const frames = new Frames(out); let recording = true;
const loop = (async () => { let last = Date.now(); while (recording) { const s = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 }); frames.add(s.data); if (Date.now() - last > 15_000) { last = Date.now(); await check('mid'); } } })();
const text = arg('type');
if (text) {
  await sleep(800);
  await cdp.ev(`document.querySelector('textarea')?.focus()`);
  for (const ch of [...text]) { await cdp.send('Input.insertText', { text: ch }); await sleep(55); }
  await sleep(500);
  for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(3500);
} else await sleep(SECS * 1000);
recording = false; await loop;
await check('after');
cdp.close();
const mp4 = join(out, `rec-${W * DPR}x${H * DPR}.mp4`);
frames.toMp4(mp4, W * DPR, H * DPR);
console.log('frames', frames.list.length, 'mp4', mp4);
process.exit(0);
