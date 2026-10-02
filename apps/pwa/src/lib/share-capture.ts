// SC1 «공유용 캡처»(beta) — 지금 화면을 가린 뒤 PNG 로 만들어 데몬에 올린다(티저·현장·보고용).
// 가림은 «그리기 전»에 한다: 화면 사본(DOM clone)의 마크업 «문자열 전체»(글자 ⊕ 속성)에 규칙을 건 뒤 그림으로 굽는다.
//   ① 이 기기의 실제 값(주소 host · 데몬 주소 · 연결 토큰)은 «글자 그대로» 지운다 — 패턴이 놓쳐도 남지 않게.
//   ② 내부 주소(사설·tailnet IP · *.ts.net · *.local · localhost:포트) · 토큰 모양 · 홈 경로 · 메일 · 계정 잔량/금액(Live 공개 가림 규칙).
//   ③ `data-share-hide` 가 붙은 요소(연결 줄 등)는 통째로 회색 칸으로 바꾼다.
// 결과 PNG 는 캔버스가 만든다(글자 메타 없음). 데몬이 받을 때 «그림 아닌» 덩어리를 한 번 더 걷는다(이중 방어).
import { makePublicMasker } from './live-public';

const MASK = '•••';

const RULES: Array<[RegExp, string]> = [
  // tokens
  [/\b(?:elt|els)_[A-Za-z0-9_-]{8,}/g, MASK],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{10,}/g, MASK],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, MASK], // Telegram bot token shape
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, `$1${MASK}`],
  [/([?&](?:token|access_token|key|auth|code)=)[^&\s"'<>]+/gi, `$1${MASK}`],
  // internal addresses (with an optional :port)
  [/\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d{2,5})?\b/g, MASK],
  [/\b192\.168\.\d{1,3}\.\d{1,3}(?::\d{2,5})?\b/g, MASK],
  [/\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(?::\d{2,5})?\b/g, MASK],
  [/\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?::\d{2,5})?\b/g, MASK],
  [/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net(?::\d{2,5})?\b/gi, 'tailnet-host'],
  [/\b[a-z0-9-]+\.local(?::\d{2,5})?\b/gi, 'local-host'],
  [/\blocalhost:\d{2,5}\b/gi, 'localhost'],
  // people
  [/\/(?:Users|home)\/[^/\s"'<>]+/g, '~'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, `${MASK}@${MASK}`],
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Values of THIS device that must never appear (host, daemon host, token). Short or empty values are ignored. */
export function shareLiterals(input: { pageHost?: string; baseUrl?: string; token?: string }): string[] {
  const out = new Set<string>();
  const add = (v: string | undefined) => { if (v && v.trim().length >= 4) out.add(v.trim()); };
  add(input.token);
  add(input.pageHost);
  if (input.baseUrl) {
    try { const u = new URL(input.baseUrl); add(u.host); add(u.hostname); add(input.baseUrl.replace(/\/$/, '')); } catch { add(input.baseUrl); }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Mask one string; `hits` counts replacements (shown to the person as «가린 항목 N개»). */
export function maskShareText(text: string, literals: readonly string[] = []): { text: string; hits: number } {
  let hits = 0;
  let out = text;
  for (const literal of literals) {
    const re = new RegExp(escapeRe(literal), 'g');
    out = out.replace(re, () => { hits++; return MASK; });
  }
  for (const [re, to] of RULES) out = out.replace(re, (...m: string[]) => { hits++; return to.replace('$1', m[1] ?? ''); });
  const publicMask = makePublicMasker([]);
  const after = publicMask(out, false);
  if (after !== out) hits++;
  return { text: after, hits };
}

/** Mask serialized markup: scripts out, form values blank, then every rule over text AND attributes. */
export function maskShareMarkup(markup: string, literals: readonly string[] = []): { markup: string; hits: number } {
  const stripped = markup
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '')
    .replace(/(<input\b[^>]*?\bvalue=)("[^"]*"|'[^']*')/gi, '$1""')
    .replace(/(<textarea\b[^>]*>)[\s\S]*?(<\/textarea>)/gi, '$1$2');
  const { text, hits } = maskShareText(stripped, literals);
  return { markup: text, hits };
}

export interface ShareCaptureResult { blob: Blob; hits: number; width: number; height: number }

/** Browser only: clone the page, hide `[data-share-hide]`, mask, and paint to a PNG. */
export async function captureScreenToPng(literals: readonly string[]): Promise<ShareCaptureResult> {
  const width = Math.max(320, Math.round(window.innerWidth));
  const height = Math.max(320, Math.round(window.innerHeight));
  const clone = document.body.cloneNode(true) as HTMLElement;
  let hidden = 0;
  for (const el of Array.from(clone.querySelectorAll<HTMLElement>('[data-share-hide], [data-share-capture-ui]'))) {
    const box = document.createElement('span');
    box.setAttribute('style', 'display:inline-block;min-width:4em;height:1em;background:#9ca3af;border-radius:3px');
    el.replaceWith(box);
    hidden++;
  }
  for (const el of Array.from(clone.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'))) {
    el.setAttribute('value', '');
    if (el.tagName === 'TEXTAREA') el.textContent = '';
  }
  let css = '';
  for (const sheet of Array.from(document.styleSheets)) {
    try { for (const rule of Array.from(sheet.cssRules)) css += `${rule.cssText}\n`; } catch { /* cross-origin sheet — skipped */ }
  }
  const body = new XMLSerializer().serializeToString(clone);
  const { markup, hits } = maskShareMarkup(body, literals);
  const htmlClass = document.documentElement.className.replace(/[^\w\s-]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">`
    + `<div xmlns="http://www.w3.org/1999/xhtml" class="${htmlClass}" style="width:${width}px;height:${height}px;overflow:hidden">`
    + `<style>${css.replace(/<\/style/gi, '')}</style>${markup}</div></foreignObject></svg>`;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('render-failed')); img.src = url; });
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no-canvas');
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('encode-failed');
  return { blob, hits: hits + hidden, width, height };
}
