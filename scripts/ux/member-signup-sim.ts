/**
 * MEMBER-SIGNUP-SIM-SERVER (OP 11-17 B1 · mock first): walk the member sign-up on the real public pages without real
 * Google or the real member database.
 *
 * A headless Chrome opens https://elanous.ai as a newcomer would. Requests to the members API (https://api.elanous.ai)
 * and to Google are answered in this process by the fake member world (src/ux-sim/fake-member-oidc-world.ts):
 * production member handlers and stores in memory, Google faked at its network edge. Nothing reaches api.elanous.ai or
 * accounts.google.com, and no real account is made.
 *
 *   bun scripts/ux/member-signup-sim.ts --out <dir> [--width 375] [--port <n>]
 *
 * Without --port a free port is taken; a --port that is already listening stops the run, and before the first page
 * connection the process listening on the port must be the Chrome this run spawned (same PID) — never another browser.
 *
 * Steps (screenshot + one line each): home → sign-up form → consent → «Google 로 가입» → fake Google → the site page
 * the callback 303 lands on for a member with no handle yet (/members/): its handle step and the claim through its
 * form → the member home the API renders (/v1/members/home): its status line and whether its buttons lead anywhere →
 * a device key ISSUED DIRECTLY IN THE WORLD'S MEMBER STORE (not through any HTTP route and not through
 * `eln member connect`'s browser approval — this sim proves neither) → the home again: connected status, the device
 * row, and the web chat entry. Only what the home shows for a member who has a key is measured.
 * (A same-page POST /v1/member/keys from this API-origin page is refused 403 origin-not-allowed by design.)
 * The receipt records each step's verdict and what the screen said. The issued key is never read or recorded.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { launch, listeningPids, sleep } from './lib/cdp';
import { createFakeMemberOidcWorld, FAKE_MEMBER_OIDC_REDIRECT_URI } from '../../src/ux-sim/fake-member-oidc-world';

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1]! : fallback;
}
const out = arg('out', '');
if (!out) throw new Error('--out is required');
const width = Number(arg('width', '375'));
// The handle the sim claims (the members API accepts ^[a-z][a-z0-9]{2,19}$, a relay DNS label).
const handle = arg('handle', 'simmember');
/** A port nothing listens on right now: the OS picks one for a throwaway listener, which is closed again. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}
const asked = arg('port', '');
const port = asked ? Number(asked) : await freePort();
if (asked && listeningPids(port).length > 0) throw new Error(`port ${port} is already in use — another browser or run is attached there`);
mkdirSync(out, { recursive: true });

const SITE = 'https://elanous.ai';
const API = 'https://api.elanous.ai';
const GOOGLE_HOSTS = new Set(['accounts.google.test', 'accounts.google.com']);
const callbackUrl = new URL(FAKE_MEMBER_OIDC_REDIRECT_URI);

// The members API trusts exactly the site origin it redirects back to.
const world = createFakeMemberOidcWorld({ successRedirectUri: `${SITE}/members/` });

type Step = { step: string; pass: boolean; detail: string; url: string; shot: string };
const steps: Step[] = [];
const intercepted: string[] = [];

// The browser on the port must be this run's own Chrome (PID check inside launch, before the first page connection).
const cdp = await launch({ port, timeoutMs: 6 * 60_000, width, height: width < 600 ? 812 : 900, mobile: width < 600, requireOwnPort: true });
// Paused-request events go only to the CDP session that enabled Fetch, so a second socket enables it and answers.
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
const events = new WebSocket(list.find((t) => t.type === 'page')!.webSocketDebuggerUrl);
await new Promise((resolve) => events.addEventListener('open', resolve, { once: true }));
let eventId = 0;
const pendingEvents = new Map<number, (value: unknown) => void>();
const send = (method: string, params: object = {}) => new Promise<unknown>((resolve) => {
  const id = ++eventId; pendingEvents.set(id, resolve); events.send(JSON.stringify({ id, method, params }));
});
const fulfill = (requestId: string, response: Response, body: string) => send('Fetch.fulfillRequest', {
  requestId, responseCode: response.status,
  responseHeaders: [
    ...[...response.headers.entries()].filter(([name]) => name !== 'set-cookie').map(([name, value]) => ({ name, value })),
    ...response.headers.getSetCookie().map((value) => ({ name: 'set-cookie', value })),
  ],
  body: Buffer.from(body).toString('base64'),
});

/** Answer one paused request: members API and Google in-process; everything else (the public site) goes through. */
async function route(params: { requestId: string; request: { url: string; method: string; headers: Record<string, string>; postData?: string } }): Promise<void> {
  const url = new URL(params.request.url);
  if (GOOGLE_HOSTS.has(url.hostname)) {
    // Fake Google consent: issue a code for the PKCE request, then return to the API host's own callback (the cookie
    // host stays api.elanous.ai, as in production).
    const { code, state } = world.googleWorld.authorize(url);
    const back = new URL(callbackUrl.pathname, API);
    back.searchParams.set('code', code);
    back.searchParams.set('state', state);
    intercepted.push(`google ${url.pathname} → callback`);
    await send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 302, responseHeaders: [{ name: 'location', value: back.toString() }] });
    return;
  }
  if (url.origin === API) {
    // The world's handlers know their callback by its configured URL; hand them the same path on that host.
    const target = url.pathname === callbackUrl.pathname ? new URL(`${callbackUrl.origin}${url.pathname}${url.search}`) : url;
    const headers = new Headers(params.request.headers);
    // In production the members API and the member home share one origin (api.elanous.ai); in this world that API is
    // configured on the callback host. Only the two writes the API admits from its own origin (#38340: the home's
    // app-slot and app-slot/name) carry the world's callback origin — every other API-origin request keeps its Origin,
    // so the sim can never be greener than production (#38346 REVIEW-1 ①).
    const ownOriginWrite = params.request.method === 'POST' && (url.pathname === '/v1/members/app-slot' || url.pathname === '/v1/members/app-slot/name');
    if (ownOriginWrite && headers.get('origin') === API) headers.set('origin', callbackUrl.origin);
    const request = new Request(target, { method: params.request.method, headers,
      ...(params.request.postData !== undefined && params.request.method !== 'GET' ? { body: params.request.postData } : {}) });
    let response = await world.membersApi.handle(request, 'sim') ?? new Response('{"error":"not_found"}', { status: 404 });
    // Redirects the handlers build on the world's callback host belong to the API host in production.
    const location = response.headers.get('location');
    if (location?.startsWith(callbackUrl.origin)) {
      const headers = new Headers(response.headers);
      headers.set('location', `${API}${location.slice(callbackUrl.origin.length)}`);
      response = new Response(response.body, { status: response.status, headers });
    }
    const body = await response.text();
    intercepted.push(`api ${params.request.method} ${url.pathname} → ${response.status}${response.status >= 400 ? ` ${body.slice(0, 80)}` : ''}${response.status >= 300 && response.status < 400 ? ` location=${response.headers.get('location')} cookies=${response.headers.getSetCookie().length} headers=${[...response.headers.keys()].join(',')}` : ''}`);
    await fulfill(params.requestId, response, body);
    return;
  }
  await send('Fetch.continueRequest', { requestId: params.requestId });
}

