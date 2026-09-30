// Explainer generator — script.json ⊕ ElevenLabs alignment → one HyperFrames composition (hf/index.html).
// Grammar (from the reference «N가지 한 번에 정리» explainer): header progress dots · black chapter cards ·
// left line-art diagram that advances one step per VO beat · right column (chapter number · title · sub · rule · caption)
// · keywords lit at the exact spoken word · bottom progress bar.
// Look = Elanvital CI only: Deepsea Blu ground · Icarus Red as the single accent · Real Black cards · CI swirl motif.
// Usage: node build.mjs <project>/script.json   (VO first: bun vo.ts <project>/script.json)
// Output: <project>/hf/ (a HyperFrames project) ⊕ <project>/timeline.json.
// Fonts (Pretendard · Geist Mono, OFL) and GSAP are fetched once into a cache, never vendored:
//   EXPLAINER_CACHE (default ~/.cache/elanous-explainer). The mark is engine/brand/elanous-mark-on-dark.svg.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(process.argv[2] ?? "script.json");
const proj = dirname(scriptPath);
const S = JSON.parse(readFileSync(scriptPath, "utf8"));
const out = join(proj, "hf");
const W = 1920, H = 1080, FPS = 30;

// ── palette (Elanvital CI · RCBC guide) ─────────────────────────────────────────
const C = { deep: "#1D2751", deep2: "#141C3D", black: "#000000", ink: "#F2F1EE", red: "#E95047", muted: "rgba(242,241,238,0.62)", line: "rgba(242,241,238,0.86)", faint: "rgba(242,241,238,0.10)" };

// ── mark (V6 «엘랑 소용돌이», docs/brand/icon) ───────────────────────────────────
const markSrc = readFileSync(process.env.ELANOUS_MARK ?? join(here, "brand", "elanous-mark-on-dark.svg"), "utf8");
const markPaths = [...markSrc.matchAll(/<path d="([^"]*)"/g)].map((m) => m[1]);
const mark = (size, blade = C.ink, dot = C.red, cls = "") =>
  `<svg class="${cls}" width="${size}" height="${size}" viewBox="150 150 724 724">${markPaths.map((d) => `<path d="${d}" fill="${blade}"/>`).join("")}<circle cx="512" cy="512" r="62" fill="${dot}"/></svg>`;

// ── timing from alignment ───────────────────────────────────────────────────────
const vo = (key) => JSON.parse(readFileSync(join(proj, "source", "vo", `${key}.json`), "utf8"));
const speech = (key) => vo(key).alignment.character_end_times_seconds.at(-1);
const GAP = 0.45, CH_TAIL = 0.8, CARD = 1.8, INTRO_LEAD = 0.5, INTRO_TAIL = 1.6, CTA = 4.5;

let t = 0;
const segs = []; // {kind, ...}
const beatsOf = (list, prefix, tail) =>
  list.map((b, i) => {
    const key = `${prefix}-${i}`, sp = speech(key);
    const start = t, dur = sp + GAP + (i === list.length - 1 ? tail : 0);
    t += dur;
    return { ...b, key, start, dur, sp };
  });
t = INTRO_LEAD;
const intro = { kind: "intro", start: 0, beats: beatsOf(S.intro.beats, "i", INTRO_TAIL) };
intro.beats[0].start = INTRO_LEAD; intro.dur = t;
segs.push(intro);
S.chapters.forEach((ch, ci) => {
  const card = { kind: "card", n: ci + 1, ch, start: t, dur: CARD };
  t += CARD;
  const seg = { kind: "chapter", n: ci + 1, ch, start: t, beats: beatsOf(ch.beats, `c${ci + 1}`, CH_TAIL) };
  seg.dur = t - seg.start;
  segs.push(card, seg);
});
const outro = { kind: "outro", start: t, beats: beatsOf(S.outro.beats, "o", CH_TAIL) };
outro.dur = t - outro.start; segs.push(outro);
const cta = { kind: "cta", start: t, dur: CTA }; t += CTA; segs.push(cta);
const TOTAL = +t.toFixed(3);

