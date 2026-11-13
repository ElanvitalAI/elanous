import type { SharedPayload } from './share-target-store';

type ScrapKind = 'text' | 'web' | 'x' | 'youtube' | 'voice' | 'video' | 'photo';
type ScrapRaw = { text?: string; url?: string; mediaRef?: string; mime?: string };
export interface ShareScrapResult { saved: string[]; failed: string[] }
export interface SavedScrapReceipt { id: string; kind: ScrapKind; raw: ScrapRaw }
export type ShareFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
export class ScrapsUnavailableError extends Error {}

function urlKind(value: string): ScrapKind {
  const hostname = new URL(value).hostname.toLowerCase();
  if (hostname === 'x.com' || hostname === 'www.x.com' || hostname === 'twitter.com' || hostname === 'www.twitter.com') return 'x';
  if (hostname === 'youtube.com' || hostname === 'www.youtube.com' || hostname === 'm.youtube.com' || hostname === 'youtu.be') return 'youtube';
  return 'web';
}

function sharedUrl(payload: SharedPayload): string | null {
  const explicit = payload.url.trim();
  if (explicit) {
    try {
      const url = new URL(explicit);
      if (url.protocol === 'http:' || url.protocol === 'https:') return explicit;
    } catch { /* Continue with a URL embedded in the shared text. */ }
  }
  const embedded = payload.text.match(/https?:\/\/[^\s<>]+/i)?.[0]?.replace(/[),.;!?]+$/, '');
  if (!embedded) return null;
  try {
    const url = new URL(embedded);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
  } catch { /* Text may contain an ordinary sentence. */ }
  return null;
}

function mediaKind(file: File): ScrapKind | null {
  if (file.type.startsWith('image/') || /\.(?:png|jpe?g|webp|gif|heic|heif)$/i.test(file.name)) return 'photo';
  if (file.type.startsWith('audio/') || /\.(?:m4a|mp3|wav|ogg|opus|aac|flac)$/i.test(file.name)) return 'voice';
  if (file.type.startsWith('video/') || /\.(?:mp4|mov|webm|m4v|3gp)$/i.test(file.name)) return 'video';
  return null;
}

function safeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'shared-file';
}