events.addEventListener('message', (message) => {
  const m = JSON.parse(String(message.data));
  if (m.id && pendingEvents.has(m.id)) { pendingEvents.get(m.id)!(m.result); pendingEvents.delete(m.id); }
  if (m.method === 'Fetch.requestPaused') void route(m.params).catch((error) => {
    intercepted.push(`error ${String(error)}`);
    void send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'Failed' });
  });
});
await send('Fetch.enable', { patterns: [{ urlPattern: `${API}/*` }, { urlPattern: 'https://accounts.google.test/*' }, { urlPattern: 'https://accounts.google.com/*' }] });

type HomeFacts = { status: string; primary: string; primaryHref: string; brandHref: string; cards: string[]; devices: string[]; links: { text: string; href: string }[] };
const homeFacts = () => cdp.ev<HomeFacts>(`(() => {
  const hero = document.querySelector('.hero'); const all = [...(hero?.querySelectorAll('a.primary') ?? [])];
  // The status button (connect guide / start), not «내 엘라누스 열기» (data-member-my-elanous).
  const a = all.find((n) => !n.hasAttribute('data-member-my-elanous')) ?? all[0];
  return { status: (hero?.querySelector('.lead')?.textContent ?? '').trim(), primary: all.map((n) => n.textContent.trim()).join(' + '), primaryHref: a?.href ?? '',
    brandHref: document.querySelector('a.brand')?.href ?? '', cards: [...document.querySelectorAll('section h2')].map((n) => n.textContent.trim()),
    devices: [...document.querySelectorAll('#devices ~ ul li, section[aria-labelledby=devices] li')].map((n) => n.textContent.replace(/\\s+/g, ' ').trim()),
    links: [...document.querySelectorAll('a[href]')].map((n) => ({ text: n.textContent.trim(), href: n.href })) }; })()`);

