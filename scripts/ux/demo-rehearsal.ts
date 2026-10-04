import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { Frames, launch, PUBLIC_LEAK_CHECK, sleep } from './lib/cdp.js';
import { EMPTY_STATE_PHRASES, failedApiResponse, judgeRun, judgeScene, worstSceneState, type SceneObservation, type SceneState } from './lib/rehearsal-verdict.js';
export { EMPTY_STATE_PHRASES } from './lib/rehearsal-verdict.js';

const TITLES = ['문서 아키텍처', '라이브 트레이스', '루프 에이전트', '그래프 편집기', '마법사 → 마켓', 'PTY 인텔리전스'];

export function sceneSnapshotScript(): string {
  return `(()=>{const sections=[...document.querySelectorAll('[data-inside-scene]')]; const visible=sections.filter(s=>!s.hidden && s.getClientRects().length>0); const text=visible.length===1?visible[0].innerText:''; return {sectionsInDom:sections.length,visibleScene:visible.length===1?Number(visible[0].getAttribute('data-inside-scene')):null,textLength:text.length,emptyStates:${JSON.stringify(EMPTY_STATE_PHRASES)}.filter(phrase=>text.includes(phrase))}})()`;
}

type Args = { url: string; out: string; secs: number; width: number; height: number; demo: boolean; tokenStdin: boolean };

export function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  let demo = true;
  let tokenStdin = false;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--no-demo') { demo = false; continue; }
    if (key === '--token-stdin') { tokenStdin = true; continue; }
    if (!['--url', '--out', '--secs', '--size'].includes(key ?? '')) throw new Error(`알 수 없는 인자: ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${key} 값이 필요합니다`);
    values.set(key!, value);
  }
  const url = values.get('--url');
  const out = values.get('--out');
  if (!url || !out) throw new Error('--url <기반 URL> --out <폴더>가 필요합니다');
  const base = new URL(url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('--url에는 인증정보·쿼리 없는 HTTP 기반 URL만 허용합니다');
  const secsText = values.get('--secs') ?? '20';
  const secs = Number(secsText);
  if (!/^\d+(?:\.\d+)?$/.test(secsText) || !Number.isFinite(secs) || secs <= 0) throw new Error('--secs는 양의 초여야 합니다');
  const size = /^(\d+)x(\d+)$/.exec(values.get('--size') ?? '1920x1080');
  if (!size || +size[1]! < 1 || +size[2]! < 1 || !Number.isSafeInteger(+size[1]!) || !Number.isSafeInteger(+size[2]!)) throw new Error('--size는 양의 WxH여야 합니다');
  return { url: base.origin, out, secs, width: +size[1]!, height: +size[2]!, demo, tokenStdin };
}

type FrameRect = { x: number; y: number; width: number; height: number };

