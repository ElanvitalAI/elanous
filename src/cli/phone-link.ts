// `elanous phone link` — 휴대폰 앱을 이 Mac 의 넥서스에 «한 번에» 붙이는 연결 링크(⊕ 터미널 QR).
// 대표 2026-09-30: 아이폰 첫 화면이 개발용 연결 카드라 복잡하다 → 앱은 링크 하나로 온보딩한다.
// 링크 = `elanous://connect?host=…&port=…&tls=1|0&token=…` — 앱이 `.onOpenURL` 로 받아 저장하고 바로 연결한다.
import { spawnSync } from 'node:child_process';
import { debug } from '../debug/log.js';

export interface PhoneEndpoint { host: string; port: number; tls: boolean }

/** REST/PWA 기준 URL(예 `https://mbp.x.ts.net:31415/v1/`) → 앱이 쓰는 host·port·tls. 못 읽으면 null. */
export function endpointFromBaseUrl(base: string): PhoneEndpoint | null {
  let u: URL;
  try { u = new URL(base); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const tls = u.protocol === 'https:';
  const port = u.port ? Number(u.port) : tls ? 443 : 80;
  if (!u.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host: u.hostname, port, tls };
}

/** 앱이 여는 연결 링크. 토큰은 URL 인코딩한다. */
export function buildPhoneConnectLink(ep: PhoneEndpoint, token: string): string {
  const q = new URLSearchParams({ host: ep.host, port: String(ep.port), tls: ep.tls ? '1' : '0', token });
  return `elanous://connect?${q.toString()}`;
}

/** 어느 주소를 휴대폰에 줄까 — 기본은 tailnet(휴대폰이 닿는다) · `local` 이면 루프백(같은 Mac 의 시뮬레이터). */
export function pickPhoneBase(urls: { loopback: string; tailnet?: string }, opts: { local?: boolean } = {}): { base: string; kind: 'tailnet' | 'loopback' } {
  if (!opts.local && urls.tailnet) return { base: urls.tailnet, kind: 'tailnet' };
  return { base: urls.loopback, kind: 'loopback' };
}

/** USB 로 꽂힌 안드로이드에 링크를 «직접» 건넨다 — `adb reverse` 로 폰의 127.0.0.1:<port> 를 이 Mac 으로 잇고
 *  `am start` 로 elanous://connect 를 연다. 토큰은 화면·로그에 찍지 않는다(adb 인자로만 간다). */
export function androidDeliverySteps(link: string, port: number, serial?: string): string[][] {
  const dev = serial ? ['-s', serial] : [];
  return [
    [...dev, 'reverse', `tcp:${port}`, `tcp:${port}`],
    [...dev, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${link}'`, 'com.elanvitalai.elanous.android'],
  ];
}

export interface RunPhoneLinkOpts {
  local?: boolean;
  /** USB 안드로이드에 adb 로 바로 건넨다(루프백 ⊕ adb reverse). 문자열이면 기기 serial. */
  android?: boolean | string;
  temp?: boolean;
  ttl?: string;
  qr?: boolean;
  out?: { log: (s: string) => void; error: (s: string) => void };
}

export async function runPhoneLink(opts: RunPhoneLinkOpts = {}): Promise<number> {
  const out = opts.out ?? { log: (s: string) => console.log(s), error: (s: string) => console.error(s) };
  const { runNexusShow } = await import('./nexus-show.js');
  const silent = { log: () => {}, error: () => {} };
  const shown = await runNexusShow({ format: 'json', out: silent });
  if (!shown.urls) {
    out.error('✗ 넥서스가 떠 있지 않다 — 먼저 `elanous nexus run` (또는 `elanous nexus status` 로 확인).');
    return 1;
  }
  const picked = pickPhoneBase(shown.urls.rest, { local: opts.local || !!opts.android });
  const ep = endpointFromBaseUrl(picked.base);
  if (!ep) { out.error(`✗ 넥서스 주소를 읽지 못했다: ${picked.base}`); return 1; }

  let token: string;
  let tokenNote: string;
  if (opts.temp) {
    const { issueTempToken, parseTtl } = await import('../auth/temp-tokens.js');
    const issued = issueTempToken({ ttlMs: parseTtl(opts.ttl ?? '24h'), label: 'phone' });
    token = issued.token;
    tokenNote = `단기 토큰 · ${issued.expiresAt} 까지 · 폐기: elanous token revoke ${issued.id}`;
  } else {
    const { loadEnvelope } = await import('../auth/token-store.js');
    const env = loadEnvelope();
    if (!env?.active) { out.error('✗ 소유자 토큰이 없다 — `elanous token rotate` 로 한 번 만든 뒤 다시.'); return 1; }
    token = env.active;
    tokenNote = '소유자 토큰(설정의 Bearer 와 같다) · 바꾸려면 elanous token rotate';
  }

  const link = buildPhoneConnectLink(ep, token);
  try { debug.log('phone.link', 'issued', { kind: picked.kind, tls: ep.tls, temp: !!opts.temp }); } catch { /* 관측 실패가 발급을 막지 않는다 */ }

  if (opts.android) {
    const serial = typeof opts.android === 'string' ? opts.android : undefined;
    const lanEp = { ...ep, host: '127.0.0.1', tls: false };
    const androidLink = buildPhoneConnectLink(lanEp, token);
    for (const args of androidDeliverySteps(androidLink, lanEp.port, serial)) {
      const r = spawnSync('adb', args, { encoding: 'utf8' });
      if (r.status !== 0) {
        // ⛔ 인자에 토큰이 있으므로 명령을 그대로 찍지 않는다 — 단계 이름과 adb 의 말만.
        const why = (r.error?.message ?? r.stderr ?? '').trim().split('\n')[0] ?? '';
        out.error(`✗ adb ${args.includes('reverse') ? 'reverse' : 'am start'} 실패 — ${why || `exit ${r.status}`}`);
        out.error('  USB 디버깅 허용 · `adb devices` 에 기기가 «device» 로 보이는지 · 기기가 여럿이면 --android <serial>.');
        return 1;
      }
    }
    try { debug.log('phone.link', 'android-delivered', { port: lanEp.port, serial: !!serial, temp: !!opts.temp }); } catch { /* 관측 실패가 연결을 막지 않는다 */ }
    out.log(`✓ 안드로이드 앱에 연결 링크를 건넸다 — 폰에서 앱이 열리고 바로 붙는다 (127.0.0.1:${lanEp.port} ⇄ 이 Mac · adb reverse).`);
    out.error('⚠ USB 를 뽑으면 끊긴다. 계속 쓰려면 폰의 Tailscale 을 켜고 `elanous phone link` 의 QR 을 찍는다.');
    out.error(`토큰: ${tokenNote}`);
    return 0;
  }

  out.log('휴대폰에서 이 링크를 열면 앱이 바로 연결된다 (카메라로 QR · AirDrop · 메모 붙여넣기):');
  out.log('');
  out.log(link);
  out.log('');
  if (opts.qr !== false) {
    const qr = spawnSync('qrencode', ['-t', 'ANSIUTF8', link], { encoding: 'utf8' });
    if (qr.status === 0 && qr.stdout) out.log(qr.stdout);
  }
  out.error(`주소: ${ep.tls ? 'https' : 'http'}://${ep.host}:${ep.port} (${picked.kind === 'tailnet' ? 'tailnet — 휴대폰이 같은 tailnet 에 있어야 한다' : '루프백 — 이 Mac 의 시뮬레이터 전용'})`);
  if (picked.kind === 'loopback' && !opts.local) out.error('⚠ tailnet 주소가 없다 — 실제 휴대폰에서는 닿지 않는다. `elanous nexus show` 로 tailnet 을 확인하라.');
  out.error(`토큰: ${tokenNote}`);
  out.error('⚠ 이 링크는 이 Mac 을 조작할 수 있는 토큰을 담는다 — 남에게 보내거나 공개 캡처에 싣지 않는다.');
  return 0;
}