async function responseJson(response: Response, label: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(response.status === 401 ? '회원 로그인이 필요합니다.' : `${label} 실패 (${response.status})`);
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 응답이 올바르지 않습니다.`);
  return value as Record<string, unknown>;
}

/** Browser member cookie identifies the owner; never send memberId in the scrap body. */
export async function saveSharedScraps(
  payload: SharedPayload,
  options: { baseUrl: string; daemonToken?: string; fetcher?: ShareFetch; completedKeys?: ReadonlySet<string>; onSaved?: (key: string, receipt: SavedScrapReceipt) => void | Promise<void> },
): Promise<ShareScrapResult> {
  const request = options.fetcher ?? fetch;
  const base = new URL(options.baseUrl || window.location.origin);
  let members: Record<string, unknown>;
  try {
    const membersResponse = await request(new URL('/v1/members', base), { credentials: 'include' });
    members = await responseJson(membersResponse, '회원 확인');
  } catch {
    throw new ScrapsUnavailableError('회원 세션을 확인할 수 없습니다.');
  }
  const member = members.member as { id?: unknown } | undefined;
  const appSlot = members.appSlot as { appSlug?: unknown } | undefined;
  if (typeof member?.id !== 'string') throw new ScrapsUnavailableError('회원 세션을 확인할 수 없습니다.');
  if (payload.files.some((file) => mediaKind(file) !== null)
    && (!options.daemonToken || typeof appSlot?.appSlug !== 'string')) {
    throw new ScrapsUnavailableError('미디어 업로드 인증이 준비되지 않았습니다.');
  }
  const result: ShareScrapResult = { saved: [], failed: [] };
  const post = async (key: string, kind: ScrapKind, raw: ScrapRaw, label: string): Promise<void> => {
    if (options.completedKeys?.has(key)) return;
    try {
      const response = await request(new URL('/v1/scraps', base), {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'Idempotency-Key': `${payload.id}:${key}` },
        body: JSON.stringify({ kind, source: 'pwa', raw }),
      });
      if ([401, 404, 405, 503].includes(response.status)) throw new ScrapsUnavailableError(`스크랩 저장 경로가 준비되지 않았습니다 (${response.status}).`);
      const saved = await responseJson(response, label);
      if (typeof saved.id !== 'string' || !saved.id) throw new Error(`${label} 저장 ID가 없습니다.`);
      await options.onSaved?.(key, { id: saved.id, kind, raw });
      result.saved.push(label);
    } catch (error) {
      if (error instanceof ScrapsUnavailableError) throw error;
      result.failed.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const url = sharedUrl(payload);
  const explicitHttpUrl = sharedUrl({ ...payload, text: '' });
  const text = [payload.title, payload.text, ...(explicitHttpUrl ? [] : [payload.url])].map((part) => part.trim()).filter(Boolean).join('\n\n');
  if (!url && !text && payload.files.length === 0) throw new Error('공유 내용이 비었습니다.');
  const hasAdditionalUrl = Boolean(url && [...payload.text.matchAll(/https?:\/\/[^\s<>]+/gi)].some((match) => {
    try { return new URL(match[0].replace(/[),.;!?]+$/, '')).toString() !== url; }
    catch { return false; }
  }));
  const linkText = hasAdditionalUrl ? payload.title.trim() : text;
  if (url) await post('url', urlKind(url), { url, ...(linkText ? { text: linkText } : {}) }, '링크');
  else if (text) await post('text', 'text', { text }, '텍스트');
  if (hasAdditionalUrl) {
    const additionalText = [payload.text, ...(explicitHttpUrl ? [] : [payload.url])].map((part) => part.trim()).filter(Boolean).join('\n\n');
    await post('text', 'text', { text: additionalText }, '추가 링크가 있는 텍스트');
  }
  for (const [index, file] of payload.files.entries()) {
    const label = file.name || `파일 ${index + 1}`;
    const key = `file:${index}`;
    if (options.completedKeys?.has(key)) continue;
    if (file.type.startsWith('text/') || /\.(?:txt|md)$/i.test(file.name)) {
      await post(key, 'text', { text: await file.text() }, label);
      continue;
    }
    const kind = mediaKind(file);
    if (!kind) { result.failed.push(`${label}: 지원하지 않는 파일 형식입니다.`); continue; }
    if (typeof appSlot?.appSlug !== 'string' || !options.daemonToken) {
      result.failed.push(`${label}: 미디어 저장 연결이 필요합니다.`);
      continue;
    }
    try {
      // The upload and scrap body carry the same app-scoped object key.
      // ABSORB-1 validates the owner session and adds the member prefix.
      const mediaRef = `scraps/share-${safeKey(payload.id).slice(0, 48)}-${index}-${safeKey(label).slice(0, 48)}`;
      const signResponse = await request(new URL(`/v1/apps/${encodeURIComponent(appSlot.appSlug)}/storage/uploads`, base), {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.daemonToken}` },
        body: JSON.stringify({ key: mediaRef, expiresInMs: 60_000, role: 'owner' }),
      });
      if ([401, 403, 404, 503].includes(signResponse.status)) throw new ScrapsUnavailableError('미디어 업로드 인증을 확인할 수 없습니다.');
      const signed = await responseJson(signResponse, `${label} 업로드 준비`);
      if (typeof signed.url !== 'string') throw new Error('업로드 주소가 없습니다.');
      const uploaded = await request(new URL(signed.url, base), { method: 'PUT', body: file, headers: { 'content-type': file.type || 'application/octet-stream' } });
      if ([401, 403].includes(uploaded.status)) throw new ScrapsUnavailableError('미디어 업로드 인증을 확인할 수 없습니다.');
      if (!uploaded.ok) throw new Error(`업로드 실패 (${uploaded.status})`);
      await post(key, kind, { mediaRef, mime: file.type || 'application/octet-stream' }, label);
    } catch (error) {
      if (error instanceof ScrapsUnavailableError) throw error;
      result.failed.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}
