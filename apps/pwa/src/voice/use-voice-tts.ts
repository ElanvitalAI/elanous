'use client';

// Phase 5 (PWA chat ↔ voice 일원화 · 2026-05-07) — assistant streaming
// 텍스트 → sentence boundary → Web Speech API 음성 출력.
//
// **Autopilot decision (F2 → F2-lite)**: Q6=F2 의 strict 의미는 기존
// `src/voice/voice-pwa-tts-bridge.ts` (server-side TTS singleton) 를
// PWA 까지 wire 하는 것. 그러나 Phase 1 의 auto-send (Q2=B2) 가 voice
// STT 를 chat REST `/v1/prompt/stream` 으로 라우팅하면서 server-side
// TTS bridge (voice-dispatch path 전용) 가 더 이상 chat-mode 에서
// 발화하지 않게 됨. 이를 wire 하려면 daemon HTTP 핸들러 cross-cutting
// + `_ttsBridge` plumbing 이 필요 (architecture 영향 큰 변경 · autopilot
// rule 5 중 4번 hit → 사용자 결정 필요).
//
// 본 phase 는 autopilot 진행 가능한 client-side 대안으로 진입:
// 브라우저의 `window.speechSynthesis` (Web Speech API · 모든 modern
// PWA 플랫폼 지원 · iOS Safari 포함). server-side bridge 의 quality
// 이점 (OpenAI / ElevenLabs 등) 은 BACKLOG-webterm 에 follow-up 으로
// 등재 (Phase 5b).
//
// Sentence boundary regex 는 TUI bridge (voice-pwa-tts-bridge.ts:93)
// 와 동일 — `[.!?。！？]+\s*` · 한국어 / 영어 / 일본어 모두 cover.

import { useCallback, useEffect, useRef, useState } from 'react';

const SENTENCE_END_RE = /[.!?。！？]+\s*/g;
const DEFAULT_MAX_BUFFER_CHARS = 80;

export interface UseVoiceTtsOpts {
  /** 활성 토글 — false 면 enqueue 무시 + 진행 중 발화 cancel. ChatLayout
   *  에서 voice controller 의 active 와 사용자 mute toggle 의 AND 를
   *  넘겨줘 voice 모드 OFF 시 자동 disable. */
  enabled: boolean;
  /** 음성 선택 hint — `ko` / `ko-KR` / `en` 등. 매치되는 첫 voice 사용.
   *  미매치 시 브라우저 default. */
  language?: string;
  /** 한 sentence 가 너무 길어 boundary 가 안 올 때 force flush 임계값. */
  maxBufferChars?: number;
}

export interface UseVoiceTtsResult {
  /** 본 turn 에서 새로 받은 streaming 텍스트 fragment 를 누적시킨다.
   *  내부 buffer 에 추가하고, sentence boundary 가 발견되면 즉시
   *  speechSynthesis 큐에 enqueue. */
  pushText: (chunk: string) => void;
  /** Turn 종료 시 호출 — buffer 의 잔여 텍스트를 마지막 sentence 로
   *  flush. 다음 turn 이 들어와도 이전 큐와 섞이지 않도록 pushText 가
   *  새 buffer 로 시작. */
  flush: () => void;
  /** Turn 진행 중 사용자 cancel — 현재 발화 + 큐 모두 비움. */
  cancel: () => void;
  /** Web Speech API 가 본 환경에서 사용 가능한지 (browser 미지원 또는
   *  SSR 시 false). UI 에서 mute toggle disable 결정 등에 사용. */
  supported: boolean;
}

function isSpeechSynthesisSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined';
}

/** Pull complete sentences out of `text`, return them + remainder.
 *  TUI bridge 와 동일 알고리즘 (server-side TTS 와 future swap 시
 *  동일 boundary 기대 보장). 외부 노출은 unit test 용. */
