#!/usr/bin/env bun
// ── 장면표(scenes.json) 한 벌에서 SRT·VO 대본을 뽑고, 공개 전 검사를 한다 ──────
//
// 계기(DEMO-VIDEO-1008 · 2026-10-07): 스토리보드 SRT 초안이 «한 줄 22자 · 두 줄»을
//   스스로 어겼다(한 블록 세 줄 · 24자 줄). 자막·VO·숫자 카드가 표 «셋»에 따로 있으면
//   한쪽만 고쳐지고 갈린다 ⇒ 장면표가 SSOT 이고 SRT·VO 는 «뽑아낸 것»이다.
//
// 사용:
//   bun scripts/video/scene-table.ts check <scenes.json>   검사(exit 0 통과 · 1 걸림 · 3 입력 불량)
//   bun scripts/video/scene-table.ts srt   <scenes.json>   한국어 SRT 를 stdout 으로(검사 통과 때만)
//   bun scripts/video/scene-table.ts vo    <scenes.json>   영어 VO 대본(장면 번호 · 시각)을 stdout 으로
//
// ⛔ 숫자 자리표시 `{{KEY}}` 는 `measured.KEY.value` 로만 채운다 — 값이 없으면 «걸림»이다(지어낸 수치 금지).

import { readFileSync } from 'node:fs';

export type Cue = { start: number; end: number; lines: string[] };
export type Scene = {
  n: number; start: number; end: number; source: string[];
  vo?: string | null; ko?: Cue[]; numberCard?: string; requestText?: string;
};
export type SceneTable = {
  durationSec: number;
  vo?: { maxWpm?: number };
  subtitles?: { maxCharsPerLine?: number; maxLines?: number };
  measured?: Record<string, { value?: number | string | null }>;
  scenes: Scene[];
};

// 공개 수위: 특허 보류 기전 · 경쟁사 이름 · 미래 약속 · 내부 표식 · 기기 경로.
// 단어 경계가 없는 한국어는 부분 일치로 잡는다.
export const BANNED: Array<{ re: RegExp; why: string }> = [
  { re: /시냅스|synap/i, why: '특허 보류 기전' },
  { re: /수면|\bsleep/i, why: '특허 보류 기전' },
  { re: /그라운딩\s*방아쇠|grounding\s+trigger/i, why: '특허 보류 기전' },
  { re: /선제\s*PTY|pre-?emptive\s+PTY/i, why: '특허 보류 기전' },
  { re: /면역|immun|암\s*억제|\bcancer\b/i, why: '특허 보류 기전' },
  { re: /openclaw|hermes|codex|cursor|devin|copilot|claude\s*code/i, why: '경쟁사 이름' },
  { re: /곧\s|\bsoon\b|\bcoming\b|available now|out now/i, why: '미래 약속' },
  // 표식 문자는 코드 포인트로 적는다 — 이 파일 자체가 공개본 유출 검사에 걸리지 않게.
  { re: /[\u{1F451}\u{1F162}\u{1F163}\u{1F155}\u{1F15E}]|RFC-|HAND[O]FF-/u, why: '내부 표식' },
  { re: /\/Users\/|\.ts\.net|tail[0-9a-f]{6}/, why: '기기 경로·이름' },
];

const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;

