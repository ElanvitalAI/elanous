// Field feed — shared helpers for the graph nodes (graphs/field/field-feed.yaml · EV10c/EV10d).
// The draft file `<folder>/feed/feed-draft.json` is the single source of truth: the feed node writes it, the PWA
// «게시 대기» card overwrites it when a person edits, and the deliver node reads it «after» approval.
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

export type FeedSlide = { image: string; source: string; caption: string; include: boolean; renderedCaption?: string /* `N/M:caption` as last drawn */ };
export type FeedDraft = {
  kind: 'feed-draft'; version: 1; revision: number; updatedAt: string; updatedBy: 'graph' | 'human';
  graphId: 'field-feed'; runId: string | null; folder: string;
  brand: { name: string; handle: string; avatar: string | null };
  event: { title: string; date: string };
  cover: { text: string; sub: string; image: string; renderedText?: string; renderedSub?: string; renderedSource?: string };
  slides: FeedSlide[];
  caption: { hook: string; body: string };
  hashtags: string[];
  location: string | null;
  reel: string | null;
};

export const ENGINE = resolve(import.meta.dir, '../../skills/explainer-video/engine');
export const CACHE = process.env.EXPLAINER_CACHE ?? join(homedir(), '.cache', 'elanous-explainer');
const IMG = ['.jpg', '.jpeg', '.png', '.heic', '.webp'];

/** Graph context: `ELANOUS_GRAPH_CONTEXT` is a JSON string or a path to one. CLI `--folder` wins for manual runs. */
export function readContext(): { folder: string; runId: string | null } {
  const at = process.argv.indexOf('--folder');
  let folder = at >= 0 ? process.argv[at + 1] : undefined;
  let runId: string | null = null;
  const raw = process.env.ELANOUS_GRAPH_CONTEXT;
  if (raw) {
    const ctx = JSON.parse(raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf8')) as { input?: { folder?: unknown }; runId?: unknown };
    if (!folder && typeof ctx.input?.folder === 'string') folder = ctx.input.folder;
    if (typeof ctx.runId === 'string') runId = ctx.runId;
  }
  if (!folder) throw new Error('input.folder 필요(현장 폴더 절대 경로)');
  folder = resolve(folder.replace(/^~(?=\/)/, homedir()));
  if (!existsSync(folder)) throw new Error(`현장 폴더 없음: ${folder}`);
  return { folder, runId: runId ?? process.env.ELANOUS_GRAPH_RUN_ID ?? null };
}

export const draftPath = (folder: string) => join(folder, 'feed', 'feed-draft.json');

export function readDraft(folder: string): FeedDraft | null {
  try { return JSON.parse(readFileSync(draftPath(folder), 'utf8')) as FeedDraft; } catch { return null; }
}

export function writeDraft(folder: string, draft: FeedDraft): void {
  const path = draftPath(folder);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(draft, null, 2) + '\n');
  renameSync(tmp, path);
}

/** Field uploads are named `20261002T193012Z-<device>-<name>` (capture time, UTC) — same order as the reel. */
export function listPhotos(folder: string): string[] {
  const stamp = (f: string) => { const m = /^(\d{8}T\d{6}Z)-/.exec(f); return m ? m[1]! : `~${f}`; };
  return readdirSync(folder).filter((f) => IMG.includes(extname(f).toLowerCase()))
    .sort((a, b) => (stamp(a) < stamp(b) ? -1 : stamp(a) > stamp(b) ? 1 : a < b ? -1 : a > b ? 1 : 0));
}

export function kstDate(photos: string[]): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})/.exec(photos[0] ?? '');
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!) + 9 * 3600e3);
  return `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** One codex vision/text call — the same CLI the reel and card-followup use. Empty string on any failure. */
export function ask(prompt: string, images: string[], ms = 45000): Promise<string> {
  const bin = process.env.FIELD_REEL_CODEX_BIN || 'codex';
  const args = ['exec', '--skip-git-repo-check', '-c', 'model_reasoning_effort=low', prompt, ...images.flatMap((im) => ['-i', im])];
  return new Promise((done) => {
    let buf = ''; let settled = false;
    const finish = (v: string) => { if (!settled) { settled = true; done(v); } };
    let child;
    try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { finish(''); return; }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(''); }, ms);
    child.stdout.on('data', (d) => { buf += d; });
    child.on('error', () => { clearTimeout(timer); finish(''); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0 ? buf : ''); });
  });
}

const CHROME = process.env.FIELD_FEED_CHROME
  ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/chromium', '/usr/bin/google-chrome']
    .find((p) => existsSync(p));

/** HTML page → PNG at 1080×1350 with headless Chrome. */
export function screenshot(html: string, out: string): void {
  if (!CHROME) throw new Error('Chrome 없음 — FIELD_FEED_CHROME 로 지정');
  const page = out.replace(/\.png$/, '.html');
  writeFileSync(page, html);
  const r = spawnSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--window-size=1080,1350', '--virtual-time-budget=3000', '--allow-file-access-from-files', `--screenshot=${out}`, `file://${page}`],
  { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0 || !existsSync(out)) throw new Error(`screenshot ${basename(out)}: ${(r.stderr || '').slice(0, 200)}`);
}