/**
 * Whether a button leads somewhere, without leaving the simulated world: a same-page anchor must name an element on
 * this page; a members-API address is asked of the in-process API (with the page's cookie); only the public site is
 * asked over the network (read-only HEAD). Nothing here reaches the real api.elanous.ai.
 */
async function leadsSomewhere(target: string): Promise<[boolean, string]> {
  const url = new URL(target);
  const here = await cdp.ev<string>('location.href');
  if (url.hash && url.href.split('#')[0] === here.split('#')[0]) {
    const found = await cdp.ev<boolean>(`!!document.getElementById(${JSON.stringify(decodeURIComponent(url.hash.slice(1)))})`);
    return [found, `${target} → same-page anchor ${found ? 'present' : 'missing'}`];
  }
  if (url.origin === API) {
    const status = await cdp.ev<number>(`fetch(${JSON.stringify(target)}, { credentials: 'include', redirect: 'manual' }).then((r) => r.status || 302)`);
    return [status >= 200 && status < 400, `${target} → ${status} (in-process API)`];
  }
  let status = 0;
  try { status = (await fetch(target, { method: 'HEAD', redirect: 'follow' })).status; } catch { status = -1; }
  return [status >= 200 && status < 400, `${target} → ${status}`];
}

const screen = () => cdp.ev<{ url: string; text: string }>(`({ url: location.href.replace(/[?#].*$/, ''), text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300) })`);
async function record(step: string, pass: boolean, detail: string): Promise<void> {
  const shot = join(out, `${String(steps.length + 1).padStart(2, '0')}-${step}-${width}.png`);
  await cdp.png(shot);
  const s = await screen();
  steps.push({ step, pass, detail, url: s.url, shot });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${step} · ${detail} · ${s.url}`);
}

try {
  await cdp.send('Page.navigate', { url: `${SITE}/#next` });
  await sleep(4000);
  await cdp.ev(`(() => { document.getElementById('signup')?.scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(600);
  const formOk = await cdp.ev<boolean>(`!!document.getElementById('signup')`);
  await record('signup-form', formOk, formOk ? 'sign-up form on the home page' : 'no #signup form');

  await cdp.ev(`(() => { const c = document.querySelector('#signup input[type=checkbox]'); if (c && !c.checked) c.click(); return true; })()`);
  await cdp.ev(`(() => { const b = [...document.querySelectorAll('#signup button')].find((n) => /Google/.test(n.textContent)); b?.click(); return !!b; })()`);
  let at = await screen();
  // After a non-KCB sign-up whose member has no handle yet (members-api.ts callback), the 303 lands on the success
  // redirect — the site page with the handle step. A member who already has a handle lands on the API home.
  for (let i = 0; i < 30 && at.url !== `${SITE}/members/`; i++) { await sleep(500); at = await screen(); }
  await record('google-round-trip', at.url === `${SITE}/members/`, `landed on ${at.url}`);

  // The handle step on the site page the callback landed on: the page's own JS reads the member (no handle yet) and
  // unhides its «핸들» section. Matched by the heading's own words, never the product's constant.
  await sleep(3000);
  const landing = await homeFacts();
  const hasHandleStep = landing.cards.some((t) => /핸들/.test(t));
  await record('handle-step', hasHandleStep, hasHandleStep
    ? `handle step on the site page the callback landed on («${landing.cards.find((t) => /핸들/.test(t))}»)`
    : 'no handle step heading on the site page the callback landed on');

  // The handle claim through the site page's form (#handle-input → submit → PUT /v1/members/handle, in-process API).
  const member = [1, 0, 2].map((n) => world.memberStore.memberForGoogleSub(`fake-google-member-${n}`)).find(Boolean);
  const handleForm = await cdp.ev<boolean>(`!!document.getElementById('handle-form')`);
  if (handleForm) {
    await cdp.ev(`(() => { const i = document.getElementById('handle-input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(i, ${JSON.stringify(handle)}); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
      const b = [...document.querySelectorAll('#handle-form button')].find((n) => n.getClientRects().length); b?.click(); return !!b; })()`);
    await sleep(2500);
    const claimed = member ? world.memberStore.handleForMember(member.id) : null;
    const said = await cdp.ev<string>(`document.body.innerText.replace(/\\s+/g, ' ').slice(0, 240)`);
    await record('handle-claim', claimed === handle, `store handle = ${claimed ?? '-'} · page «${said}»`);
  } else {
    await record('handle-claim', false, 'no #handle-form on the site page the callback landed on');
  }

  // The member home the API renders, after the claim: its status line and whether its buttons lead anywhere.
  await cdp.send('Page.navigate', { url: `${API}/v1/members/home` });
  await sleep(3000);
  const home = await homeFacts();
  const knows = home.status !== '' && !/확인하지 못했어요/.test(home.status);
  await record('home-status', knows, `«${home.status}» · button «${home.primary}» → ${home.primaryHref} · cards ${home.cards.join(' · ')}`);

  for (const [name, target] of [['primary-target', home.primaryHref], ['brand-target', home.brandHref]] as const) {
    await record(name, ...(await leadsSomewhere(target)));
  }

  // Device key: issued directly in the world's member store (createMemberKey). No HTTP route and no browser approval is
  // exercised here — a real device gets its key from `eln member connect`'s PKCE approval (its own tests). The receipt
  // says «store direct issue». The key value is never read.
  let connected = false;
  if (member) { world.memberStore.createMemberKey(member.id, 'sim-terminal', undefined, () => {}); connected = true; }
  await record('device-key-store-direct', connected, connected ? 'store direct issue (createMemberKey in the world store · no HTTP route · no browser approval · value not read)' : 'signed-up member not found in the store');
  await cdp.send('Page.reload', {});
  await sleep(2500);
  const after = await homeFacts();
  const linkedOk = /연결했어요/.test(after.status) && after.devices.some((row) => row.includes('sim-terminal'));
  await record('home-linked', linkedOk, `«${after.status}» · button «${after.primary}» → ${after.primaryHref} · devices ${after.devices.join(' / ') || '-'}`);
  const chat = after.links.find((link) => /웹채팅|채팅/.test(link.text));
  // MEMBER-HOME-WEBCHAT-SERVING-GATE (#38799 · OP #92258): a linked member without a serving signal has no slot-host
  // link to click — the entry is the member's own address with «곧 열림» (the retired terminal hint is gone).
  const soonHint = await cdp.ev<boolean>(`(() => { const n = document.querySelector('[data-member-webchat-soon]'); return !!n && n.getClientRects().length > 0 && /내 주소: [^ ]+ \\(곧 열림\\)/.test((n.textContent ?? '').replace(/\\s+/g, ' ')); })()`);
  await record('webchat-entry', linkedOk && !chat && soonHint,
    `연결됐으나 웹채팅 미연동·«곧 열림» 주소 줄 노출 (chat ${chat ? `«${chat.text}» → ${chat.href}` : 'none'} · soon hint ${soonHint ? 'shown' : 'NOT shown'} · linked ${linkedOk ? 'yes' : 'no'})`);
  if (chat) await record('webchat-target', ...(await leadsSomewhere(chat.href)));
  // Where «엘라누스 시작하기» lands (the public site, read-only): is it a chat a member can type into?
  if (after.primaryHref.startsWith(SITE)) {
    await cdp.send('Page.navigate', { url: after.primaryHref });
    await sleep(5000);
    const landed = await cdp.ev<{ url: string; title: string; text: string; composer: boolean }>(`({ url: location.href, title: document.title,
      text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 220), composer: !!document.querySelector('textarea, [contenteditable=true], input[type=text]') })`);
    await record('start-lands', landed.composer, `${landed.url} · «${landed.title}» · composer ${landed.composer ? 'yes' : 'no'} · «${landed.text}»`);
  }

  // Back home: the app-name card and, once a slot exists, the web chat link.
  await cdp.send('Page.navigate', { url: `${API}/v1/members/home` });
  await sleep(3000);
  // The boundary #38340 keeps: from the home's (API) origin, issuing a member key stays refused. Sent from the page with
  // its cookie; PASS only on 403. The response body is not read beyond its status.
  const keyWrite = await cdp.ev<number>(`fetch('${API}/v1/member/keys', { method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'sim-boundary' }) }).then((r) => r.status)`);
  await record('api-origin-key-write-refused', keyWrite === 403, `POST /v1/member/keys from the API origin → ${keyWrite} (must stay 403)`);

  // The app name («내 주소 두 가지» card): the page's own check and save buttons, through the in-process API.
  // Each control the step needs is looked up first; a missing one is named in a FAIL (never a silent pass/skip).
  const appNameControls = await cdp.ev<string[]>(`['app-name-input', 'app-name-check', 'app-name-save'].filter((id) => !document.getElementById(id))`);
  // #38347: a member without an event code is told on the card why there is no app address, and the form is hidden.
  // #38373 REVIEW-1: PASS only when the line says what it must say — checked with literals of its own, never the
  // product's constant (that would pass a wrong wording too): it names the event code, the app address and joining —
  // and a person can see it (rendered · not hidden · not display:none · no aria-hidden ancestor); the form must be out
  // of sight the same way.
  const eventCodeLine = await cdp.ev<{ text: string; visible: boolean } | null>(`(() => {
    const node = document.querySelector('[data-member-app-name-needs-event-code]');
    if (!node) return null;
    const seen = (el) => { for (let at = el; at; at = at.parentElement) { const style = getComputedStyle(at);
      if (at.hidden || style.display === 'none' || style.visibility === 'hidden' || at.getAttribute('aria-hidden') === 'true') return false; }
      return el.getClientRects().length > 0; };
    return { text: node.textContent.trim(), visible: seen(node) }; })()`);
  const formShown = await cdp.ev<boolean>(`(() => { const form = document.getElementById('app-name-form'); if (!form) return false;
    for (let at = form; at; at = at.parentElement) { if (at.hidden || getComputedStyle(at).display === 'none') return false; }
    return form.getClientRects().length > 0; })()`);
  if (eventCodeLine) {
    const wordingOk = /이벤트\s*코드/.test(eventCodeLine.text) && /앱\s*주소/.test(eventCodeLine.text) && /가입/.test(eventCodeLine.text);
    await record('app-name-states-rule', wordingOk && eventCodeLine.visible && !formShown,
      `card «${eventCodeLine.text}» (${wordingOk ? 'names event code · app address · joining' : 'does NOT name event code · app address · joining'} · ${eventCodeLine.visible ? 'visible' : 'NOT visible'}) · name form ${formShown ? 'still shown' : 'hidden'}`);
    const noSlot = member ? world.memberStore.appSlotForMember(member.id) === null : false;
    await record('app-slot', eventCodeLine.visible && !formShown && noSlot, `store slot = ${noSlot ? 'null' : 'not null'} · card rule shown · form hidden (card «${eventCodeLine.text}» · form ${formShown ? 'shown' : 'hidden'})`);
  } else if (appNameControls.length > 0) {
    await record('app-slot', false, `no app-name card control on the home: missing #${appNameControls.join(', #')}`);
  } else {
    const appName = `${handle}app`;
    await cdp.ev(`(() => { const i = document.getElementById('app-name-input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(i, ${JSON.stringify(appName)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await cdp.ev(`document.getElementById('app-name-check').click()`);
    await sleep(1500);
    await cdp.ev(`document.getElementById('app-name-save').click()`);
    await sleep(2500);
    const slot = member ? world.memberStore.appSlotForMember(member.id) : null;
    const cardSaid = await cdp.ev<string>(`(document.querySelector('section[aria-labelledby=app-name]')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 220)`);
    await record('app-slot', slot !== null, `store slot = ${slot ? slot.appSlug : '-'} · card «${cardSaid}»`);
  }

  // The home once handle and device exist (this member has no app slot, per «app-slot» above): the «곧 열림» address
  // line — not a web chat link — stays the entry, the same rule as «webchat-entry» (MEMBER-HOME-WEBCHAT-SERVING-GATE #38799).
  await cdp.send('Page.reload', {});
  await sleep(2500);
  const ready = await homeFacts();
  const chatNow = ready.links.find((link) => /웹채팅|채팅/.test(link.text));
  const soonHintNow = await cdp.ev<boolean>(`(() => { const n = document.querySelector('[data-member-webchat-soon]'); return !!n && n.getClientRects().length > 0 && /내 주소: [^ ]+ \\(곧 열림\\)/.test((n.textContent ?? '').replace(/\\s+/g, ' ')); })()`);
  await record('webchat-entry-after-slot', !chatNow && soonHintNow,
    `연결·핸들 후에도 웹채팅 미연동·«곧 열림» 주소 줄 유지 (chat ${chatNow ? `«${chatNow.text}» → ${chatNow.href}` : 'none'} · soon hint ${soonHintNow ? 'shown' : 'NOT shown'})`);
  if (chatNow) await record('webchat-after-slot-target', ...(await leadsSomewhere(chatNow.href)));
} catch (error) {
  steps.push({ step: 'aborted', pass: false, detail: String(error), url: '', shot: '' });
} finally {
  events.close();
  cdp.close();
  world.close();
}

const receipt = { at: new Date().toISOString(), width, port, green: steps.length > 0 && steps.every((s) => s.pass), steps, intercepted };
writeFileSync(join(out, `receipt-${width}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`${receipt.green ? 'GREEN' : 'RED'} · ${steps.filter((s) => s.pass).length}/${steps.length} · ${join(out, `receipt-${width}.json`)}`);
console.log(intercepted.join('\n'));
process.exit(receipt.green ? 0 : 1);
