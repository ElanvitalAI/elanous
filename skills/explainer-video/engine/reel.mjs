// Field reel — a folder of phone photos / short clips → one vertical 30–60 s HyperFrames composition (EV10).
// Usage: node reel.mjs <folder> [--title "마케터의 밤"] [--sub "2026.10.02 · 서울"] [--max 60] [--min 30]
//   <folder>/captions.txt (optional): one line per item — `파일명 | 자막` (a line without « | » is ignored).
// Output: <folder>/reel/hf/ (HyperFrames project) ⊕ reel/timeline.json. Render: npx hyperframes render --fps 30 in reel/hf.
// Look = Elanvital CI: Real Black ground · Icarus Red single accent · V6 mark · Pretendard. Order = capture time (then name).
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, extname, basename } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const folder = resolve(argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--"))) ?? ".");
const TITLE = opt("title", "현장 스케치"), SUB = opt("sub", ""), MAX = Number(opt("max", 60)), MIN = Number(opt("min", 30));
const W = 1080, H = 1920, INTRO = 2.2, END = 3.0, PHOTO = 3.5, CLIP_MAX = 5, XF = 0.35;
const out = join(folder, "reel"), hf = join(out, "hf"), media = join(hf, "assets", "media");
mkdirSync(media, { recursive: true }); mkdirSync(join(hf, "assets", "fonts"), { recursive: true });

// ── collect & order ────────────────────────────────────────────────────────────
const IMG = [".jpg", ".jpeg", ".png", ".heic", ".webp"], VID = [".mp4", ".mov", ".m4v"];
const run = (bin, args) => spawnSync(bin, args, { encoding: "utf8" });
// Uploads from the field endpoint are named `20261002T193012Z-<device>-<name>` (capture time, UTC) — trust that first.
const stamped = (f) => { const m = /^(\d{8})T(\d{6})Z-/.exec(f); return m ? Date.parse(`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6)}T${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4)}Z`) : NaN; };
const created = (p) => {
  const st = stamped(basename(p)); if (Number.isFinite(st)) return st;
  const m = run("mdls", ["-raw", "-name", "kMDItemContentCreationDate", p]).stdout?.trim();
  const t = m && m !== "(null)" ? Date.parse(m.replace(" +0000", "Z").replace(" ", "T")) : NaN;
  return Number.isFinite(t) ? t : statSync(p).mtimeMs;
};
const probeDur = (p) => Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p]).stdout.trim()) || 0;
const caps = Object.fromEntries((existsSync(join(folder, "captions.txt")) ? readFileSync(join(folder, "captions.txt"), "utf8") : "")
  .split("\n").filter((l) => l.includes("|")).map((l) => l.split("|").map((s) => s.trim())));
let items = readdirSync(folder).filter((f) => [...IMG, ...VID].includes(extname(f).toLowerCase()))
  .map((f) => ({ f, p: join(folder, f), video: VID.includes(extname(f).toLowerCase()), t: created(join(folder, f)) }))
  .sort((a, b) => a.t - b.t || a.f.localeCompare(b.f));
if (!items.length) throw new Error(`no photos or clips in ${folder}`);

// ── durations: fit into [MIN, MAX] ─────────────────────────────────────────────
for (const it of items) it.dur = it.video ? Math.min(CLIP_MAX, Math.max(1.5, probeDur(it.p))) : PHOTO;
const body = () => items.reduce((a, it) => a + it.dur, 0);
while (INTRO + body() + END > MAX && items.length > 1) items.splice(Math.floor(items.length / 2), 1); // drop from the middle, keep first & last
if (INTRO + body() + END < MIN) { const photos = items.filter((i) => !i.video); const need = MIN - (INTRO + body() + END); for (const p of photos) p.dur += need / Math.max(1, photos.length); }

