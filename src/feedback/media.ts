import { asRecord } from '../primitives/guards';
/** Surface-neutral media derivation. No `apps/` imports. */

export interface MediaJob {
  jobId: string;
  kind: 'image' | 'video';
  status: string;
  model: string;
  resultUrl?: string;
  prompt?: string;
}

export interface MediaWidget {
  resourceUri: string;
}

/** MCP 툴 결과에서 «보여 줄 이미지»를 뽑는다.
 *
 *  ⛔⭐ 대표 2026-08-21: *"결과물이 그냥 링크로만 나옵니다."*
 *  📏 실측 — 상대는 주소를 «구조로» 준다(추측 아님):
 *    content: [ {type:'text', text:'… https://….png'},
 *               {name:'….png', uri:'https://….png', description:'…'} ]
 *  ⇒ 링크로만 보여 줄 이유가 없다. 그 `uri` 를 이미지 블록으로 그린다.
 *
 *  ⛔ 아무 URL 이나 그리지 않는다 — 확장자로 이미지인 것만. 아니면 남의 페이지를 <img> 로 건다.
 *  ⛔ 같은 주소를 두 번 그리지 않는다(요약 텍스트와 구조에 «둘 다» 실려 온다). */
const IMAGE_URL_RE = /^https?:\/\/[^\s"']+\.(png|jpe?g|webp|gif)(\?[^\s"']*)?$/i;
/** 글 «안»에 박힌 이미지 주소. ⛔ 위 정규식과 달리 앵커가 없다(문장 중간에 있다). */
const IMAGE_URL_IN_TEXT_RE = /https?:\/\/[^\s"'<>)\]]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>)\]]*)?/gi;

function imageMediaTypeOf(url: string): string {
  const ext = (url.split('?')[0] ?? '').split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/png';
}

export function mcpResultImages(rawOutput: unknown): Array<{ src: string; mediaType: string; alt?: string }> {
  if (!rawOutput || typeof rawOutput !== 'object' || Array.isArray(rawOutput)) return [];
  const seen = new Set<string>();
  const out: Array<{ src: string; mediaType: string; alt?: string }> = [];
  const texts: string[] = [];

  // ⭐ 1단계 — 구조에 실린 것을 «먼저». 설명(alt)이 붙어 있어 더 좋은 값이다.
  const visit = (node: unknown, depth: number): void => {
    if (depth > 4 || node === null) return;
    if (Array.isArray(node)) { for (const v of node) visit(v, depth + 1); return; }
    if (typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    const uri = typeof rec.uri === 'string' ? rec.uri : rec.result_url;
    if (typeof uri === 'string' && IMAGE_URL_RE.test(uri) && !seen.has(uri)) {
      seen.add(uri);
      const alt = typeof rec.description === 'string' ? rec.description
        : typeof rec.name === 'string' ? rec.name : undefined;
      out.push({ src: uri, mediaType: imageMediaTypeOf(uri), ...(alt ? { alt } : {}) });
    }
    for (const [key, v] of Object.entries(rec)) {
      // ⛔⭐ 프록시가 상대의 `content[]` 를 «텍스트로 접는다»(실측 2026-08-21:
      //   `{output, structured}` — `uri` 칸이 «사라진다»). 그 글은 2단계에서 훑는다.
      if (typeof v === 'string' && (key === 'output' || key === 'text')) { texts.push(v); continue; }
      visit(v, depth + 1);
    }
  };
  visit(rawOutput, 0);

  // ⭐ 2단계 — 접혀서 «글»로만 온 것. 구조에 이미 있던 주소는 건너뛴다(설명을 잃지 않는다).
  for (const text of texts) {
    for (const m of text.matchAll(IMAGE_URL_IN_TEXT_RE)) {
      const found = m[0];
      if (seen.has(found)) continue;
      seen.add(found);
      out.push({ src: found, mediaType: imageMediaTypeOf(found) });
    }
  }
  return out;
}

/** 툴 결과에서 위젯 주소를 뽑는다.
 *
 *  ⛔⭐ `apps/pwa/src/lib/daemon-client.ts` 의 SSE 갈래가 «같은 두 키»를 본다
 *  (규범 `_meta.ui.resourceUri` ⊕ 납작한 `ui/resourceUri`). 그 규약을 두 벌로 두지 않으려고
 *  여기 한 자리에 둔다 — ACP 경로는 원시 `rawOutput` 을 직접 받으므로 자기 추출기가 필요하다. */
export function mcpAppResourceUriOf(rawOutput: unknown): MediaWidget['resourceUri'] | undefined {
  if (!rawOutput || typeof rawOutput !== 'object' || Array.isArray(rawOutput)) return undefined;
  const record = rawOutput as Record<string, unknown>;
  const meta = record._meta;
  const ui = meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as Record<string, unknown>).ui : undefined;
  const nested = ui && typeof ui === 'object' && !Array.isArray(ui)
    ? (ui as Record<string, unknown>).resourceUri : undefined;
  if (typeof nested === 'string' && nested.trim().length > 0) return nested;
  const flat = record['ui/resourceUri'];
  return typeof flat === 'string' && flat.trim().length > 0 ? flat : undefined;
}

function hasMediaJobSource(rec: Record<string, unknown>): boolean {
  return Array.isArray(rec.jobs) || Array.isArray(rec.results) || asRecord(rec.generation, { fallback: 'undefined' }) !== undefined;
}

function structuredRecordOf(rawOutput: unknown): Record<string, unknown> | undefined {
  const root = asRecord(rawOutput, { fallback: 'undefined' });
  if (!root) return undefined;
  const structuredContent = asRecord(root.structuredContent, { fallback: 'undefined' });
  const structured = asRecord(root.structured, { fallback: 'undefined' });
  const candidates = [
    asRecord(structuredContent?.structured, { fallback: 'undefined' }),
    structuredContent,
    asRecord(structured?.structured, { fallback: 'undefined' }),
    structured,
  ];
  for (const rec of candidates) {
    if (rec && hasMediaJobSource(rec)) return rec;
  }
  return undefined;
}

function jobsArrayOf(rawOutput: unknown): unknown[] | undefined {
  const structured = structuredRecordOf(rawOutput);
  if (!structured) return undefined;
  if (Array.isArray(structured.jobs)) return structured.jobs;
  if (Array.isArray(structured.results)) return structured.results;
  if (asRecord(structured.generation, { fallback: 'undefined' })) return [structured.generation];
  return undefined;
}

function mediaStatusOf(value: unknown): MediaJob['status'] {
  return typeof value === 'string' ? value : 'pending';
}

function mediaJobOf(entry: unknown): MediaJob | undefined {
  const rec = asRecord(entry, { fallback: 'undefined' });
  if (!rec) return undefined;
  const jobId = typeof rec.job_id === 'string' ? rec.job_id
    : typeof rec.id === 'string' ? rec.id
    : undefined;
  if (!jobId) return undefined;
  if (rec.type !== 'image' && rec.type !== 'video') return undefined;
  const params = asRecord(rec.params, { fallback: 'undefined' });
  const prompt = typeof rec.prompt === 'string' ? rec.prompt
    : typeof params?.prompt === 'string' ? params.prompt
    : undefined;
  const job: MediaJob = {
    jobId,
    kind: rec.type,
    status: mediaStatusOf(rec.status),
    model: typeof rec.model === 'string' ? rec.model : '',
  };
  if (typeof rec.result_url === 'string') job.resultUrl = rec.result_url;
  if (prompt) job.prompt = prompt;
  return job;
}

export function mcpMediaJobs(rawOutput: unknown): MediaJob[] {
  const jobs = jobsArrayOf(rawOutput);
  if (!jobs) return [];
  const out: MediaJob[] = [];
  for (const entry of jobs) {
    const job = mediaJobOf(entry);
    if (job) out.push(job);
  }
  return out;
}