export function fill(text: string, t: SceneTable, problems: string[], where: string): string {
  return text.replace(PLACEHOLDER, (_m, key: string) => {
    const v = t.measured?.[key]?.value;
    if (v === undefined || v === null || v === '') {
      problems.push(`${where}: {{${key}}} 의 실측값이 없다(measured.${key}.value)`);
      return `{{${key}}}`;
    }
    return String(v);
  });
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export function checkTable(t: SceneTable): string[] {
  const p: string[] = [];
  const maxChars = t.subtitles?.maxCharsPerLine ?? 22;
  const maxLines = t.subtitles?.maxLines ?? 2;
  const maxWpm = t.vo?.maxWpm ?? 150;
  const scenes = [...t.scenes].sort((a, b) => a.start - b.start);

  let cursor = 0;
  let lastCueEnd = -1;
  for (const s of scenes) {
    const at = `장면 ${s.n}`;
    if (s.start !== cursor) p.push(`${at}: 시작 ${s.start}s — 앞 장면 끝 ${cursor}s 와 이어지지 않는다`);
    if (!(s.end > s.start)) p.push(`${at}: 끝(${s.end}s)이 시작(${s.start}s) 뒤가 아니다`);
    cursor = s.end;

    const pub: Array<[string, string]> = [];
    if (s.vo) {
      const wpm = (words(s.vo) / (s.end - s.start)) * 60;
      if (wpm > maxWpm) p.push(`${at}: VO ${wpm.toFixed(0)} wpm > ${maxWpm}`);
      pub.push([`${at} VO`, s.vo]);
    }
    if (s.numberCard) pub.push([`${at} 숫자 카드`, fill(s.numberCard, t, p, `${at} 숫자 카드`)]);
    if (s.requestText) pub.push([`${at} 요청 문구`, s.requestText]);

    for (const [i, c] of (s.ko ?? []).entries()) {
      const cat = `${at} 자막 ${i + 1}`;
      if (!(c.end > c.start)) p.push(`${cat}: 끝이 시작 뒤가 아니다`);
      if (c.start < s.start || c.end > s.end) p.push(`${cat}: ${c.start}–${c.end}s 가 장면 ${s.start}–${s.end}s 밖으로 나간다`);
      if (c.start < lastCueEnd) p.push(`${cat}: 앞 자막(끝 ${lastCueEnd}s)과 겹친다`);
      lastCueEnd = c.end;
      if (c.lines.length === 0 || c.lines.length > maxLines) p.push(`${cat}: ${c.lines.length}줄(1~${maxLines})`);
      for (const raw of c.lines) {
        const line = fill(raw, t, p, cat);
        const len = [...line].length;
        if (len > maxChars) p.push(`${cat}: «${line}» ${len}자 > ${maxChars}`);
        pub.push([cat, line]);
      }
    }
    for (const [where, text] of pub) {
      for (const b of BANNED) if (b.re.test(text)) p.push(`${where}: ${b.why} — «${text}»`);
    }
  }
  if (cursor !== t.durationSec) p.push(`마지막 장면 끝 ${cursor}s ≠ durationSec ${t.durationSec}s`);
  return p;
}

const ts = (sec: number) => {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000), r = ms % 1000;
  const z = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${z(h)}:${z(m)}:${z(s)},${z(r, 3)}`;
};

export function toSrt(t: SceneTable): string {
  const scratch: string[] = [];
  const cues = t.scenes.flatMap((s) => s.ko ?? []).sort((a, b) => a.start - b.start);
  return cues
    .map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.lines.map((l) => fill(l, t, scratch, '')).join('\n')}\n`)
    .join('\n');
}

export function toVoScript(t: SceneTable): string {
  return t.scenes
    .filter((s) => s.vo)
    .map((s) => `[${s.n}] ${ts(s.start).slice(3, 8)}–${ts(s.end).slice(3, 8)}  ${s.vo}`)
    .join('\n') + '\n';
}

function readTable(file: string): SceneTable {
  try {
    const t = JSON.parse(readFileSync(file, 'utf8')) as SceneTable;
    if (!Array.isArray(t.scenes) || typeof t.durationSec !== 'number') throw new Error('scenes[] · durationSec 가 필요하다');
    return t;
  } catch (e) {
    console.error(`⛔ 장면표를 못 읽었다: ${(e as Error).message}`);
    process.exit(3);
  }
}

if (import.meta.main) {
  const [cmd, file] = process.argv.slice(2);
  if (!cmd || !file || !['check', 'srt', 'vo'].includes(cmd)) {
    console.error('사용: bun scripts/video/scene-table.ts <check|srt|vo> <scenes.json>');
    process.exit(3);
  }
  const t = readTable(file);
  const problems = checkTable(t);
  if (cmd === 'check') {
    for (const x of problems) console.log(`⛔ ${x}`);
    console.log(problems.length ? `걸림 ${problems.length}` : `✅ 통과 · 장면 ${t.scenes.length} · 자막 ${t.scenes.flatMap((s) => s.ko ?? []).length}`);
    process.exit(problems.length ? 1 : 0);
  }
  if (problems.length) {
    for (const x of problems) console.error(`⛔ ${x}`);
    console.error(`걸림 ${problems.length} — 검사를 통과한 장면표에서만 ${cmd} 를 뽑는다`);
    process.exit(1);
  }
  process.stdout.write(cmd === 'srt' ? toSrt(t) : toVoScript(t));
}