// ── media prep: HEIC → jpg · big photos down to 2160 · clips re-encoded short & muted ──
let t = INTRO;
items.forEach((it, i) => {
  it.start = +t.toFixed(3); t += it.dur;
  if (it.video) {
    it.src = `m${i}.mp4`;
    const r = run("ffmpeg", ["-v", "error", "-y", "-i", it.p, "-t", String(it.dur), "-an", "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=30`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", join(media, it.src)]);
    if (r.status !== 0) throw new Error(`clip ${it.f}: ${r.stderr.slice(0, 200)}`);
  } else {
    it.src = `m${i}.jpg`;
    const r = run("sips", ["-s", "format", "jpeg", "-Z", "2160", it.p, "--out", join(media, it.src)]);
    if (r.status !== 0) throw new Error(`photo ${it.f}: ${r.stderr.slice(0, 200)}`);
  }
  it.cap = caps[it.f] ?? "";
});
const TOTAL = +(t + END).toFixed(3);

// ── assets (same cache as build.mjs) ───────────────────────────────────────────
const CACHE = process.env.EXPLAINER_CACHE ?? join(homedir(), ".cache", "elanous-explainer");
const PD = "https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/web/static/woff2/";
const ASSETS = { "fonts/Pretendard-Bold.woff2": PD + "Pretendard-Bold.woff2", "fonts/Pretendard-ExtraBold.woff2": PD + "Pretendard-ExtraBold.woff2", "fonts/Pretendard-Black.woff2": PD + "Pretendard-Black.woff2", "gsap.min.js": "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js" };
for (const [rel, url] of Object.entries(ASSETS)) {
  const c = join(CACHE, rel);
  if (!existsSync(c)) { const res = await fetch(url); if (!res.ok) throw new Error(`asset ${rel}: HTTP ${res.status}`); mkdirSync(dirname(c), { recursive: true }); writeFileSync(c, Buffer.from(await res.arrayBuffer())); }
  copyFileSync(c, join(hf, "assets", rel));
}
const markPaths = [...readFileSync(join(here, "brand", "elanous-mark-on-dark.svg"), "utf8").matchAll(/<path d="([^"]*)"/g)].map((m) => m[1]);
const mark = (s, cls = "") => `<svg class="${cls}" width="${s}" height="${s}" viewBox="150 150 724 724">${markPaths.map((d) => `<path d="${d}" fill="#F2F1EE"/>`).join("")}<circle cx="512" cy="512" r="76" fill="#E95047"/></svg>`;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const f = (x) => +x.toFixed(3);