// Check the entire *visible scene*, not page chrome or the bottom margin of a valid scene.
// An evenly blank scene is blank regardless of whether it is white, grey, or black.
export async function isBlankFrame(jpeg: string, rect: FrameRect | null): Promise<boolean> {
  if (!rect) return true;
  const image = sharp(Buffer.from(jpeg, 'base64'));
  const meta = await image.metadata();
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(meta.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(meta.height, Math.ceil(rect.y + rect.height));
  if (right <= left || bottom <= top) return true;
  const { data, info } = await image.extract({ left, top, width: right - left, height: bottom - top })
    .resize({ width: 320, height: 180, fit: 'fill' })
    .greyscale().raw().toBuffer({ resolveWithObject: true });
  let edges = 0;
  for (let y = 1; y < info.height; y++) {
    for (let x = 1; x < info.width; x++) {
      const i = y * info.width + x;
      if (Math.abs(data[i]! - data[i - 1]!) > 20 ||
          Math.abs(data[i]! - data[i - info.width]!) > 20) {
        if (++edges >= 12) return false;
      }
    }
  }
  return true;
}

// The shared CDP client owns its socket; a second CDP session observes events without changing it.
export async function observe(port: number) {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json() as Array<{ type: string; webSocketDebuggerUrl?: string }>;
  const endpoint = pages.find((page) => page.type === 'page')?.webSocketDebuggerUrl;
  if (!endpoint) throw new Error('CDP page missing');
  const socket = new WebSocket(endpoint);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP observer connection timed out')), 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP observer unavailable')); }, { once: true });
      socket.addEventListener('close', () => { clearTimeout(timer); reject(new Error('CDP observer closed')); }, { once: true });
    });
  } catch (error) { socket.close(); throw error; }
  let id = 0;
  const pending = new Map<number, { resolve: (value: { error?: { message: string } }) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let closed = false;
  const failPending = () => {
    closed = true;
    for (const [key, request] of pending) {
      clearTimeout(request.timer);
      request.reject(new Error('CDP observer disconnected'));
      pending.delete(key);
    }
  };
  socket.addEventListener('close', failPending);
  socket.addEventListener('error', failPending);
  const requests = new Map<string, string>();
  let exceptions: string[] = [];
  let failedRequests: string[] = [];
  socket.addEventListener('message', (event) => {
    const data = JSON.parse(String(event.data)) as { id?: number; error?: { message: string }; method?: string; params?: { requestId?: string; request?: { url: string }; response?: { url: string; status: number } } };
    if (data.id !== undefined) {
      const request = pending.get(data.id);
      if (request) { clearTimeout(request.timer); pending.delete(data.id); request.resolve(data); }
    }
    if (data.method === 'Network.requestWillBeSent' && data.params?.requestId && data.params.request) {
      // Preserve only the API classification; never persist a URL or a query containing a credential.
      const path = new URL(data.params.request.url).pathname;
      requests.set(data.params.requestId, /(?:^|\/)v1\//.test(path) ? '/v1/' : 'non-api request');
    }
    if (data.method === 'Network.responseReceived' && data.params?.response) {
      const failed = failedApiResponse(data.params.response.url, data.params.response.status);
      if (failed) failedRequests.push(failed);
    }
    if (data.method === 'Network.loadingFinished') requests.delete(data.params?.requestId ?? '');
    if (data.method === 'Runtime.exceptionThrown') exceptions.push('Runtime.exceptionThrown');
    if (data.method === 'Network.loadingFailed') {
      const requestId = data.params?.requestId ?? '';
      failedRequests.push(requests.get(requestId) ?? 'non-api request');
      requests.delete(requestId);
    }
  });
  const send = async (method: string) => {
    if (closed || socket.readyState !== WebSocket.OPEN) throw new Error('CDP observer disconnected');
    const response = await new Promise<{ error?: { message: string } }>((resolve, reject) => {
      const next = ++id;
      const timer = setTimeout(() => {
        pending.delete(next);
        reject(new Error(`CDP ${method} timed out`));
      }, 5000);
      pending.set(next, { resolve, reject, timer });
      try { socket.send(JSON.stringify({ id: next, method })); }
      catch { clearTimeout(timer); pending.delete(next); reject(new Error('CDP observer send failed')); }
    });
    if (response.error) throw new Error(`CDP ${method} failed`);
  };
  try { await send('Runtime.enable'); await send('Network.enable'); }
  catch (error) { failPending(); socket.close(); throw error; }
  return {
    take: () => {
      const result = { exceptions, failedRequests };
      exceptions = []; failedRequests = [];
      return result;
    },
    close: () => { failPending(); socket.close(); },
  };
}

export async function run(args: Args): Promise<number> {
  mkdirSync(args.out, { recursive: true });
  const startedAt = new Date().toISOString();
  const port = 9480 + Math.floor(Math.random() * 15);
  const cdp = await launch({ port, timeoutMs: (args.secs * 6 + 180) * 1000, width: args.width, height: args.height });
  let observer: Awaited<ReturnType<typeof observe>> | undefined;
  try {
    observer = await observe(port);
    const target = new URL('/app/inside/', args.url);
    target.searchParams.set('demo', args.demo ? '1' : '0');
    target.searchParams.set('capture', 'public');
    target.searchParams.set('scene', '1');
    if (args.tokenStdin) {
      const token = /elt_[A-Za-z0-9_-]{16,}/.exec(await Bun.stdin.text())?.[0];
      if (token) {
        await cdp.send('Page.navigate', { url: `${target.origin}/app/` });
        await sleep(3000);
        await cdp.ev(`localStorage.setItem('elanous.daemon.token', ${JSON.stringify(token)})`);
      }
    }
    observer.take();
    await cdp.send('Page.navigate', { url: target.toString() });
    await sleep(8000);
    const initialEvents = observer.take();
    const scenes = [];
    for (let scene = 1; scene <= 6; scene++) {
      const hiddenByDemo = false;
      if (scene !== 1) {
        await cdp.ev<boolean>(`(()=>{const n=${scene}; const nav=document.querySelector('nav[aria-label="장면 선택"]'); const button=[...(nav?.querySelectorAll('button')??[])].find(b=>b.textContent?.trim().startsWith(n+' ')); button?.click(); return !!button})()`);
        await sleep(300);
      }
      const frames = new Frames(join(args.out, `scene-${scene}`));
      const states: SceneState[] = [];
      const emptyStates = new Set<string>();
      const sceneRect = await cdp.ev<FrameRect | null>(`(()=>{const s=document.querySelector('[data-inside-scene="${scene}"]'); if (!s || s.hidden) return null; const r=s.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
      let blankFrames = 0;
      const inspect = async () => {
        const { emptyStates: observedEmpty, ...state } = await cdp.ev<SceneState & { emptyStates: string[] }>(sceneSnapshotScript());
        states.push(state);
        for (const phrase of observedEmpty) emptyStates.add(phrase);
      };
      const until = Date.now() + args.secs * 1000;
      await inspect();
      do {
        const screenshot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
        frames.add(screenshot.data);
        if (await isBlankFrame(screenshot.data, sceneRect)) blankFrames++;
        await inspect();
      } while (Date.now() < until);
      await cdp.png(join(args.out, `scene-${scene}.png`));
      const { bad } = JSON.parse(await cdp.ev<string>(PUBLIC_LEAK_CHECK)) as { bad: string[] };
      const dom = worstSceneState(scene, states);
      const observed = observer.take();
      const events = scene === 1 ? {
        exceptions: [...initialEvents.exceptions, ...observed.exceptions],
        failedRequests: [...initialEvents.failedRequests, ...observed.failedRequests],
      } : observed;
      frames.toMp4(join(args.out, `scene-${scene}.mp4`), args.width, args.height);
      const obs: SceneObservation = { scene, title: TITLES[scene - 1]!, hiddenByDemo, secs: args.secs, frames: frames.list.length, ...events, ...dom, leaks: bad, blankFrames, emptyStates: [...emptyStates] };
      const result = judgeScene(obs);
      scenes.push(result);
      console.log(`scene ${scene} ${result.verdict} ${args.secs}s frames=${result.frames}`);
    }
    const result = judgeRun(scenes);
    const report = { version: repoVersion(), startedAt, endedAt: new Date().toISOString(), ...result };
    writeFileSync(join(args.out, 'rehearsal.json'), JSON.stringify(report, null, 2) + '\n');
    writeFileSync(join(args.out, 'rehearsal.md'), [
      '# DEMO-RUN 리허설',
      '',
      ...result.banner.map((line) => `> ⚠️ ${line}`),
      ...(result.banner.length ? [''] : []),
      `판: ${report.version} · 시작: ${startedAt} · 종료: ${report.endedAt} · 판정: ${report.verdict}`,
      '',
      '| 장면 | 판정 | 초 | 프레임 | 이유 |',
      '|---|---|---:|---:|---|',
      ...scenes.map((s) => `| ${s.scene} ${s.title} | ${s.verdict} | ${s.secs} | ${s.frames} | ${s.reasons.join('; ') || '없음'} |`),
      '',
      `ok ${result.ok} · broken ${result.broken} · 미검증 ${result.unverified} · 실데이터 없음 ${result.noData}`,
      '',
      '종료 코드: ok=0 · broken=1 · unverified=2 · no-data=3',
      '',
    ].join('\n'));
    for (const line of result.banner) console.log(`⚠️ ${line}`);
    console.log(`rehearsal ${result.verdict} ok=${result.ok} broken=${result.broken} unverified=${result.unverified} no-data=${result.noData}`);
    // 0 = ok · 1 = broken · 2 = unverified · 3 = no-data.
    return result.verdict === 'broken' ? 1 : result.verdict === 'unverified' ? 2 : result.verdict === 'no-data' ? 3 : 0;
  } finally { observer?.close(); cdp.close(); }
}

function repoVersion(): string {
  try { return String((JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown }).version ?? 'unknown'); }
  catch { return 'unknown'; }
}

if (import.meta.main) {
  try { process.exitCode = await run(parseArgs(process.argv.slice(2))); }
  catch { console.error('리허설 실행 실패'); process.exitCode = 1; }
}