export function markSvg(size: number): string {
  const paths = [...readFileSync(join(ENGINE, 'brand', 'elanous-mark-on-dark.svg'), 'utf8').matchAll(/<path d="([^"]*)"/g)].map((m) => m[1]);
  return `<svg width="${size}" height="${size}" viewBox="150 150 724 724">${paths.map((d) => `<path d="${d}" fill="#F2F1EE"/>`).join('')}<circle cx="512" cy="512" r="76" fill="#E95047"/></svg>`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const fonts = () => ['Bold:700', 'ExtraBold:800', 'Black:900'].map((w) => {
  const [name, weight] = w.split(':');
  return `@font-face{font-family:"Pretendard";src:url("file://${join(CACHE, 'fonts', `Pretendard-${name}.woff2`)}") format("woff2");font-weight:${weight}}`;
}).join('');
const base = `*{margin:0;padding:0;box-sizing:border-box}html,body{width:1080px;height:1350px;overflow:hidden;background:#000}
body{position:relative;font-family:"Pretendard",sans-serif;color:#F2F1EE;word-break:keep-all}
.ph{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.top{position:absolute;left:56px;top:52px;display:flex;align-items:center;gap:16px;font-weight:800;font-size:30px;text-shadow:0 2px 10px rgba(0,0,0,.6)}
.top b{color:#E95047}
.url{position:absolute;right:56px;bottom:48px;font-weight:700;font-size:26px;color:rgba(242,241,238,.7)}`;

export function coverHtml(photo: string, title: string, sub: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${fonts()}${base}
.shade{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.92) 0%,rgba(0,0,0,.55) 45%,rgba(0,0,0,.25) 100%)}
.box{position:absolute;left:72px;right:72px;bottom:150px}
.kick{font-weight:800;font-size:30px;letter-spacing:.26em;color:#E95047}
h1{margin-top:22px;font-weight:900;font-size:104px;line-height:1.1;letter-spacing:-.03em}
.rule{margin-top:34px;width:150px;height:9px;background:#E95047}
p{margin-top:26px;font-weight:700;font-size:40px;color:rgba(242,241,238,.75)}
</style></head><body><img class="ph" src="file://${esc(photo)}"/><div class="shade"></div>
<div class="top">${markSvg(54)}<span>Elanous <b>·</b> 현장 스케치</span></div>
<div class="box"><div class="kick">현장 스케치</div><h1>${esc(title)}</h1><div class="rule"></div><p>${esc(sub)}</p></div>
<div class="url">elanous.ai</div></body></html>`;
}

export function slideHtml(photo: string, caption: string, no: number, total: number): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${fonts()}${base}
.shade{position:absolute;left:0;right:0;bottom:0;height:46%;background:linear-gradient(to top,rgba(0,0,0,.86),rgba(0,0,0,0))}
.box{position:absolute;left:72px;right:72px;bottom:120px}
.no{font-weight:800;font-size:32px;letter-spacing:.12em;color:#E95047}.no i{font-style:normal;color:rgba(242,241,238,.6)}
.cap{margin-top:16px;font-weight:900;font-size:68px;line-height:1.2;letter-spacing:-.03em;text-shadow:0 3px 16px rgba(0,0,0,.6)}
.rule{margin-top:26px;width:110px;height:8px;background:#E95047}
</style></head><body><img class="ph" src="file://${esc(photo)}"/><div class="shade"></div>
<div class="top">${markSvg(48)}<span>Elanous</span></div>
<div class="box"><div class="no">${String(no).padStart(2, '0')} <i>/ ${String(total).padStart(2, '0')}</i></div><div class="cap">${esc(caption)}</div><div class="rule"></div></div>
<div class="url">elanous.ai</div></body></html>`;
}

/** Last JSON object in a model reply, or null. */
export function lastJson(text: string): Record<string, unknown> | null {
  // Try objects from the last «{» backwards; for each, the shortest closing «}» that parses.
  for (let start = text.lastIndexOf('{'); start >= 0; start = text.lastIndexOf('{', start - 1)) {
    for (let end = text.indexOf('}', start); end >= 0; end = text.indexOf('}', end + 1)) {
      try {
        const value = JSON.parse(text.slice(start, end + 1)) as unknown;
        if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
      } catch { /* longer */ }
    }
    if (start === 0) break;
  }
  return null;
}

export const result = (data: Record<string, unknown>) => console.log(JSON.stringify({ outcome: 'ok', ...data }));