export function extractSentences(text: string): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  SENTENCE_END_RE.lastIndex = 0;
  while ((m = SENTENCE_END_RE.exec(text)) !== null) {
    const end = m.index + m[0].length;
    const piece = text.slice(last, end).trim();
    if (piece) sentences.push(piece);
    last = end;
  }
  return { sentences, remainder: text.slice(last) };
}

/** Pick the first voice matching `language` (e.g., 'ko-KR' or 'ko').
 *  Returns null if browser hasn't loaded voices yet OR no match. */
function pickVoice(language: string | undefined): SpeechSynthesisVoice | null {
  if (!isSpeechSynthesisSupported()) return null;
  if (!language) return null;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;
  const lower = language.toLowerCase();
  const exact = voices.find((v) => v.lang.toLowerCase() === lower);
  if (exact) return exact;
  const prefix = lower.split('-')[0]!;
  return voices.find((v) => v.lang.toLowerCase().startsWith(prefix)) ?? null;
}

export function useVoiceTts(opts: UseVoiceTtsOpts): UseVoiceTtsResult {
  // ⛔ 렌더 중에 브라우저를 묻지 않는다 — 정적 export 는 서버(창 없음)에서 «미지원»으로 그리고
  //    브라우저 첫 렌더가 «지원»으로 그리면 React #418 하이드레이션 오류가 난다(09-28 Chat 탭 실측 ·
  //    음성 오버레이의 «음성 응답» 버튼). 첫 렌더는 서버와 같이 false, 마운트 뒤에 잰다.
  const [supported, setSupported] = useState(false);
  useEffect(() => { setSupported(isSpeechSynthesisSupported()); }, []);
  const [, forceRender] = useState({});
  const bufferRef = useRef<string>('');
  const enabledRef = useRef(opts.enabled);
  enabledRef.current = opts.enabled;
  const maxBufferChars = opts.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS;
  const languageRef = useRef(opts.language);
  languageRef.current = opts.language;

  // Brief preload — some browsers (Chrome) populate voice list async.
  // Trigger once on mount so the first speak() can find Korean voice.
  useEffect(() => {
    if (!supported) return;
    const refresh = () => forceRender({});
    window.speechSynthesis.getVoices(); // warm-up
    window.speechSynthesis.addEventListener?.('voiceschanged', refresh);
    return () => {
      window.speechSynthesis.removeEventListener?.('voiceschanged', refresh);
    };
  }, [supported]);

  // Disable transition: when caller flips enabled to false, abort any
  // in-flight speech immediately + drop buffer. Avoids the case where
  // user mutes mid-turn and still hears the next sentence land.
  useEffect(() => {
    if (!supported) return;
    if (!opts.enabled) {
      window.speechSynthesis.cancel();
      bufferRef.current = '';
    }
  }, [opts.enabled, supported]);

  const speak = useCallback((sentence: string): void => {
    if (!supported) return;
    if (!enabledRef.current) return;
    const trimmed = sentence.trim();
    if (!trimmed) return;
    const u = new SpeechSynthesisUtterance(trimmed);
    const voice = pickVoice(languageRef.current);
    if (voice) u.voice = voice;
    if (languageRef.current) u.lang = languageRef.current;
    window.speechSynthesis.speak(u);
  }, [supported]);

  const pushText = useCallback((chunk: string): void => {
    if (!chunk) return;
    if (!enabledRef.current) return;
    bufferRef.current += chunk;
    const { sentences, remainder } = extractSentences(bufferRef.current);
    bufferRef.current = remainder;
    for (const s of sentences) speak(s);
    // Failsafe — long sentence with no terminator forced flush.
    if (bufferRef.current.length >= maxBufferChars) {
      const forced = bufferRef.current;
      bufferRef.current = '';
      speak(forced);
    }
  }, [maxBufferChars, speak]);

  const flush = useCallback((): void => {
    const remainder = bufferRef.current.trim();
    bufferRef.current = '';
    if (remainder) speak(remainder);
  }, [speak]);

  const cancel = useCallback((): void => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    bufferRef.current = '';
  }, [supported]);

  return { pushText, flush, cancel, supported };
}