// ── composition ────────────────────────────────────────────────────────────────
const tw = [];
const clips = items.map((it, i) => {
  const vis = it.video
    ? `<video id="v${i}" class="clip med" src="assets/media/${it.src}" muted playsinline data-start="${f(it.start)}" data-duration="${f(it.dur)}" data-track-index="1"></video>`
    : `<div class="clip med" data-start="${f(it.start)}" data-duration="${f(it.dur)}" data-track-index="1"><img class="kb k${i}" src="assets/media/${it.src}"/></div>`;
  if (!it.video) tw.push(`tl.fromTo(".k${i}", {scale:1.0, x:0}, {scale:1.09, x:${i % 2 ? -24 : 24}, duration:${f(it.dur)}, ease:"none"}, ${f(it.start)});`);
  const cap = it.cap ? `<div class="clip capw" data-start="${f(it.start)}" data-duration="${f(it.dur)}" data-track-index="3"><div class="cap c${i}">${esc(it.cap)}</div></div>` : "";
  if (it.cap) tw.push(`tl.fromTo(".c${i}", {opacity:0, y:20}, {opacity:1, y:0, duration:0.4, ease:"power3.out"}, ${f(it.start + 0.15)});`);
  return vis + cap;
}).join("\n");
tw.push(`tl.fromTo(".it", {opacity:0, y:30}, {opacity:1, y:0, duration:0.5, stagger:0.15, ease:"power3.out"}, 0.1);`);
tw.push(`tl.fromTo(".im", {rotation:-160, scale:0.6}, {rotation:0, scale:1, duration:1.0, ease:"power3.out"}, 0.0);`);
tw.push(`tl.fromTo(".em", {rotation:-200, scale:0.5}, {rotation:0, scale:1, duration:1.2, ease:"power3.out"}, ${f(t)});`);
tw.push(`tl.fromTo(".et", {opacity:0, y:20}, {opacity:1, y:0, duration:0.5, stagger:0.12}, ${f(t + 0.5)});`);
tw.push(`tl.fromTo(".bar i", {scaleX:0}, {scaleX:1, duration:${TOTAL}, ease:"none"}, 0);`);
const html = `<!doctype html><html lang="ko"><head><meta charset="UTF-8"/><meta name="viewport" content="width=${W}, height=${H}"/><title>${esc(TITLE)}</title><script src="assets/gsap.min.js"></script><style>
@font-face{font-family:"Pretendard";src:url("assets/fonts/Pretendard-Bold.woff2") format("woff2");font-weight:700}
@font-face{font-family:"Pretendard";src:url("assets/fonts/Pretendard-ExtraBold.woff2") format("woff2");font-weight:800}
@font-face{font-family:"Pretendard";src:url("assets/fonts/Pretendard-Black.woff2") format("woff2");font-weight:900}
*{margin:0;padding:0;box-sizing:border-box}
#root{position:relative;width:100%;height:100%;overflow:hidden;background:#000;font-family:"Pretendard",sans-serif;color:#F2F1EE;word-break:keep-all}
.med{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;overflow:hidden}
.kb{width:100%;height:100%;object-fit:cover;display:block}
.shade{z-index:2;position:absolute;left:0;right:0;bottom:0;height:46%;background:linear-gradient(to top,rgba(0,0,0,.78),rgba(0,0,0,0));pointer-events:none}
.top{z-index:5;position:absolute;left:56px;right:56px;top:72px;display:flex;align-items:center;gap:18px;font-weight:800;font-size:34px;text-shadow:0 2px 12px rgba(0,0,0,.6)}
.top b{color:#E95047;font-weight:800}
.capw{z-index:4;position:absolute;left:64px;right:64px;bottom:250px}
.cap{font-weight:800;font-size:64px;line-height:1.25;letter-spacing:-0.02em;text-shadow:0 3px 16px rgba(0,0,0,.7)}
.card{z-index:6;position:absolute;inset:0;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 80px}
.card h1{margin-top:60px;font-weight:900;font-size:104px;line-height:1.1;letter-spacing:-0.03em}
.card p{margin-top:28px;font-weight:700;font-size:40px;color:rgba(242,241,238,.62)}
.card .red{color:#E95047}
.bar{z-index:7;position:absolute;left:0;right:0;bottom:0;height:10px;background:rgba(242,241,238,.12)}
.bar i{position:absolute;inset:0;background:#E95047;transform-origin:0 50%;display:block}
</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-width="${W}" data-height="${H}" data-duration="${TOTAL}">
<section class="clip card" data-start="0" data-duration="${INTRO}" data-track-index="5">${mark(220, "im")}<h1 class="it">${esc(TITLE)}</h1>${SUB ? `<p class="it">${esc(SUB)}</p>` : ""}</section>
${clips}
<div class="shade"></div>
<div class="top">${mark(60)}<span>Elanous <b>·</b> ${esc(TITLE)}</span></div>
<section class="clip card" data-start="${f(t)}" data-duration="${END}" data-track-index="5">${mark(240, "em")}<h1 class="et">Elanous</h1><p class="et">현장에서 바로 만든 영상</p><p class="et red">elanous.ai</p></section>
<div class="bar"><i></i></div>
</div>
<script>const tl = gsap.timeline({ paused: true });
${tw.join("\n")}
window.__timelines["main"] = tl;</script></body></html>`;
writeFileSync(join(hf, "index.html"), html);
writeFileSync(join(hf, "hyperframes.json"), JSON.stringify({ $schema: "https://hyperframes.heygen.com/schema/hyperframes.json", paths: { assets: "assets" }, media: { autoProxy: true } }, null, 2) + "\n");
writeFileSync(join(hf, "meta.json"), JSON.stringify({ id: "reel", name: "reel" }, null, 2) + "\n");
writeFileSync(join(out, "timeline.json"), JSON.stringify({ total: TOTAL, items: items.map(({ f: file, video, start, dur, cap }) => ({ file, video, start, dur: f(dur), cap })) }, null, 2));
console.log(`reel: ${items.length} items · ${TOTAL}s · ${items.filter((i) => i.cap).length} captions → ${hf}`);
