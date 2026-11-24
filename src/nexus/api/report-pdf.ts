import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonToolSurface } from '../../boot/daemon-tools/types.js';
import { redactSecretText } from '../../debug/secret-redaction.js';
import type { LLMToolSpec } from '../../llm/tool-spec.js';

const MAX_PDF_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_BYTES = 128 * 1024;
const REPORT_SPEC: LLMToolSpec = {
  name: 'ReportPdf',
  description: 'When the user explicitly requests a PDF, publish a demo report to a publicly readable URL. Include the answer and its sources in the Markdown. Use only content safe to publish. On success, include the returned markdownLink verbatim in your answer.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'markdown'],
    properties: { title: { type: 'string' }, markdown: { type: 'string' } },
  },
};

const reportsBySession = new Map<string, number>();
const NON_PRINTING = /[\p{Cf}\u0000-\u0008\u000b-\u001f\u007f]/gu;
const INTERNAL_PATH = /\bfile:\/\/|(?:^|[\s(`"'=:])(?:[A-Z]:[\\/]|\\\\[^\\\s]+\\|~\/|\/(?:Users|home|root|private|tmp|var|etc|proc|sys|run|mnt|opt|Volumes|workspace|workspaces)(?=\/|[\s`"')]|$))|(?:^|[\s/\\(`"'=:])(?:seat-state|elanous-hq|\.ssh|\.aws|\.config|\.codex|\.elanous(?:-[\w-]+)?)(?=[/\\]|$)/i;
const CREDENTIAL_MARKER = /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----|\b(?:sk-[A-Za-z0-9_-]{16,}|ya29\.[\w.-]{12,}|(?:wcs|emt|elsb|elt)_[\w-]{12,})\b/i;

function isUnsafeReportText(input: string): boolean {
  const text = input.normalize('NFKC').replace(NON_PRINTING, '');
  return redactSecretText(text) !== text || CREDENTIAL_MARKER.test(text) || INTERNAL_PATH.test(text);
}


function typstString(value: string): string {
  return JSON.stringify(value.replace(NON_PRINTING, ''));
}

function reportTypst(title: string, markdown: string): string {
  const blocks = markdown.split(/\r?\n/).map((line) => {
    if (!line.trim()) return '';
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) return `#heading(level: ${heading[1]!.length}, ${typstString(heading[2]!)})`;
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (bullet) return `#list(${typstString(bullet[1]!)})`;
    return `#block(${typstString(line)})`;
  });
  return [
    '#set page(paper: "a4", margin: 24mm)',
    '#set text(font: ("NanumGothic", "Nanum Gothic", "Apple SD Gothic Neo", "Noto Sans CJK KR", "DejaVu Sans"), size: 11pt)',
    `#align(center + horizon, text(size: 26pt, weight: "bold", ${typstString(title)}))`,
    '#pagebreak()',
    ...blocks,
  ].join('\n');
}

async function publishReport(
  title: string,
  markdown: string,
  bucket: string,
  handle: string,
  credentials: string,
  callerSignal: AbortSignal,
): Promise<string> {
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(25_000)]);
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'elanous-report-pdf-'));
  try {
    const input = join(directory, 'report.typ');
    const output = join(directory, 'report.pdf');
    await writeFile(input, reportTypst(title, markdown), { mode: 0o600 });
    const typst = Bun.which('typst') ?? join(homedir(), '.local', 'share', 'elanous', 'bin', 'typst');
    const child = Bun.spawn([typst, 'compile', '--root', directory, input, output], {
      stdout: 'ignore', stderr: 'ignore', signal,
    });
    if (await child.exited !== 0) throw new Error('render failed');
    if ((await stat(output)).size > MAX_PDF_BYTES) throw new RangeError('PDF exceeds 2 MiB');
    signal.throwIfAborted();
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({
      keyFilename: credentials,
      scopes: ['https://www.googleapis.com/auth/devstorage.read_write'],
    });
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
    const key = `members/${handle}/public/${date}/${nonce}.pdf`;
    const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o`);
    url.search = new URLSearchParams({ uploadType: 'media', name: key, ifGenerationMatch: '0' }).toString();
    const headers = await auth.getRequestHeaders(url.toString());
    headers.set('Content-Type', 'application/pdf');
    const response = await fetch(url, { method: 'POST', headers, body: new Uint8Array(await readFile(output)), signal });
    await response.body?.cancel();
    if (!response.ok) throw new Error('upload failed');
    return `https://storage.googleapis.com/${bucket}/${key}`;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// This demo publishes a public artifact. Admit direct PDF creation requests and
// honor explicit opt-outs anywhere in the same turn.
function requestsPublicPdf(userText: string): boolean {
  const text = userText.normalize('NFKC').trim();
  const refusesPublication = /(?:PDF|공개|게시|업로드|공유|발행)[^.!?\n]*(?:하지\s*마|하지\s*않|만들지\s*마|말고|금지)|(?:비공개|공개\s*없이|나만\s*볼)|\b(?:don['’]t|do not|never|no)\b[^.!?\n]*\b(?:pdf|publish|upload|share)\b|\b(?:private|not public|without publishing)\b/iu;
  if (refusesPublication.test(text)) return false;
  const koreanRequest = /\bPDF(?![a-z])\s*(?:파일\s*)?(?:으로|로|을|를)?\s*(?:만들어|생성해|작성해|내보내|저장해|변환해|부탁|주세요|줘)/iu;
  const englishRequest = /^(?:please\s+|(?:can|could|would)\s+you\s+)?(?:create|make|generate|export|convert|save|give\s+me)\b[^.!?\n]*\bPDF\b/iu;
  return koreanRequest.test(text) || englishRequest.test(text);
}

export function reportPdfSurface(
  base: DaemonToolSurface | undefined,
  member: { id: string; handle: string },
  sessionId: string,
  userText: string,
  publish = publishReport,
): DaemonToolSurface | undefined {
  const bucket = process.env.ELANOUS_REPORT_PDF_GCS_BUCKET;
  const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const members = process.env.ELANOUS_REPORT_PDF_TEST_MEMBER_IDS?.split(',').map((id) => id.trim());
  if (!members?.includes(member.id) || !sessionId || !requestsPublicPdf(userText)) return undefined;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(member.handle)) return undefined;
  if (!bucket || !/^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/.test(bucket) || !credentials) return undefined;
  if (base?.kind === 'none') return undefined;
  const sessionKey = JSON.stringify([member.id, sessionId]);
  return {
    kind: base?.kind ?? 'readonly',
    specs: [...(base?.specs ?? []), REPORT_SPEC],
    async dispatch(name, args, ctx) {
      if (name !== REPORT_SPEC.name) {
        if (!base) throw new Error('Unknown tool');
        return base.dispatch(name, args, ctx);
      }
      const { title, markdown } = args;
      if (typeof title !== 'string' || !title.trim() || title.length > 150
          || typeof markdown !== 'string' || !markdown.trim() || Buffer.byteLength(markdown) > MAX_REPORT_BYTES) {
        return { error: 'Supply a title of at most 150 characters and report Markdown of at most 128 KiB.' };
      }
      // Title and Markdown are the only user content rendered into the public PDF.
      // Reject before the renderer or uploader sees it, and never echo the match.
      if (isUnsafeReportText(title) || isUnsafeReportText(markdown)) {
        return { error: 'PDF was blocked because it contains a credential or internal path. Remove it before retrying.' };
      }
      if (ctx.signal.aborted) return { error: 'PDF generation was cancelled.' };
      const used = reportsBySession.get(sessionKey) ?? 0;
      if (used >= 3) return { error: 'This demo session has reached its limit of three PDF attempts.' };
      reportsBySession.set(sessionKey, used + 1);
      try {
        const url = await publish(title.trim(), markdown, bucket, member.handle, credentials, ctx.signal);
        return { url, markdownLink: `[PDF 다운로드](${url})` };
      } catch (error) {
        return { error: error instanceof RangeError ? 'PDF exceeds 2 MiB.' : 'PDF generation or upload failed.' };
      }
    },
  };
}