// ── helpers ─────────────────────────────────────────────────────────────────────
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const f = (x) => +x.toFixed(3);
let uid = 0;
const id = (p) => `${p}${++uid}`;
const typed = (text, cls = "") => `<span class="typed ${cls}">${[...text].map((c) => `<span class="ch">${esc(c)}</span>`).join("")}</span>`;
const tw = []; // JS tween lines appended to the timeline
const at = (sel, vars, time) => tw.push(`tl.to(${JSON.stringify(sel)}, ${JSON.stringify(vars)}, ${f(time)});`);
const from = (sel, fromV, toV, time) => tw.push(`tl.fromTo(${JSON.stringify(sel)}, ${JSON.stringify(fromV)}, ${JSON.stringify(toV)}, ${f(time)});`);
const pop = (sel, time, stagger = 0) => from(sel, { opacity: 0, scale: 0.86, y: 14 }, { opacity: 1, scale: 1, y: 0, duration: 0.42, ease: "back.out(1.8)", stagger }, time);
const rise = (sel, time, stagger = 0) => from(sel, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out", stagger }, time);
const typeIn = (sel, time, dur) => tw.push(`tl.to(${JSON.stringify(sel + " .ch")}, { opacity: 1, duration: 0.01, stagger: { amount: ${f(dur)} } }, ${f(time)});`);
const slam = (sel, time) => from(sel, { opacity: 0, scale: 1.9, rotation: -14 }, { opacity: 1, scale: 1, rotation: -8, duration: 0.32, ease: "power4.in" }, time);
const draw = (sel, time, dur = 0.5) => from(sel, { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: dur, ease: "power2.inOut" }, time);
const fade = (sel, time, to = 0, dur = 0.35) => at(sel, { opacity: to, duration: dur, ease: "power2.out" }, time);
const arrow = (x1, y1, x2, y2, cls) =>
  `<svg class="arr ${cls}" style="left:0;top:0" width="960" height="760" viewBox="0 0 960 760"><path pathLength="1" d="M${x1} ${y1} L${x2} ${y2}" /><path pathLength="1" d="M${x2 - 14} ${y2 - 12} L${x2} ${y2} L${x2 - 14} ${y2 + 12}" transform="rotate(${(Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI} ${x2} ${y2})"/></svg>`;
const B = (seg, i) => seg.beats[Math.min(i, seg.beats.length - 1)].start;

// ── diagrams: html + one step per beat ──────────────────────────────────────────
const DIAGRAMS = {
  mission(seg, p) {
    const b = (i) => B(seg, i);
    const html = `
      <div class="panel ${p}win" style="left:0;top:0;width:960px;height:330px">
        <div class="bar"><i></i><i></i><i></i><span>코딩 에이전트</span></div>
        <div class="bubble ${p}bub" style="right:34px;top:92px">${typed("미션을 보낸다", `${p}t1`)}</div>
        <div class="sys ${p}sys" style="left:34px;top:196px">보내기 전에 — 무엇이 모자라나?</div>
        <div class="mono ${p}cmd" style="left:34px;top:256px">${typed("/plugins → install elanous-basics", `${p}t2`)}</div>
      </div>
      <div class="row ${p}pills" style="left:0;top:380px">
        <span class="pill ${p}pl">도구 ✓</span><span class="pill ${p}pl">모델 ✓</span><span class="pill red ${p}pl">플러그인 ?</span>
      </div>
      <div class="panel ${p}card" style="left:0;top:500px;width:430px;height:190px">
        <div class="lbl">공식 마켓</div><div class="mono big" style="left:30px;top:74px">elanous-basics</div><div class="ok" style="left:30px;top:128px">서명된 색인 ✓</div>
      </div>
      ${arrow(440, 590, 700, 340, `${p}ar`)}
      <div class="stamp ${p}st" style="left:560px;top:540px">설치됨</div>
      <div class="contrast ${p}cx" style="left:0;top:520px">
        <span class="old ${p}old">사람이 챙긴다<i class="strike ${p}sk"></i></span><span class="to">→</span><span class="pill red solid ${p}new">에이전트가 먼저</span>
      </div>`;
    typeIn(`.${p}t1`, b(0) + 0.3, 0.9);
    rise(`.${p}sys`, b(1) + 0.1);
    pop(`.${p}pl`, b(1) + 0.9, 0.22);
    rise(`.${p}card`, b(2) + 0.2);
    draw(`.${p}ar path`, b(2) + 1.6, 0.6);
    typeIn(`.${p}t2`, b(2) + 2.4, 1.6);
    slam(`.${p}st`, b(2) + 5.2);
    fade(`.${p}card, .${p}ar, .${p}st`, b(3) - 0.1);
    rise(`.${p}old`, b(3) + 0.2);
    from(`.${p}sk`, { scaleX: 0 }, { scaleX: 1, duration: 0.4, ease: "power2.inOut" }, b(3) + 1.0);
    pop(`.${p}new`, b(3) + 1.8);
    return html;
  },
  terminal(seg, p) {
    const b = (i) => B(seg, i);
    const html = `
      <div class="panel ${p}term" style="left:0;top:40px;width:960px;height:520px">
        <div class="bar"><i></i><i></i><i></i><span>터미널</span></div>
        <div class="mono cmdl" style="left:36px;top:110px"><span class="red">$</span> ${typed("elanous plugin add ", `${p}c1`)}<span class="seg ${p}nm">${typed("elanous-basics", `${p}c2`)}<em class="${p}nml">이름</em></span>${typed("@", `${p}c3`)}<span class="seg ${p}mk">${typed("elanous", `${p}c4`)}<em class="${p}mkl">마켓</em></span></div>
        <div class="mono out ${p}o" style="left:36px;top:280px"><span class="red">✓</span> 색인 서명 확인</div>
        <div class="mono out ${p}o" style="left:36px;top:340px"><span class="red">✓</span> 패키지 해시 확인</div>
        <div class="mono out ${p}o" style="left:36px;top:400px">설치됨 · elanous-basics</div>
      </div>
      <div class="stamp ${p}st" style="left:600px;top:600px">확인 뒤에만</div>`;
    typeIn(`.${p}c1`, b(0) + 0.3, 0.8);
    typeIn(`.${p}c2`, b(0) + 1.1, 0.7);
    typeIn(`.${p}c3`, b(0) + 1.8, 0.05);
    typeIn(`.${p}c4`, b(0) + 1.9, 0.4);
    at(`.${p}nm, .${p}mk`, { borderBottomColor: C.red, duration: 0.3 }, b(1) + 0.2);
    rise(`.${p}nml`, b(1) + 0.3); rise(`.${p}mkl`, b(1) + 0.8);
    rise(`.${p}o`, b(2) + 0.6, 0.7);
    slam(`.${p}st`, b(2) + 3.0);
    return html;
  },
  nodes(seg, p) {
    const b = (i) => B(seg, i);
    const html = `
      <div class="node ${p}n1" style="left:0;top:100px">트리거</div>
      <div class="node empty ${p}slot" style="left:360px;top:100px"></div>
      <div class="node red ${p}pn" style="left:360px;top:100px">플러그인 노드<small>elanous-basics</small></div>
      <div class="node ${p}n3" style="left:720px;top:100px">결과</div>
      ${arrow(240, 160, 352, 160, `${p}a1`)}${arrow(600, 160, 712, 160, `${p}a2`)}
      <svg class="arr ${p}a3" style="left:0;top:0" width="960" height="760" viewBox="0 0 960 760"><path pathLength="1" d="M480 222 L480 318" /></svg>
      <div class="panel ${p}form" style="left:180px;top:330px;width:600px;height:390px">
        <div class="lbl">입력 폼 — 자동 생성</div>
        <div class="field ${p}fd" style="top:92px"><b>이름</b><span>텍스트</span></div>
        <div class="field ${p}fd" style="top:186px"><b>개수</b><span>숫자</span></div>
        <div class="field ${p}fd" style="top:280px"><b>형식</b><span>선택 ▾</span></div>
      </div>`;
    pop(`.${p}n1, .${p}slot, .${p}n3`, b(0) + 0.3, 0.2);
    draw(`.${p}a1 path, .${p}a2 path`, b(0) + 1.1, 0.5);
    pop(`.${p}pn`, b(1) + 0.3);
    draw(`.${p}a3 path`, b(2) + 0.2, 0.4);
    rise(`.${p}form`, b(2) + 0.5);
    rise(`.${p}fd`, b(2) + 1.1, 0.35);
    return html;
  },
  keys(seg, p) {
    const b = (i) => B(seg, i);
    const lock = `<svg width="30" height="34" viewBox="0 0 30 34"><rect x="3" y="14" width="24" height="18" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><path d="M8 14 V9 a7 7 0 0 1 14 0 V14" fill="none" stroke="currentColor" stroke-width="3"/></svg>`;
    const card = (n, k) => `<div class="kcard ${p}k ${p}k${k}" style="left:${k * 330}px;top:60px">${lock}<b>플러그인 ${n}</b><span class="${p}ks${k}">키 없음</span></div>`;
    const html = `
      ${card("A", 0)}${card("B", 1)}${card("C", 2)}
      <div class="panel ${p}door" style="left:200px;top:430px;width:560px;height:150px">
        <div class="lbl">키 넣기 ▸ 플러그인 B</div><div class="mono big" style="left:30px;top:74px">${typed("••••••••••••", `${p}pw`)}</div>
      </div>
      <div class="token ${p}tok" style="left:455px;top:480px">🔑</div>`;
    pop(`.${p}k`, b(0) + 0.3, 0.2);
    rise(`.${p}door`, b(1) + 0.1);
    typeIn(`.${p}pw`, b(1) + 0.6, 0.8);
    from(`.${p}tok`, { opacity: 0, x: 0, y: 0 }, { opacity: 1, duration: 0.2 }, b(2) + 0.1);
    at(`.${p}tok`, { x: 0, y: -300, duration: 0.8, ease: "power2.inOut" }, b(2) + 0.3);
    fade(`.${p}tok`, b(2) + 1.1, 0, 0.2);
    at(`.${p}k1`, { borderColor: C.red, color: C.red, duration: 0.25 }, b(2) + 1.1);
    tw.push(`tl.set(".${p}ks1", { textContent: "키 받음" }, ${f(b(2) + 1.1)});`);
    at(`.${p}k0, .${p}k2`, { opacity: 0.45, duration: 0.3 }, b(2) + 1.3);
    return html;
  },
  approve(seg, p) {
    const b = (i) => B(seg, i);
    const html = `
      <div class="panel ${p}br" style="left:0;top:20px;width:960px;height:640px">
        <div class="bar"><i></i><i></i><i></i><span>웹 앱 · 승인</span></div>
        <div class="lbl" style="top:84px">승인 대기 1</div>
        <div class="run ${p}run"><b>릴리스 · 공지</b><span class="pill red ${p}wait">사람 승인 대기 ⏸</span></div>
        <div class="btns ${p}btn"><span class="pill red solid ${p}ok">승인</span><span class="pill">거절</span></div>
        <div class="cursor ${p}cur"></div>
      </div>
      <div class="stamp ${p}st" style="left:560px;top:560px">승인됨</div>`;
    rise(`.${p}br`, b(0) + 0.2);
    rise(`.${p}run`, b(1) + 0.2);
    pop(`.${p}wait`, b(1) + 1.2);
    pop(`.${p}btn`, b(2) + 0.1);
    from(`.${p}cur`, { opacity: 0, x: 260, y: 160 }, { opacity: 1, x: 0, y: 0, duration: 0.8, ease: "power2.out" }, b(2) + 0.5);
    from(`.${p}ok`, { scale: 1 }, { scale: 0.92, duration: 0.08, yoyo: true, repeat: 1 }, b(2) + 1.35);
    slam(`.${p}st`, b(2) + 1.6);
    return html;
  },
  agenda(seg, p) {
    const b = (i) => B(seg, i);
    const html = `<div class="agenda">${S.chapters.map((c, i) => `<div class="acard ${p}ac"><em>${String(i + 1).padStart(2, "0")}</em><b>${esc(c.title)}</b></div>`).join("")}</div>`;
    pop(`.${p}ac`, b(0) + 1.2, 0.28);
    return html;
  },
  summary(seg, p) {
    const b = (i) => B(seg, i);
    const html = `
      <div class="col" style="left:0;top:80px"><div class="lbl2">에이전트</div>
        <span class="pill ${p}ag">모자란 것 따지기</span><span class="pill ${p}ag">플러그인 찾기</span><span class="pill ${p}ag">서명·해시 확인 · 설치</span></div>
      ${arrow(470, 175, 600, 175, `${p}ar`)}
      <div class="col" style="left:620px;top:80px"><div class="lbl2">사람</div><span class="pill red solid big ${p}hm">승인</span></div>`;
    rise(`.${p}ag`, b(0) + 0.6, 0.3);
    draw(`.${p}ar path`, b(1) + 1.8, 0.5);
    pop(`.${p}hm`, b(1) + 2.6);
    return html;
  },
};

// ── caption with timed highlights ───────────────────────────────────────────────
function caption(beat, p) {
  const a = vo(beat.key).alignment;
  const spoken = a.characters.join("");
  const map = Object.fromEntries(beat.hl ?? []);
  let html = "", hot = false;
  const lights = [];
  for (const part of beat.cap.split("**")) {
    if (hot && part) {
      const k = map[part] ?? part.split(/[ ,·@]/)[0];
      const i = spoken.indexOf(k);
      const tt = i >= 0 ? a.character_start_times_seconds[i] : 0.25;
      const cls = id(`${p}h`);
      html += `<span class="hl ${cls}">${esc(part)}</span>`;
      lights.push([cls, beat.start + tt]);
    } else html += esc(part);
    hot = !hot;
  }
  const cls = id(`${p}cap`);
  rise(`.${cls}`, beat.start, 0);
  for (const [c, tt] of lights) at(`.${c}`, { color: C.red, duration: 0.18 }, tt);
  return `<div class="clip capwrap" data-start="${f(beat.start)}" data-duration="${f(beat.dur)}"><div class="cap ${cls}">${html}</div></div>`;
}

// ── scenes ──────────────────────────────────────────────────────────────────────
const N = S.chapters.length;
const scenes = [], audios = [];
const beatAudio = (seg) => seg.beats.forEach((bt) => audios.push(`<audio id="vo-${bt.key}" src="assets/vo/${bt.key}.mp3" data-start="${f(bt.start)}" data-duration="${f(bt.sp + 0.05)}" data-track-index="20"></audio>`));
const rightCol = (seg, num, title, sub, p) => {
  const html = `<div class="right">
      <div class="num ${p}num">${num}</div>
      <div class="title ${p}ti">${esc(title)}</div><div class="sub ${p}su">${esc(sub)}</div><i class="rule ${p}ru"></i></div>`;
  from(`.${p}num`, { opacity: 0, x: 40 }, { opacity: 1, x: 0, duration: 0.6, ease: "power3.out" }, seg.start + 0.05);
  rise(`.${p}ti, .${p}su`, seg.start + 0.25, 0.12);
  from(`.${p}ru`, { scaleX: 0 }, { scaleX: 1, duration: 0.5, ease: "power3.out" }, seg.start + 0.5);
  return html;
};
for (const seg of segs) {
  const p = id("s");
  if (seg.kind === "intro" || seg.kind === "chapter" || seg.kind === "outro") {
    const dia = seg.kind === "intro" ? "agenda" : seg.kind === "outro" ? "summary" : seg.ch.diagram;
    const num = seg.kind === "chapter" ? `<span class="o">${String(seg.n).padStart(2, "0")}</span><span class="of">/${String(N).padStart(2, "0")}</span>` : seg.kind === "intro" ? `<span class="o">0.2.5</span>` : `<span class="o sm">정리</span>`;
    const title = seg.kind === "chapter" ? seg.ch.title : seg.kind === "intro" ? "엘라누스 0.2.5" : "핵심 한 줄";
    const sub = seg.kind === "chapter" ? seg.ch.sub : seg.kind === "intro" ? "다섯 가지 한 번에" : "도구는 에이전트가, 승인은 사람이";
    scenes.push(`<section class="clip scene" data-start="${f(seg.start)}" data-duration="${f(seg.dur)}" data-track-index="2">
      <div class="dia">${DIAGRAMS[dia](seg, p)}</div>${rightCol(seg, num, title, sub, p)}</section>`);
    seg.beats.forEach((bt) => scenes.push(caption(bt, p)));
    beatAudio(seg);
  } else if (seg.kind === "card") {
    scenes.push(`<section class="clip card" data-start="${f(seg.start)}" data-duration="${f(seg.dur)}" data-track-index="5">
      <div class="cardin ${p}in">${mark(120, C.ink, C.red, `cmark ${p}m`)}<div class="cn ${p}cn">${String(seg.n).padStart(2, "0")}</div><div class="ct ${p}ct">${esc(seg.ch.title)}</div></div></section>`);
    from(`.${p}in`, { opacity: 0 }, { opacity: 1, duration: 0.25 }, seg.start);
    from(`.${p}m`, { rotation: -150, scale: 0.6 }, { rotation: 0, scale: 1, duration: 0.9, ease: "power3.out" }, seg.start);
    rise(`.${p}cn, .${p}ct`, seg.start + 0.2, 0.12);
    fade(`.${p}in`, seg.start + seg.dur - 0.3, 0, 0.28);
  } else if (seg.kind === "cta") {
    scenes.push(`<section class="clip card" data-start="${f(seg.start)}" data-duration="${f(seg.dur)}" data-track-index="5">
      <div class="ctain ${p}in">${mark(220, C.ink, C.red, `ctamark ${p}m`)}<div class="brand ${p}b">Elanous</div><div class="by ${p}b">by Elanvital AI</div>
      <div class="links ${p}l">${S.outro.cta.links.map(esc).join("  ·  ")}</div></div></section>`);
    from(`.${p}in`, { opacity: 0 }, { opacity: 1, duration: 0.4 }, seg.start);
    from(`.${p}m`, { rotation: -200, scale: 0.5 }, { rotation: 0, scale: 1, duration: 1.4, ease: "power3.out" }, seg.start);
    rise(`.${p}b`, seg.start + 0.6, 0.15);
    rise(`.${p}l`, seg.start + 1.2);
  }
}

// header dots: active chapter becomes a red pill
const chapStarts = segs.filter((s) => s.kind === "card").map((s) => s.start);
chapStarts.forEach((st, i) => {
  at(`.dot${i}`, { backgroundColor: C.red, color: C.ink, borderColor: C.red, duration: 0.3 }, st);
  if (i > 0) at(`.dot${i - 1}`, { backgroundColor: "rgba(0,0,0,0)", color: C.ink, borderColor: C.line, duration: 0.3 }, st);
});
at(`.dot${N - 1}`, { backgroundColor: "rgba(0,0,0,0)", borderColor: C.line, duration: 0.3 }, outro.start);
from(".pbar i", { scaleX: 0 }, { scaleX: 1, duration: TOTAL, ease: "none" }, 0);
from(".motif", { rotation: 0 }, { rotation: 40, duration: TOTAL, ease: "none" }, 0);
rise(".hdr", 0.1);

// ── page ────────────────────────────────────────────────────────────────────────
const font = (w, file) => `@font-face{font-family:"Pretendard";src:url("assets/fonts/${file}") format("woff2");font-weight:${w};font-style:normal}`;
const html = `<!doctype html>
<html lang="ko"><head><meta charset="UTF-8" /><meta name="viewport" content="width=${W}, height=${H}" />
<title>${esc(S.title)}</title><script src="assets/gsap.min.js"></script>
<style>
${font(500, "Pretendard-Medium.woff2")}${font(700, "Pretendard-Bold.woff2")}${font(800, "Pretendard-ExtraBold.woff2")}${font(900, "Pretendard-Black.woff2")}
@font-face{font-family:"Geist Mono";src:url("assets/fonts/GeistMono-Medium.woff2") format("woff2");font-weight:500}
*{margin:0;padding:0;box-sizing:border-box}
body{background:${C.deep}}
#root{word-break:keep-all;position:relative;width:100%;height:100%;overflow:hidden;font-family:"Pretendard",sans-serif;color:${C.ink};-webkit-font-smoothing:antialiased;
  background:radial-gradient(1400px 900px at 20% 10%, #243063 0%, ${C.deep} 45%, ${C.deep2} 100%)}
.motifwrap{position:absolute;right:-420px;bottom:-520px;width:1400px;height:1400px;opacity:0.07}
.motif{width:100%;height:100%;display:block}
.hdr{position:absolute;left:72px;right:72px;top:34px;height:52px;display:flex;align-items:center;gap:18px}
.hdr .t{font-size:24px;font-weight:700;letter-spacing:-0.01em}
.hdr .sp{flex:1}
.dot{display:inline-flex;align-items:center;justify-content:center;min-width:64px;height:40px;padding:0 14px;border-radius:999px;border:2px solid ${C.line};font:500 24px "Geist Mono",monospace;color:${C.ink};margin-left:10px}
.pbar{position:absolute;left:0;right:0;bottom:0;height:8px;background:${C.faint}}
.pbar i{position:absolute;inset:0;background:${C.red};transform-origin:0 50%;display:block}
.scene{position:absolute;inset:0}
.dia{position:absolute;left:96px;top:190px;width:960px;height:760px}
.dia > *{position:absolute}
.right{position:absolute;left:1150px;top:200px;width:680px}
.num{font-weight:900;font-size:168px;line-height:1;letter-spacing:-0.04em}
.num .o{color:${C.deep};-webkit-text-stroke:3px ${C.ink};paint-order:stroke fill}
.num .o.sm{font-size:132px}
.num .of{font-size:52px;color:${C.red};-webkit-text-stroke:0;margin-left:10px;letter-spacing:0}
.title{margin-top:36px;font-weight:800;font-size:62px;line-height:1.15;letter-spacing:-0.02em;text-wrap:balance}
.sub{margin-top:16px;font-weight:500;font-size:30px;color:${C.muted}}
.rule{display:block;margin-top:34px;width:84px;height:6px;background:${C.red};transform-origin:0 50%}
.capwrap{position:absolute;left:1150px;top:800px;width:700px}
.cap{font-weight:700;font-size:38px;line-height:1.35;letter-spacing:-0.01em}
.hl{color:${C.ink};font-weight:900}
.panel{position:absolute;border:2px solid ${C.line};border-radius:22px;background:rgba(8,12,32,0.35)}
.panel > *{position:absolute}
.bar{left:0;right:0;top:0;height:58px;border-bottom:2px solid ${C.faint};display:flex;align-items:center;gap:10px;padding-left:24px}
.bar i{display:block;width:14px;height:14px;border-radius:50%;border:2px solid ${C.line}}
.bar span{margin-left:14px;font-size:22px;font-weight:700;color:${C.muted}}
.bubble{background:${C.ink};color:${C.deep};border-radius:26px 26px 6px 26px;padding:16px 28px;font-size:32px;font-weight:700}
.sys{font-size:28px;font-weight:700;color:${C.muted}}
.mono{font-family:"Geist Mono",monospace;font-weight:500;font-size:28px}
.mono.big{font-size:34px}
.cmdl{font-size:34px;white-space:nowrap}
.cmdl .seg{position:relative;border-bottom:4px solid transparent;padding-bottom:4px}
.cmdl em{position:absolute;left:0;top:64px;font:700 24px "Pretendard",sans-serif;font-style:normal;color:${C.red};white-space:nowrap}
.out{font:700 30px "Pretendard",sans-serif}
.red{color:${C.red}}
.ch{opacity:0}
.row{display:flex;gap:18px}
.pill{display:inline-flex;align-items:center;justify-content:center;border:2px solid ${C.ink};border-radius:999px;padding:12px 28px;font-size:30px;font-weight:700;white-space:nowrap}
.pill.red{border-color:${C.red};color:${C.red}}
.pill.solid{background:${C.red};color:${C.ink}}
.pill.big{font-size:56px;padding:22px 60px}
.lbl{left:30px;top:24px;font-size:22px;font-weight:700;color:${C.muted};letter-spacing:0.04em}
.ok{font-size:26px;font-weight:700;color:${C.red}}
.stamp{white-space:nowrap;border:6px solid ${C.red};color:${C.red};font-weight:900;font-size:64px;padding:8px 30px;border-radius:14px;transform:rotate(-8deg);background:rgba(20,28,61,0.7)}
.arr{position:absolute;overflow:visible}
.arr path{fill:none;stroke:${C.ink};stroke-width:4;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:1}
.contrast{display:flex;align-items:center;gap:28px}
.old{position:relative;font-size:40px;font-weight:700;color:${C.muted}}
.strike{position:absolute;left:-6px;right:-6px;top:52%;height:5px;background:${C.red};transform-origin:0 50%;display:block}
.to{font-size:44px;color:${C.muted}}
.node{width:240px;height:120px;border:2px solid ${C.line};border-radius:18px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:30px;font-weight:800}
.node.empty{border-style:dashed;border-color:${C.faint}}
.node.red{border-color:${C.red};color:${C.red};background:rgba(233,80,71,0.08)}
.node small{font:500 18px "Geist Mono",monospace;color:${C.muted};margin-top:6px}
.field{left:30px;right:30px;height:72px;border:2px solid ${C.faint};border-radius:14px;display:flex;align-items:center;justify-content:space-between;padding:0 24px;font-size:28px}
.field span{color:${C.muted};font-weight:500}
.kcard{width:280px;height:170px;border:2px solid ${C.line};border-radius:18px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:${C.ink}}
.kcard b{font-size:30px;font-weight:800}
.kcard span{font-size:22px;font-weight:700;color:inherit;opacity:0.8}
.token{width:52px;height:52px;border-radius:50%;background:${C.red};display:flex;align-items:center;justify-content:center;font-size:26px}
.run{left:30px;right:30px;top:140px;height:150px;border:2px solid ${C.faint};border-radius:16px;display:flex;align-items:center;justify-content:space-between;padding:0 30px}
.run b{font-size:36px;font-weight:800}
.btns{left:30px;top:340px;display:flex;gap:20px}
.cursor{left:92px;top:372px;width:28px;height:28px;border-radius:50%;border:4px solid ${C.ink};background:rgba(242,241,238,0.25)}
.agenda{left:0;top:40px;width:960px;display:grid;grid-template-columns:repeat(3,1fr);gap:22px}
.acard{height:190px;border:2px solid ${C.line};border-radius:18px;padding:22px 24px;display:flex;flex-direction:column;justify-content:space-between}
.acard em{font:500 26px "Geist Mono",monospace;font-style:normal;color:${C.red}}
.acard b{font-size:29px;font-weight:800;line-height:1.2}
.col{display:flex;flex-direction:column;align-items:flex-start;gap:20px}
.lbl2{font-size:26px;font-weight:700;color:${C.muted};margin-bottom:6px}
.card{position:absolute;inset:0;background:${C.black}}
.cardin,.ctain{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.cn{margin-top:40px;font:900 120px "Pretendard",sans-serif;color:${C.red};line-height:1;letter-spacing:-0.03em}
.ct{margin-top:24px;font-weight:800;font-size:72px;letter-spacing:-0.02em}
.brand{margin-top:50px;font-weight:900;font-size:110px;letter-spacing:-0.03em;line-height:1}
.by{margin-top:18px;font-weight:500;font-size:36px;color:${C.muted}}
.links{margin-top:56px;font:500 30px "Geist Mono",monospace;color:${C.muted}}
</style></head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-width="${W}" data-height="${H}" data-duration="${TOTAL}">
  <div class="motifwrap">${mark(1400, "none", "none", "motif").replace(/fill="none"/g, `fill="none" stroke="${C.ink}" stroke-width="3"`)}</div>
  <div class="hdr">${mark(48)}<span class="t">${esc(S.title)}</span><span class="sp"></span>${S.chapters.map((_, i) => `<span class="dot dot${i}">${String(i + 1).padStart(2, "0")}</span>`).join("")}</div>
  ${scenes.join("\n  ")}
  <div class="pbar"><i></i></div>
  ${audios.join("\n  ")}
</div>
<script>
const tl = gsap.timeline({ paused: true });
${tw.join("\n")}
window.__timelines["main"] = tl;
</script>
</body></html>
`;

mkdirSync(join(out, "assets", "fonts"), { recursive: true });
mkdirSync(join(out, "assets", "vo"), { recursive: true });
const CACHE = process.env.EXPLAINER_CACHE ?? join(homedir(), ".cache", "elanous-explainer");
const PD = "https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/web/static/woff2/";
const ASSETS = {
  "fonts/Pretendard-Medium.woff2": PD + "Pretendard-Medium.woff2",
  "fonts/Pretendard-Bold.woff2": PD + "Pretendard-Bold.woff2",
  "fonts/Pretendard-ExtraBold.woff2": PD + "Pretendard-ExtraBold.woff2",
  "fonts/Pretendard-Black.woff2": PD + "Pretendard-Black.woff2",
  "fonts/GeistMono-Medium.woff2": "https://cdn.jsdelivr.net/npm/geist@1.3.1/dist/fonts/geist-mono/GeistMono-Medium.woff2",
  "gsap.min.js": "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js",
};
for (const [rel, url] of Object.entries(ASSETS)) {
  const cached = join(CACHE, rel);
  if (!existsSync(cached)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`asset ${rel}: HTTP ${res.status} from ${url}`);
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
  }
  copyFileSync(cached, join(out, "assets", rel));
}
for (const s of segs) for (const bt of s.beats ?? []) copyFileSync(join(proj, "source", "vo", `${bt.key}.mp3`), join(out, "assets", "vo", `${bt.key}.mp3`));
writeFileSync(join(out, "index.html"), html);
writeFileSync(join(out, "hyperframes.json"), JSON.stringify({ $schema: "https://hyperframes.heygen.com/schema/hyperframes.json", paths: { assets: "assets" }, media: { autoProxy: true } }, null, 2) + "\n");
writeFileSync(join(out, "meta.json"), JSON.stringify({ id: "explainer", name: "explainer" }, null, 2) + "\n");
writeFileSync(join(proj, "timeline.json"), JSON.stringify({ total: TOTAL, fps: FPS, segs: segs.map(({ kind, n, start, dur, beats }) => ({ kind, n, start: f(start), dur: f(dur), beats: beats?.map((b) => ({ key: b.key, start: f(b.start), dur: f(b.dur) })) })) }, null, 2));
console.log(`wrote hf/index.html · ${TOTAL}s · ${segs.length} segments · ${audios.length} VO clips`);
