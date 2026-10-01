// Field reel — a folder of phone photos / short clips → one vertical HyperFrames composition (EV10 · EV10b).
// Usage: node reel.mjs <folder> [--title "마케터의 밤"] [--sub "2026.10.02 · 서울"] [--max 60] [--min 24] [--part full|body]
//   <folder>/captions.txt (optional): one line per item — `파일명 | 자막` (a line without « | » is ignored).
//   Photos without a caption get one line from a vision model (codex · parallel · FIELD_REEL_VISION=0 turns it off);
//   if that fails the caption is «현장 N». A slug-like title (`field-2026-10-01`) is replaced by a vision headline.
//   BGM: FIELD_REEL_BGM=<wav/mp3> or ~/.cache/elanous-explainer/bgm/field.wav — cut to length, faded and leveled here.
//   --part body: photos only, no intro/end cards and no music (the instant version stitches cached cards around it).
// Output: <folder>/reel/hf/ (HyperFrames project) ⊕ reel/timeline.json. Render: npx hyperframes render --fps 30 in reel/hf.
// Look = Elanvital CI: Real Black ground · Icarus Red single accent · V6 mark · Pretendard. Order = capture time (then name).
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, extname, basename } from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const folder = resolve(argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--"))) ?? ".");
const PART = opt("part", "full");
const MAX = Number(opt("max", 60)), MIN = Number(opt("min", 24));
const W = 1080, H = 1920, PHOTO = 4.2, CLIP_MAX = 5, XF = 0.5;
const INTRO = PART === "body" ? 0 : 3.0, END = PART === "body" ? 0 : 3.4;
const out = join(folder, "reel"), hf = join(out, "hf"), media = join(hf, "assets", "media");
mkdirSync(media, { recursive: true }); mkdirSync(join(hf, "assets", "fonts"), { recursive: true });
const T0 = Date.now(), lap = (s) => console.log(`reel: ${s} · ${((Date.now() - T0) / 1000).toFixed(1)}s`);

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
if (PART !== "body" && INTRO + body() + END < MIN) { const photos = items.filter((i) => !i.video); const need = MIN - (INTRO + body() + END); for (const p of photos) p.dur += need / Math.max(1, photos.length); }

// ── media prep: HEIC → jpg · big photos down to 2160 · a small copy for the vision model · clips re-encoded short & muted ──
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
    const dim = run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", join(media, it.src)]).stdout;
    const pw = Number(/pixelWidth: (\d+)/.exec(dim)?.[1]), ph = Number(/pixelHeight: (\d+)/.exec(dim)?.[1]);
    it.wide = pw > 0 && ph > 0 && pw / ph > 0.75; // anything wider than 3:4 is shown whole over a blurred fill
    run("sips", ["-s", "format", "jpeg", "-Z", "1024", it.p, "--out", join(out, `v${i}.jpg`)]);
  }
});
const TOTAL = +(t + END).toFixed(3);
lap(`${items.length} items prepared`);

// ── vision: one caption line per photo, in parallel; a headline when the title is only a slug ──
const CODEX = process.env.FIELD_REEL_CODEX_BIN || "codex";
const VISION = process.env.FIELD_REEL_VISION !== "0";
const ask = (prompt, images, ms = 30000) => new Promise((done) => {
  const args = ["exec", "--skip-git-repo-check", "-c", "model_reasoning_effort=low", prompt, ...images.flatMap((im) => ["-i", im])];
  let buf = "", settled = false;
  const finish = (v) => { if (!settled) { settled = true; done(v); } };
  let child;
  try { child = spawn(CODEX, args, { stdio: ["ignore", "pipe", "ignore"] }); } catch { return finish(""); }
  const timer = setTimeout(() => { child.kill("SIGKILL"); finish(""); }, ms);
  child.stdout.on("data", (d) => { buf += d; });
  child.on("error", () => { clearTimeout(timer); finish(""); });
  child.on("close", (code) => { clearTimeout(timer); finish(code === 0 ? buf : ""); });
});
const oneLine = (s, max) => {
  const line = s.split("\n").map((l) => l.trim().replace(/^["'«“]|["'»”]$/g, "")).filter(Boolean).pop() ?? "";
  return line.length >= 2 && line.length <= max ? line.replace(/[.。]$/, "") : "";
};
const CAP_PROMPT = "행사 현장 사진이다. 세로 영상 자막으로 쓸 한국어 한 줄을 출력하라 — 18자 이내 · 마침표 없이 · 보이는 장면만 · 사람 이름·외모 묘사·추측 금지 · 화면 속 글자(행사명·회사명)는 읽히면 써도 된다. 그 한 줄만.";
const HEAD_PROMPT = "같은 행사에서 찍은 사진들이다. 영상 첫 화면 제목으로 쓸 한국어 행사 이름 한 줄을 출력하라 — 16자 이내 · 화면 속 글자에서 읽히는 행사·회사 이름을 우선 · 읽히지 않으면 장면을 짧게(예: «상장 기념식 현장») · 추측 금지. 그 한 줄만.";
const slugTitle = (s) => !s || /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(s);
let TITLE = opt("title", ""), SUB = opt("sub", "");
const photos = items.filter((it) => !it.video);
const VT0 = Date.now();
const jobs = VISION ? [
  ...photos.filter((it) => !caps[it.f]).map(async (it) => { it.vcap = oneLine(await ask(CAP_PROMPT, [join(out, `v${items.indexOf(it)}.jpg`)]), 22); }),
  ...(PART !== "body" && slugTitle(TITLE) && photos.length ? [(async () => { TITLE = oneLine(await ask(HEAD_PROMPT, photos.slice(0, 3).map((it) => join(out, `v${items.indexOf(it)}.jpg`))), 20) || TITLE; })()] : []),
] : [];
await Promise.all(jobs);
const visionMs = Date.now() - VT0;
items.forEach((it, i) => { it.cap = caps[it.f] || it.vcap || (it.video ? "" : `현장 ${i + 1}`); });
if (slugTitle(TITLE)) TITLE = "현장 스케치";
if (!SUB) { const d = new Date(items[0].t + 9 * 3600e3); SUB = `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${String(d.getUTCDate()).padStart(2, "0")}`; }
lap(`vision ${jobs.length ? `${items.filter((i) => i.vcap).length}/${photos.filter((p) => !caps[p.f]).length} captions` : "off"} · title «${TITLE}»`);

// ── assets (same cache as build.mjs) ───────────────────────────────────────────
const CACHE = process.env.EXPLAINER_CACHE ?? join(homedir(), ".cache", "elanous-explainer");
const PD = "https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/web/static/woff2/";
const ASSETS = { "fonts/Pretendard-Bold.woff2": PD + "Pretendard-Bold.woff2", "fonts/Pretendard-ExtraBold.woff2": PD + "Pretendard-ExtraBold.woff2", "fonts/Pretendard-Black.woff2": PD + "Pretendard-Black.woff2", "gsap.min.js": "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js" };
for (const [rel, url] of Object.entries(ASSETS)) {
  const c = join(CACHE, rel);
  if (!existsSync(c)) { const res = await fetch(url); if (!res.ok) throw new Error(`asset ${rel}: HTTP ${res.status}`); mkdirSync(dirname(c), { recursive: true }); writeFileSync(c, Buffer.from(await res.arrayBuffer())); }
  copyFileSync(c, join(hf, "assets", rel));
}

// ── music: cut to length · fade in/out · level to about -16 LUFS (the whole mix is music) ──
const BGM = process.env.FIELD_REEL_BGM || join(CACHE, "bgm", "field.wav");
let music = "";
if (PART !== "body" && existsSync(BGM)) {
  const r = run("ffmpeg", ["-v", "error", "-y", "-i", BGM, "-t", String(TOTAL), "-af", `afade=t=in:d=0.4,afade=t=out:st=${f(TOTAL - 1.6)}:d=1.6,loudnorm=I=-16:TP=-1.5:LRA=9`, "-ar", "48000", "-ac", "2", join(media, "bgm.wav")]);
  if (r.status === 0) music = "bgm.wav"; else console.error(`reel: music skipped — ${r.stderr.slice(0, 160)}`);
}
function f(x) { return +x.toFixed(3); }

const markPaths = [...readFileSync(join(here, "brand", "elanous-mark-on-dark.svg"), "utf8").matchAll(/<path d="([^"]*)"/g)].map((m) => m[1]);
const mark = (s, cls = "") => `<svg class="${cls}" width="${s}" height="${s}" viewBox="150 150 724 724">${markPaths.map((d) => `<path d="${d}" fill="#F2F1EE"/>`).join("")}<circle cx="512" cy="512" r="76" fill="#E95047"/></svg>`;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const words = (s, cls) => s.split(/\s+/).filter(Boolean).map((w) => `<span class="${cls}">${esc(w)}</span>`).join(" ");

// ── composition ────────────────────────────────────────────────────────────────
// Each photo: blurred fill + the whole photo (wide) or a full-bleed crop (tall) · slow push · a cross-move into the next ·
// a red wipe on the cut · counter «0N / 0M» · caption words rising one by one.
const tw = [];
const n = items.length;
const clips = items.map((it, i) => {
  const s = it.start, d = it.dur, last = i === n - 1;
  const span = last ? d : d + XF; // overlap the next item so the move reads as one motion
  let vis;
  if (it.video) {
    vis = `<video id="v${i}" class="clip med" src="assets/media/${it.src}" muted playsinline data-start="${f(s)}" data-duration="${f(d)}" data-track-index="1"></video>`;
  } else if (it.wide) {
    vis = `<div class="clip med" data-start="${f(s)}" data-duration="${f(span)}" data-track-index="${1 + (i % 2)}"><div class="g g${i}">`
      + `<img class="fill" src="assets/media/${it.src}"/><div class="dim"></div>`
      + `<div class="frame fr${i}"><img src="assets/media/${it.src}"/></div></div></div>`;
    tw.push(`tl.fromTo(".fr${i}", {scale:1.0, x:${i % 2 ? 30 : -30}}, {scale:1.12, x:${i % 2 ? -30 : 30}, duration:${f(span)}, ease:"none"}, ${f(s)});`);
    tw.push(`tl.fromTo(".g${i} .fill", {scale:1.25}, {scale:1.4, duration:${f(span)}, ease:"none"}, ${f(s)});`);
  } else {
    vis = `<div class="clip med" data-start="${f(s)}" data-duration="${f(span)}" data-track-index="${1 + (i % 2)}"><div class="g g${i}"><img class="kb k${i}" src="assets/media/${it.src}"/></div></div>`;
    tw.push(`tl.fromTo(".k${i}", {scale:1.02, x:0}, {scale:1.12, x:${i % 2 ? -28 : 28}, duration:${f(span)}, ease:"none"}, ${f(s)});`);
  }
  if (!it.video && i > 0) tw.push(`tl.fromTo(".g${i}", {opacity:0, xPercent:${i % 2 ? 14 : -14}}, {opacity:1, xPercent:0, duration:${XF}, ease:"power3.out"}, ${f(s - XF)});`);
  if (i > 0) tw.push(`tl.fromTo(".wipe", {scaleY:0, transformOrigin:"50% 100%"}, {scaleY:1, duration:${XF / 2}, ease:"power2.in", immediateRender:false}, ${f(s - XF / 2)});`
    + `tl.to(".wipe", {scaleY:0, transformOrigin:"50% 0%", duration:${XF / 2}, ease:"power2.out"}, ${f(s)});`);
  const no = `${String(i + 1).padStart(2, "0")} <i>/ ${String(n).padStart(2, "0")}</i>`;
  const cap = it.cap ? `<div class="clip capw" data-start="${f(s)}" data-duration="${f(d)}" data-track-index="4"><div class="no n${i}">${no}</div><div class="cap c${i}">${words(it.cap, `w w${i}`)}</div><div class="rule r${i}"></div></div>` : "";
  if (it.cap) {
    tw.push(`tl.fromTo(".n${i}", {opacity:0, x:-24}, {opacity:1, x:0, duration:0.35, ease:"power3.out"}, ${f(s + 0.2)});`);
    tw.push(`tl.fromTo(".r${i}", {scaleX:0}, {scaleX:1, duration:0.5, ease:"power3.out"}, ${f(s + 0.25)});`);
    tw.push(`tl.fromTo(".w${i}", {opacity:0, y:46}, {opacity:1, y:0, duration:0.45, stagger:0.09, ease:"power3.out"}, ${f(s + 0.35)});`);
    if (!last) tw.push(`tl.to(".c${i}, .n${i}, .r${i}", {opacity:0, duration:0.25}, ${f(s + d - 0.3)});`);
  }
  return vis + cap;
}).join("\n");

const intro = PART === "body" ? "" : `<section class="clip card" data-start="0" data-duration="${INTRO}" data-track-index="6">`
  + `<div class="kick ik">현장 스케치</div>${mark(200, "im")}<h1>${words(TITLE, "it")}</h1><div class="line il"></div><p class="is">${esc(SUB)}</p></section>`;
const end = PART === "body" ? "" : `<section class="clip card" data-start="${f(t)}" data-duration="${END}" data-track-index="6">`
  + `${mark(230, "em")}<h1 class="et">Elanous</h1><p class="et">사진을 올리면, 영상이 됩니다</p><p class="et red">elanous.ai</p></section>`;
if (PART !== "body") {
  tw.push(`tl.fromTo(".ik", {opacity:0, letterSpacing:"0.6em"}, {opacity:1, letterSpacing:"0.28em", duration:0.8, ease:"power3.out"}, 0.1);`);
  tw.push(`tl.fromTo(".im", {rotation:-160, scale:0.6, opacity:0}, {rotation:0, scale:1, opacity:1, duration:1.0, ease:"power3.out"}, 0.0);`);
  tw.push(`tl.fromTo(".it", {opacity:0, y:50}, {opacity:1, y:0, duration:0.55, stagger:0.1, ease:"power3.out"}, 0.45);`);
  tw.push(`tl.fromTo(".il", {scaleX:0}, {scaleX:1, duration:0.6, ease:"power3.inOut"}, 0.9);`);
  tw.push(`tl.fromTo(".is", {opacity:0, y:16}, {opacity:1, y:0, duration:0.45, ease:"power3.out"}, 1.15);`);
  tw.push(`tl.fromTo(".em", {rotation:-200, scale:0.5}, {rotation:0, scale:1, duration:1.2, ease:"power3.out"}, ${f(t)});`);
  tw.push(`tl.fromTo(".et", {opacity:0, y:20}, {opacity:1, y:0, duration:0.5, stagger:0.14, ease:"power3.out"}, ${f(t + 0.5)});`);
}
tw.unshift(`tl.set(".wipe", {scaleY:0}, 0);`);
tw.push(`tl.fromTo(".bar i", {scaleX:0}, {scaleX:1, duration:${TOTAL}, ease:"none"}, 0);`);
const audio = music ? `<audio id="bgm" src="assets/media/${music}" data-start="0" data-duration="${TOTAL}" data-track-index="9"></audio>` : "";
const html = `<!doctype html><html lang="ko"><head><meta charset="UTF-8"/><meta name="viewport" content="width=${W}, height=${H}"/><title>${esc(TITLE)}</title><script src="assets/gsap.min.js"></script><style>
@font-face{font-family:"Pretendard";src:url("assets/fonts/Pretendard-Bold.woff2") format("woff2");font-weight:700}
@font-face{font-family:"Pretendard";src:url("assets/fonts/Pretendard-ExtraBold.woff2") format("woff2");font-weight:800}
@font-face{font-family:"Pretendard";src:url("assets/fonts/Pretendard-Black.woff2") format("woff2");font-weight:900}
*{margin:0;padding:0;box-sizing:border-box}
#root{position:relative;width:100%;height:100%;overflow:hidden;background:#000;font-family:"Pretendard",sans-serif;color:#F2F1EE;word-break:keep-all}
.med{position:absolute;inset:0;width:100%;height:100%;overflow:hidden}
.g{position:absolute;inset:0;overflow:hidden}
.kb{width:100%;height:100%;object-fit:cover;display:block}
.fill{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:blur(42px) saturate(1.2);opacity:.85}
.dim{position:absolute;inset:0;background:rgba(0,0,0,.42)}
.frame{position:absolute;left:0;right:0;top:420px;height:960px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.55)}
.frame img{width:100%;height:100%;object-fit:cover;display:block}
.shade{z-index:3;position:absolute;left:0;right:0;bottom:0;height:42%;background:linear-gradient(to top,rgba(0,0,0,.82),rgba(0,0,0,0));pointer-events:none}
.top{z-index:5;position:absolute;left:56px;right:56px;top:72px;display:flex;align-items:center;gap:18px;font-weight:800;font-size:34px;text-shadow:0 2px 12px rgba(0,0,0,.6)}
.top b{color:#E95047;font-weight:800}
.capw{z-index:4;position:absolute;left:64px;right:64px;bottom:210px}
.no{font-weight:800;font-size:34px;letter-spacing:.12em;color:#E95047}
.no i{font-style:normal;color:rgba(242,241,238,.55)}
.cap{margin-top:18px;font-weight:900;font-size:76px;line-height:1.18;letter-spacing:-0.03em;text-shadow:0 3px 18px rgba(0,0,0,.7)}
.w{display:inline-block}
.rule{margin-top:26px;width:120px;height:8px;background:#E95047;transform-origin:0 50%}
.wipe{z-index:8;position:absolute;inset:0;background:#E95047}
.card{z-index:7;position:absolute;inset:0;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 80px}
.kick{margin-bottom:56px;font-weight:800;font-size:32px;letter-spacing:.28em;color:#E95047}
.card h1{margin-top:56px;font-weight:900;font-size:100px;line-height:1.12;letter-spacing:-0.03em}
.card h1 span{display:inline-block}
.line{margin-top:40px;width:160px;height:8px;background:#E95047}
.card p{margin-top:28px;font-weight:700;font-size:42px;color:rgba(242,241,238,.66)}
.card .red{color:#E95047}
.bar{z-index:9;position:absolute;left:0;right:0;bottom:0;height:10px;background:rgba(242,241,238,.12)}
.bar i{position:absolute;inset:0;background:#E95047;transform-origin:0 50%;display:block}
</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-width="${W}" data-height="${H}" data-duration="${TOTAL}">
${intro}
${clips}
<div class="shade"></div>
<div class="top">${mark(60)}<span>Elanous <b>·</b> ${esc(TITLE)}</span></div>
<div class="wipe"></div>
${end}
<div class="bar"><i></i></div>
${audio}
</div>
<script>const tl = gsap.timeline({ paused: true });
${tw.join("\n")}
window.__timelines["main"] = tl;</script></body></html>`;
writeFileSync(join(hf, "index.html"), html);
writeFileSync(join(hf, "hyperframes.json"), JSON.stringify({ $schema: "https://hyperframes.heygen.com/schema/hyperframes.json", paths: { assets: "assets" }, media: { autoProxy: true } }, null, 2) + "\n");
writeFileSync(join(hf, "meta.json"), JSON.stringify({ id: "reel", name: "reel" }, null, 2) + "\n");
writeFileSync(join(out, "timeline.json"), JSON.stringify({ total: TOTAL, part: PART, title: TITLE, sub: SUB, music: Boolean(music),
  vision: { enabled: VISION, calls: jobs.length, captioned: items.filter((i) => i.vcap).length, fallback: items.filter((i) => !i.video && !caps[i.f] && !i.vcap).length, ms: visionMs }, items: items.map(({ f: file, video, start, dur, cap, vcap }) => ({ file, video, start, dur: f(dur), cap, vision: Boolean(vcap) })) }, null, 2));
console.log(`reel: ${items.length} items · ${TOTAL}s · ${items.filter((i) => i.vcap).length} vision captions · music ${music ? "on" : "off"} → ${hf}`);
