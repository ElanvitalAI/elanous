'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Send, Paperclip, X, Mic, MicOff } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { isMetaCommand, META_COMMANDS } from '@/lib/chat-runtime';
import { takeSharePrefill } from '@/lib/share-prefill';
import { cn } from '@/lib/utils';
import { CameraAttachButton } from '@/components/terminal/CameraAttachButton';
import { FileAttachButton } from '@/components/terminal/FileAttachButton';
import { SaveAsNoteButton } from '@/components/notes/SaveAsNoteButton';
import { ShowroomVoiceIntake } from '@/components/showroom/ShowroomVoiceIntake';
import { useDaemon } from '@/components/providers/DaemonProvider';
import type { AttachmentMeta } from '@/lib/upload-attachment';
import type { VoicePhase } from '@/voice/use-voice-controller';
import {
  clearSnapshot,
  loadSnapshot,
  saveSnapshot,
  snapshotKey,
} from '@/lib/snapshot';
import { ElanousProviderChip } from '@/components/chat/ElanousProviderChip';
import { useMissionRouter } from '@/lib/use-mission-router';
import { DEFAULT_CHAT_ROUTING, getChatRouting, subscribeChatRouting } from '@/lib/chat-routing-storage';
import { SeatRequestError, type SeatRequestReceipt, type SeatSummary } from '@/lib/daemon-client';
import { SeatPicker } from './SeatPicker';

const INPUT_PERSIST_DEBOUNCE_MS = 300;
const EMPTY_ATTACHMENTS: AttachmentMeta[] = [];

// PWA Phase 1·E+H (RESEARCH-ios-companion-tui-parity-2026-05-17 · Phase 1b)
// — TUI src/chat/input-edit-key.ts:36-48 의 PWA 등가. localStorage 에
// cross-session promptHistory persist. iOS @AppStorage("ios.chat.
// promptHistory.v1") 와 sibling — 본 키는 별 namespace (per-surface
// browsing context).
const PROMPT_HISTORY_KEY = 'elanous.pwa.chat.promptHistory.v1';
const PROMPT_HISTORY_CAP = 50;

function loadPromptHistory(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(PROMPT_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

function savePromptHistory(history: readonly string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(history));
  } catch { /* swallow — quota or disabled */ }
}

function filterSlashCommands(query: string): readonly { name: string; description: string }[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) return META_COMMANDS;
  return META_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(trimmed));
}

/** 슬래시 메뉴가 열린 채 Enter — 친 글이 명령 이름과 «정확히» 같으면 바로 실행(`:name` 전송),
 *  아니면 지금처럼 고른 항목으로 완성(`:name ` 을 입력창에). 2026-09-27 시나리오 러너 C2b:
 *  `/help` ⊕ Enter 가 입력창만 `:help ` 로 바꾸고 아무것도 안 보냈다. */
export function slashEnterAction(
  query: string,
  filtered: readonly { name: string }[],
  selectedIndex: number,
): { kind: 'run'; line: string } | { kind: 'complete'; value: string } | null {
  const exact = filtered.find((c) => c.name.toLowerCase() === query.trim().toLowerCase());
  if (exact) return { kind: 'run', line: `:${exact.name}` };
  const picked = filtered[Math.min(Math.max(selectedIndex, 0), filtered.length - 1)];
  return picked ? { kind: 'complete', value: `:${picked.name} ` } : null;
}

/** Detect trailing `/<query>` for the slash menu. Returns the prefix or
 *  null when inactive. Active only when input begins with `/` and contains
 *  no whitespace. */
function detectSlashQuery(value: string): string | null {
  if (!value.startsWith('/')) return null;
  if (/\s/.test(value)) return null;
  return value.slice(1);
}

// PWA Phase 2·A+B (RESEARCH §1.1·A/B) — iOS PR #2807 + #2808 의 PWA 등가.
// daemon-side `elanous/fs/list` + `elanous/skills/list` ACP method 통해 fetch.

export interface FsPickerEntry {
  name: string;
  isDir: boolean;
  relPath: string;
}

export interface SkillPickerEntry {
  name: string;
  description: string;
}

/** Detect trailing `@<query>` or `$<query>` token. trigger char 가 word 의
 *  시작 위치 (string 시작 또는 whitespace 뒤) + no whitespace following. */
function detectTrailingToken(value: string, trigger: '@' | '$'): string | null {
  const idx = value.lastIndexOf(trigger);
  if (idx < 0) return null;
  const after = value.slice(idx + 1);
  if (/[\s]/.test(after)) return null;
  if (idx > 0) {
    const before = value[idx - 1];
    if (!/\s/.test(before)) return null;
  }
  return after;
}

/** Phase 1 (PWA chat ↔ voice 일원화 · 2026-05-07) — voice mirror props
 *  passed from ChatLayout. The header mic toggle and the inline mic
 *  inside ChatInput share one controller: pressing either flips the
 *  same active state and the same phase indicator. ChatLayout owns the
 *  controller; ChatInput just renders + emits toggle. */
interface ChatInputVoiceProps {
  active: boolean;
  phase: VoicePhase;
  /** Pre-resolved tailwind bg-* class for the phase dot, so ChatInput
   *  doesn't need its own VoicePhase → color map (single source of truth
   *  in ChatLayout). */
  dotColor: string;
  phaseLabel: string;
  disabled?: boolean;
  onToggle: () => void;
}

interface Props {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  /** WT-N-1b/2b — pending attachment queue rendered as removable chips
   *  above the textarea. Source of truth lives in ChatLayout so submit
   *  can drain the queue atomically with the user text. */
  attachments?: AttachmentMeta[];
  onAttached?: (entries: AttachmentMeta[]) => void;
  onRemoveAttachment?: (id: string) => void;
  /** BACKLOG #3 — workspace tab id for chat-input snapshot persistence.
   *  Falls back to 'singleton' when absent (single-tab `/chat` page). */
  tabId?: string;
  /** Phase 1 — voice controller state mirror (optional · falls back to
   *  no mic button when ChatInput is mounted outside ChatLayout, e.g.
   *  legacy callsites). */
  voice?: ChatInputVoiceProps;
  /** PWA Phase 2·A — `@` file picker fetcher. parent (ChatLayout) 가
   *  AcpConnection.send('elanous/fs/list', ...) 으로 wire. nil 시 picker
   *  disabled (no overlay). */
  onListFiles?: (query: string) => Promise<{ cwd: string; entries: FsPickerEntry[] }>;
  /** PWA Phase 2·B — `$` skill picker fetcher. parent (ChatLayout) 가
   *  AcpConnection.send('elanous/skills/list', ...) 으로 wire. */
  onListSkills?: (query: string) => Promise<{ entries: SkillPickerEntry[] }>;
  /** New shared text from the parent after mount. The id distinguishes repeat actions. */
  prefill?: { text: string; id: number };
}

function fmtKB(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Build a fully-qualified download URL for an attachment served by
 *  the daemon. Mirrors TerminalControls.downloadHref — bearer auth is
 *  promoted to a `?auth=…` query param since `<img src>` can't carry
 *  custom headers. */
function attachmentSrc(downloadUrl: string, baseUrl?: string, token?: string): string {
  if (!downloadUrl) return '';
  const base = baseUrl ?? '';
  const sep = downloadUrl.includes('?') ? '&' : '?';
  const auth = token ? `${sep}auth=${encodeURIComponent(token)}` : '';
  return `${base}${downloadUrl}${auth}`;
}

export function ChatInput({
  onSubmit,
  disabled,
  attachments = EMPTY_ATTACHMENTS,
  onAttached,
  onRemoveAttachment,
  tabId,
  voice,
  onListFiles,
  onListSkills,
  prefill,
}: Props) {
  const { client, config } = useDaemon();
  const [seats, setSeats] = useState<SeatSummary[]>([]);
  const [selectedSeat, setSelectedSeat] = useState<string | null>(null);
  const [seatReceipts, setSeatReceipts] = useState<SeatRequestReceipt[]>([]);
  const [seatError, setSeatError] = useState('');
  const [seatPending, setSeatPending] = useState(false);
  const retryRef = useRef<{ seat?: string; text: string; key: string } | null>(null);
  useEffect(() => {
    let active = true;
    // 자리 문을 모르는 클라이언트(옛 판·다른 화면의 가짜 클라이언트)면 칩 없이 채팅만 — 던지면 입력칸 전체가 멈춘다.
    if (typeof client?.listSeatRequests !== 'function') return () => { active = false; };
    client.listSeatRequests().then((response) => {
      if (active) setSeats(response.seats);
    }).catch(() => { /* chat stays available when the seat endpoint is unavailable */ });
    return () => { active = false; };
  }, [client]);
  const persistKey = snapshotKey('chatInput', tabId);
  const [value, setValue] = useState<string>(() => {
    const stash = loadSnapshot<string>(persistKey);
    return typeof stash === 'string' ? stash : '';
  });

  // PWA Phase 1·E+H — promptHistory state (cross-session via localStorage).
  // historyIndex: -1 = current draft · 0+ = recall index.
  // historyDraft: pre-recall buffer (restore on -1 transition).
  const [promptHistory, setPromptHistory] = useState<string[]>(() => loadPromptHistory());
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const historyDraftRef = useRef<string>('');

  // PWA Phase 1·D — slash menu state. detectSlashQuery 결과를 derived
  // (매 render 평가) 으로 사용 · selectedIndex 만 별 state.
  const slashQuery = detectSlashQuery(value);
  const slashFiltered = slashQuery !== null ? filterSlashCommands(slashQuery) : [];
  const [slashSelectedIndex, setSlashSelectedIndex] = useState<number>(0);
  // slash menu 의 selection 이 query 변경 시 reset.
  useEffect(() => {
    setSlashSelectedIndex(0);
  }, [slashQuery]);

  // PWA Phase 2·A — `@` file picker state. trailing token (`@<query>`)
  // detect · debounce 200ms fetch · selection cycle.
  const atQuery = onListFiles ? detectTrailingToken(value, '@') : null;
  const [atEntries, setAtEntries] = useState<FsPickerEntry[]>([]);
  const [atCwd, setAtCwd] = useState<string>('');
  const [atSelectedIndex, setAtSelectedIndex] = useState<number>(0);
  useEffect(() => {
    if (atQuery === null || !onListFiles) return;
    setAtSelectedIndex(0);
    const handle = setTimeout(() => {
      onListFiles(atQuery).then((res) => {
        setAtEntries(res.entries);
        setAtCwd(res.cwd);
      }).catch(() => { /* swallow */ });
    }, 200);
    return () => clearTimeout(handle);
  }, [atQuery, onListFiles]);
  useEffect(() => {
    if (atQuery === null) {
      setAtEntries([]);
      setAtCwd('');
      setAtSelectedIndex(0);
    }
  }, [atQuery]);

  // PWA Phase 4·F — Reverse history search (Ctrl+R). TUI src/chat/
  // reverse-history-search.ts 의 PWA 등가. promptHistory 위 case-
  // insensitive substring search · ↑↓ cycle · Enter commit · Esc cancel.
  const [reverseSearchActive, setReverseSearchActive] = useState<boolean>(false);
  const [reverseSearchSelectedIndex, setReverseSearchSelectedIndex] = useState<number>(0);
  const reverseSearchDraftRef = useRef<string>('');
  const reverseSearchMatches = reverseSearchActive
    ? (value.trim().length === 0
        ? promptHistory
        : promptHistory.filter((p) => p.toLowerCase().includes(value.trim().toLowerCase())))
    : [];

  const beginReverseSearch = (): void => {
    // 다른 picker 자동 dismiss — input clear 시 picker 들 derived null.
    reverseSearchDraftRef.current = value;
    setReverseSearchActive(true);
    setReverseSearchSelectedIndex(0);
    setValue('');
  };

  const dismissReverseSearch = (): void => {
    setValue(reverseSearchDraftRef.current);
    setReverseSearchActive(false);
    setReverseSearchSelectedIndex(0);
    reverseSearchDraftRef.current = '';
  };

  const commitReverseSearch = (): void => {
    if (reverseSearchMatches.length === 0) {
      dismissReverseSearch();
      return;
    }
    const idx = Math.min(Math.max(reverseSearchSelectedIndex, 0), reverseSearchMatches.length - 1);
    const match = reverseSearchMatches[idx];
    setReverseSearchActive(false);
    setReverseSearchSelectedIndex(0);
    reverseSearchDraftRef.current = '';
    setValue(match);
  };

  // PWA Phase 2·B — `$` skill picker state. 같은 pattern.
  const skillQuery = onListSkills ? detectTrailingToken(value, '$') : null;
  const [skillEntries, setSkillEntries] = useState<SkillPickerEntry[]>([]);
  const [skillSelectedIndex, setSkillSelectedIndex] = useState<number>(0);
  const [routing, setRouting] = useState(DEFAULT_CHAT_ROUTING);
  useEffect(() => {
    setRouting(getChatRouting());
    return subscribeChatRouting(setRouting);
  }, []);
  const { prediction, predict, clear } = useMissionRouter({
    baseUrl: config.baseUrl,
    token: config.token,
    enabled: routing.autoRouting,
  });
  useEffect(() => {
    if (!routing.autoRouting) {
      clear();
      return;
    }
    const attachmentKinds = attachments.map((a): 'image' | 'document' =>
      a.mediaType?.startsWith('image/') ? 'image' : 'document');
    predict(value, attachmentKinds);
  }, [value, routing.autoRouting, attachments, predict, clear]);
  useEffect(() => {
    if (skillQuery === null || !onListSkills) return;
    setSkillSelectedIndex(0);
    const handle = setTimeout(() => {
      onListSkills(skillQuery).then((res) => {
        setSkillEntries(res.entries);
      }).catch(() => { /* swallow */ });
    }, 200);
    return () => clearTimeout(handle);
  }, [skillQuery, onListSkills]);
  useEffect(() => {
    if (skillQuery === null) {
      setSkillEntries([]);
      setSkillSelectedIndex(0);
    }
  }, [skillQuery]);
  // WT-N-6 — when the share-target page (/app/share/) stashed text in
  // sessionStorage we prefill the textarea on mount. One-shot: drain
  // the key so a manual reload doesn't re-prefill. Toast hint so the
  // user understands where the unexpected text came from. Share prefill
  // wins over snapshot (explicit user intent vs ambient persistence).
  useEffect(() => {
    const stash = takeSharePrefill();
    if (stash) {
      setValue(stash);
      toast.success('📥 공유 받음 — 검토 후 보내세요');
    }
  }, []);

  useEffect(() => {
    if (!prefill) return;
    setValue(prefill.text);
    takeSharePrefill();
  }, [prefill]);

  // BACKLOG #3 — debounce-persist textarea value so an LRU-frozen
  // unmount doesn't drop a half-typed prompt. Empty value clears the
  // entry to keep storage tidy.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      if (value.length === 0) clearSnapshot(persistKey);
      else saveSnapshot(persistKey, value);
    }, INPUT_PERSIST_DEBOUNCE_MS);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [value, persistKey]);

  const sendSeatRequest = async (request: { seat?: string; text: string; key: string }): Promise<void> => {
    setSeatPending(true);
    setSeatError('');
    try {
      const receipt = await client.submitSeatRequest({ seat: request.seat, text: request.text }, request.key);
      setSeatReceipts((previous) => [...previous, receipt]);
      retryRef.current = null;
      setValue('');
      clearSnapshot(persistKey);
    } catch (error) {
      retryRef.current = request;
      if (error instanceof SeatRequestError && error.code === 'unknown-seat') {
        setSeats(error.seats);
        // 고른 자리가 서버 목록에서 사라졌으면 선택을 풀어 일반 채팅으로 돌아간다 — 숨은 선택이 남으면
        // 해제할 칩도 없이 다음 글까지 없는 자리로 간다(리뷰 3라운드 must-fix).
        if (selectedSeat && !error.seats.some((seat) => seat.id === selectedSeat)) {
          setSelectedSeat(null);
          retryRef.current = null;
        }
        setSeatError(`그 자리를 찾지 못했습니다 — ${error.seats.map((seat) => seat.title).join(', ')}`);
      } else {
        setSeatError('접수하지 못했습니다 — 잠시 뒤 다시');
      }
    } finally {
      setSeatPending(false);
    }
  };
  const submit = (): void => submitText(value);
  const submitText = (text: string): void => {
    const trimmed = text.trim();
    const addressed = /^@\S+\s+[\s\S]*\S$/.test(text.trimEnd());
    if (disabled || seatPending) return;
    if ((addressed || selectedSeat) && attachments.length) {
      setSeatError('자리 요청에는 첨부파일을 보낼 수 없습니다');
      return;
    }
    if ((addressed || selectedSeat) && trimmed) {
      const request = addressed
        ? { text: trimmed, key: crypto.randomUUID() }
        : { seat: selectedSeat!, text: trimmed, key: crypto.randomUUID() };
      const retry = retryRef.current;
      const same = retry && retry.seat === request.seat && retry.text === request.text;
      void sendSeatRequest(same ? retry : request);
      return;
    }
    // Allow attachment-only sends (no body text) so the user can ship a
    // file with no caption — LLM still gets the path lines prepended.
    if (!trimmed && attachments.length === 0) return;
    // PWA Phase 1·E — record to promptHistory before clearing the buffer.
    // text-only or attachment-only turn 의 text 가 empty 일 수 있으니
    // trimmed.length > 0 만 record.
    if (trimmed.length > 0) {
      setPromptHistory((prev) => {
        if (prev[0] === trimmed) return prev;
        const next = [trimmed, ...prev].slice(0, PROMPT_HISTORY_CAP);
        savePromptHistory(next);
        return next;
      });
      setHistoryIndex(-1);
      historyDraftRef.current = '';
    }
    onSubmit(trimmed);
    setValue('');
    clearSnapshot(persistKey);
  };

  // PWA Phase 1·E — ↑ recall. textarea 의 single-line (no `\n`) 시만 ·
  // multi-line 시 cursor 이동에 양보. clamped at last entry.
  const navHistoryPrev = (): boolean => {
    if (promptHistory.length === 0) return false;
    if (value.includes('\n')) return false;
    if (historyIndex === -1) historyDraftRef.current = value;
    const next = Math.min(historyIndex + 1, promptHistory.length - 1);
    if (next === historyIndex) return true;
    setHistoryIndex(next);
    setValue(promptHistory[next]);
    return true;
  };

  // PWA Phase 1·E — ↓ recall. -1 으로 복귀 시 draft restore.
  const navHistoryNext = (): boolean => {
    if (historyIndex < 0) return false;
    if (value.includes('\n')) return false;
    if (historyIndex === 0) {
      setHistoryIndex(-1);
      setValue(historyDraftRef.current);
      return true;
    }
    const next = historyIndex - 1;
    setHistoryIndex(next);
    setValue(promptHistory[next]);
    return true;
  };

  // PWA Phase 2·A — `@` picker commit. dir 시 `@path/` (picker 유지) ·
  // file 시 `@path ` (trailing space · dismiss).
  const insertAtToken = (entry: FsPickerEntry): void => {
    const atIdx = value.lastIndexOf('@');
    if (atIdx < 0) return;
    const before = value.slice(0, atIdx);
    const suffix = entry.isDir ? `${entry.relPath}/` : entry.relPath;
    setValue(`${before}@${suffix}${entry.isDir ? '' : ' '}`);
  };
  const commitAtSelection = (): void => {
    if (atEntries.length === 0) return;
    const idx = Math.min(Math.max(atSelectedIndex, 0), atEntries.length - 1);
    insertAtToken(atEntries[idx]);
  };

  // PWA Phase 2·B — `$` picker commit. `/run-skill <name> ` 으로 replace.
  const insertSkillToken = (entry: SkillPickerEntry): void => {
    const dollarIdx = value.lastIndexOf('$');
    if (dollarIdx < 0) return;
    const before = value.slice(0, dollarIdx);
    setValue(`${before}/run-skill ${entry.name} `);
  };
  const commitSkillSelection = (): void => {
    if (skillEntries.length === 0) return;
    const idx = Math.min(Math.max(skillSelectedIndex, 0), skillEntries.length - 1);
    insertSkillToken(skillEntries[idx]);
  };

  // PWA Phase 2·I — Tab autofill. picker active 시 selection 의 name 으로
  // query 완성. dir 시 trailing `/` (J escalate).
  const handleTabAutofill = (): boolean => {
    if (atQuery !== null && atEntries.length > 0) {
      const idx = Math.min(Math.max(atSelectedIndex, 0), atEntries.length - 1);
      const entry = atEntries[idx];
      const atIdx = value.lastIndexOf('@');
      if (atIdx < 0) return false;
      const before = value.slice(0, atIdx);
      const token = entry.isDir ? `${entry.name}/` : entry.name;
      setValue(`${before}@${token}`);
      return true;
    }
    if (skillQuery !== null && skillEntries.length > 0) {
      const idx = Math.min(Math.max(skillSelectedIndex, 0), skillEntries.length - 1);
      const entry = skillEntries[idx];
      const dollarIdx = value.lastIndexOf('$');
      if (dollarIdx < 0) return false;
      const before = value.slice(0, dollarIdx);
      setValue(`${before}$${entry.name}`);
      return true;
    }
    if (slashQuery !== null && slashFiltered.length > 0) {
      const idx = Math.min(Math.max(slashSelectedIndex, 0), slashFiltered.length - 1);
      commitSlashSelection(slashFiltered[idx]);
      return true;
    }
    return false;
  };

  const commitSlashSelection = (cmd = slashFiltered[Math.min(Math.max(slashSelectedIndex, 0), slashFiltered.length - 1)]): void => {
    if (cmd) setValue(`:${cmd.name} `);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // PWA Phase 4·F — Ctrl+R reverse search trigger. browser default
    // (page reload) preventDefault.
    if (e.ctrlKey && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault();
      if (!reverseSearchActive) {
        beginReverseSearch();
      }
      return;
    }
    // Reverse search 활성 시 priority chain 최상위.
    if (reverseSearchActive) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commitReverseSearch();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setReverseSearchSelectedIndex((idx) => Math.max(0, idx - 1));
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setReverseSearchSelectedIndex((idx) => Math.min(reverseSearchMatches.length - 1, idx + 1));
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissReverseSearch();
        return;
      }
      // 그 외 키 (사용자 typing) — value 변경 → matches refresh (derived).
    }
    // PWA Phase 2·I — Tab autofill (picker priority chain).
    if (e.key === 'Tab' && !e.shiftKey) {
      if (handleTabAutofill()) {
        e.preventDefault();
        return;
      }
    }
    // Picker priority chain: at > skill > slash > history > send.
    if (atQuery !== null && atEntries.length > 0) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commitAtSelection();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAtSelectedIndex((idx) => Math.max(0, idx - 1));
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAtSelectedIndex((idx) => Math.min(atEntries.length - 1, idx + 1));
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // input 의 @<query> 부분 만 제거.
        const atIdx = value.lastIndexOf('@');
        if (atIdx >= 0) setValue(value.slice(0, atIdx));
        return;
      }
    }
    if (skillQuery !== null && skillEntries.length > 0) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commitSkillSelection();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSkillSelectedIndex((idx) => Math.max(0, idx - 1));
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSkillSelectedIndex((idx) => Math.min(skillEntries.length - 1, idx + 1));
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        const dollarIdx = value.lastIndexOf('$');
        if (dollarIdx >= 0) setValue(value.slice(0, dollarIdx));
        return;
      }
    }
    // PWA Phase 1·D — slash menu 활성 시.
    if (slashQuery !== null && slashFiltered.length > 0) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const action = slashEnterAction(slashQuery, slashFiltered, slashSelectedIndex);
        if (action?.kind === 'run') submitText(action.line);
        else if (action) setValue(action.value);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashSelectedIndex((idx) => Math.max(0, idx - 1));
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashSelectedIndex((idx) => Math.min(slashFiltered.length - 1, idx + 1));
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setValue('');
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    // PWA Phase 1·E — ↑↓ history nav (single-line only).
    if (e.key === 'ArrowUp') {
      if (navHistoryPrev()) {
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      if (navHistoryNext()) {
        e.preventDefault();
      }
      return;
    }
  };

  // PWA Phase 1·E — 사용자가 history 항목 보다 직접 edit 시 historyIndex
  // 를 -1 으로 reset (draft 화). navHistory* 자체 의 setValue 는 그대로
  // promptHistory[historyIndex] 와 일치 → reset 안 됨.
  useEffect(() => {
    if (historyIndex < 0) return;
    if (!promptHistory[historyIndex]) return;
    if (value !== promptHistory[historyIndex]) {
      setHistoryIndex(-1);
      historyDraftRef.current = '';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // PWA Phase 1·H (RESEARCH §1.2·H) — bracketed paste 의 PWA equivalent.
  // HTML5 textarea 가 paste 자체 atomic · Enter 가 newline default (textarea
  // base behavior · 우리 onKey 가 Enter = submit override 하지만 Shift+Enter
  // 는 native newline pass through). paste multi-line content 는 그대로
  // value 에 set 되며 submit 은 명시 Enter 만 trigger — iOS 의 `\n` suffix
  // auto-send hack 가 PWA 에는 필요 없음 · paste 자연 보존.

  const isMeta = isMetaCommand(value);

  return (
    <div className="border-t border-border bg-background p-3">
      {seatReceipts.map((receipt) => <div key={receipt.receiptId} role="status" className="mb-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
        📨 {seats.find((seat) => seat.id === receipt.seat)?.title ?? receipt.seat} 접수 {receipt.receiptId} · 방금
      </div>)}
      {seatError && <p role="alert" className="mb-2 text-sm text-destructive">{seatError}</p>}
      <SeatPicker seats={seats} selected={selectedSeat} onSelect={(seat) => { setSelectedSeat(seat); setSeatError(''); }} disabled={disabled || seatPending} />
      {/* PWA Phase 4·F — reverse history search overlay (priority 최상위). */}
      {reverseSearchActive && (
        <div className="mb-2 overflow-hidden rounded-md border border-border bg-card shadow-md">
          <div className="flex items-center justify-between px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span>🔎 reverse-i-search</span>
            <span className="text-xs font-semibold">
              {reverseSearchMatches.length} match{reverseSearchMatches.length === 1 ? '' : 'es'}
            </span>
          </div>
          {reverseSearchMatches.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {value.length === 0 ? 'history 가 비어 있음' : `일치 없음 — '${value}'`}
            </div>
          ) : (
            <>
              <ul className="divide-y divide-border">
                {reverseSearchMatches.slice(0, 8).map((match, idx) => {
                  const selected = idx === reverseSearchSelectedIndex;
                  return (
                    <li
                      key={`${match}-${idx}`}
                      role="button"
                      tabIndex={-1}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setReverseSearchSelectedIndex(idx);
                        requestAnimationFrame(() => {
                          setReverseSearchActive(false);
                          reverseSearchDraftRef.current = '';
                          setValue(match);
                        });
                      }}
                      className={cn(
                        'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm',
                        selected ? 'bg-accent/15 font-semibold' : 'hover:bg-accent/8',
                      )}
                    >
                      <span className="line-clamp-2">{match}</span>
                    </li>
                  );
                })}
              </ul>
              {reverseSearchMatches.length > 8 && (
                <div className="px-3 py-1 text-[10px] text-muted-foreground">+ {reverseSearchMatches.length - 8} more (refine query)</div>
              )}
            </>
          )}
        </div>
      )}
      {/* PWA Phase 2·A — `@` picker overlay. */}
      {atQuery !== null && atEntries.length > 0 && (
        <div className="mb-2 overflow-hidden rounded-md border border-border bg-card shadow-md">
          <div className="flex items-center justify-between px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span title={atCwd}>📁 {atCwd.length > 48 ? '…' + atCwd.slice(-45) : atCwd}</span>
            <span className="text-xs font-semibold">{atEntries.length}</span>
          </div>
          <ul className="divide-y divide-border">
            {atEntries.slice(0, 12).map((entry, idx) => {
              const selected = idx === atSelectedIndex;
              return (
                <li
                  key={entry.relPath}
                  role="button"
                  tabIndex={-1}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setAtSelectedIndex(idx);
                    requestAnimationFrame(() => insertAtToken(entry));
                  }}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm',
                    selected ? 'bg-accent/15' : 'hover:bg-accent/8',
                  )}
                >
                  <span className="text-xs">{entry.isDir ? '📂' : '📄'}</span>
                  <span className={cn('font-mono', selected ? 'font-semibold' : 'font-normal')}>
                    {entry.name}{entry.isDir ? '/' : ''}
                  </span>
                  {entry.isDir && (
                    <span className="ml-auto text-[10px] uppercase text-muted-foreground">dir</span>
                  )}
                </li>
              );
            })}
          </ul>
          {atEntries.length > 12 && (
            <div className="px-3 py-1 text-[10px] text-muted-foreground">+ {atEntries.length - 12} more (refine query)</div>
          )}
        </div>
      )}
      {/* PWA Phase 2·B — `$` skill picker overlay. */}
      {skillQuery !== null && skillEntries.length > 0 && (
        <div className="mb-2 overflow-hidden rounded-md border border-border bg-card shadow-md">
          <div className="flex items-center justify-between px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span>✨ skills</span>
            <span className="text-xs font-semibold">{skillEntries.length}</span>
          </div>
          <ul className="divide-y divide-border">
            {skillEntries.map((entry, idx) => {
              const selected = idx === skillSelectedIndex;
              return (
                <li
                  key={entry.name}
                  role="button"
                  tabIndex={-1}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setSkillSelectedIndex(idx);
                    requestAnimationFrame(() => insertSkillToken(entry));
                  }}
                  className={cn(
                    'flex cursor-pointer flex-col gap-0.5 px-3 py-1.5',
                    selected ? 'bg-accent/15' : 'hover:bg-accent/8',
                  )}
                >
                  <span className={cn('font-mono text-sm', selected ? 'font-semibold' : 'font-normal')}>
                    {entry.name}
                  </span>
                  {entry.description.length > 0 && (
                    <span className="text-xs text-muted-foreground">{entry.description}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {/* Local meta commands, filtered by the runtime's handler catalog. */}
      {slashQuery !== null && (
        <div className="mb-2 overflow-hidden rounded-md border border-border bg-card shadow-md">
          <div className="flex items-center justify-between px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span>slash commands</span>
            <span className="text-xs font-semibold">{slashFiltered.length}</span>
          </div>
          {slashFiltered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">일치하는 명령 없음</div>
          ) : (
            <ul className="divide-y divide-border">
              {slashFiltered.map((cmd, idx) => {
                const selected = idx === slashSelectedIndex;
                return (
                  <li
                    key={cmd.name}
                    role="button"
                    tabIndex={-1}
                    onMouseDown={(e) => {
                      // mouseDown — focus 이동 회피 (textarea 의 blur 가
                      // slashQuery 를 derived = null 으로 만들기 전 commit).
                      e.preventDefault();
                      setSlashSelectedIndex(idx);
                      commitSlashSelection(cmd);
                    }}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm',
                      selected ? 'bg-accent/15' : 'hover:bg-accent/8',
                    )}
                  >
                    <span className={cn(
                      'font-mono',
                      selected ? 'font-semibold text-foreground' : 'text-foreground/86',
                    )}>
                      :{cmd.name}
                    </span>
                    <span className="text-xs text-muted-foreground">{cmd.description}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      {attachments.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((a) => {
            const isImage = typeof a.mediaType === 'string' && a.mediaType.startsWith('image/');
            return (
              <li
                key={a.id}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-1.5 py-0.5 text-[11px]"
                title={a.path ?? a.filename}
              >
                {isImage ? (
                  // eslint-disable-next-line @next/next/no-img-element -- daemon serves arbitrary user uploads, Image() optimisation isn't useful
                  <img
                    src={attachmentSrc(a.downloadUrl, config.baseUrl, config.token)}
                    alt={a.filename}
                    className="h-6 w-6 rounded-sm object-cover"
                    loading="lazy"
                  />
                ) : (
                  <Paperclip className="h-3 w-3 text-muted-foreground" aria-hidden />
                )}
                <span className="max-w-[160px] truncate font-mono">{a.filename}</span>
                <span className="text-muted-foreground">{fmtKB(a.size)}</span>
                {onRemoveAttachment && (
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(a.id)}
                    aria-label={`remove ${a.filename}`}
                    className="rounded text-muted-foreground hover:text-rose-500"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {/* 폰 폭(2026-09-30 실측 390px): 도구 묶음이 한 줄을 다 먹어 입력칸이 손가락 폭으로 줄었다 →
          좁은 화면에선 도구를 윗줄 전체 폭으로, 입력칸·보내기를 아랫줄로. */}
      <div className="relative flex flex-wrap items-end gap-2 sm:flex-nowrap">
        {/* Attach buttons — same Camera/File widgets as /term toolbar.
            onAttached bubbles each upload to ChatLayout's pending queue.
            R2 (BACKLOG-pwa-mobile-readiness §2.3 · 2026-05-09) — voice
            intake mic next to file/camera so /chat absorbs the same
            "long-press → STT → POST /v1/intake" affordance the showroom
            shipped at #2069. Distinct from the chat-voice-toggle-inline
            mic on the right (which auto-broadcasts captured text via
            the daemon WS); the intake mic stores the memo on the intake
            plane (separate destination · review modal before commit).
            Component is named "Showroom*" for historical reasons but is
            surface-agnostic — uses useDaemon + Web Speech + intake REST. */}
        <div className="flex shrink-0 basis-full items-center gap-0.5 pb-1 sm:basis-auto" data-elanous-composer-tools>
          <CameraAttachButton onAttached={onAttached ? (entry) => onAttached([entry]) : undefined} />
          <FileAttachButton onAttached={onAttached} />
          {/* R-OCR.2.1 (2026-05-09) — separate button from CameraAttach
              because the intent is offline note capture, NOT a chat
              attachment. Long-press dispatch was the alt; a sibling
              icon is more discoverable + avoids gesture collisions on
              touch devices where long-press already disambiguates a
              text-selection menu. */}
          <SaveAsNoteButton />
          <ShowroomVoiceIntake />
          <ElanousProviderChip />
          {routing.autoRouting && prediction && (
            <span className="text-xs text-muted-foreground" title="입력 의도 분류 · ACP 송신 경로는 변경하지 않습니다">
              {prediction.mission}
            </span>
          )}
        </div>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKey}
          placeholder="메시지 · :help 명령 목록"
          rows={2}
          disabled={disabled || seatPending}
          className={cn(
            'min-h-[44px] max-h-[180px] min-w-0 flex-1 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs focus:outline-none focus:ring-2 focus:ring-ring',
            isMeta && 'border-accent text-accent-foreground bg-accent/10',
            disabled && 'opacity-60',
          )}
        />
        {/* Phase 1 (voice 일원화) — inline mic mirror. State source-of-
            truth lives in ChatLayout's useVoiceController; this button
            just toggles it. Auto-send (Q2=B2) means STT final goes
            through `onSubmit` from the controller's onTranscript wire,
            not through this button click. */}
        {voice && (
          <button
            type="button"
            onClick={voice.onToggle}
            disabled={voice.disabled}
            title={voice.disabled ? 'daemon URL 미설정' : voice.phaseLabel}
            data-elanous-action="chat-voice-toggle-inline"
            className={cn(
              'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors',
              voice.active
                ? 'border-rose-500/40 bg-rose-500/10 text-rose-600 hover:bg-rose-500/20'
                : 'border-input bg-background text-foreground hover:bg-muted',
              voice.disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <span className="relative inline-flex">
              {voice.active ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
              <span
                aria-hidden
                className={cn(
                  'absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full',
                  voice.dotColor,
                  (voice.phase === 'listening' || voice.phase === 'speaking') && 'animate-pulse',
                )}
              />
            </span>
          </button>
        )}
        <Button onClick={submit} disabled={disabled || seatPending || (!value.trim() && attachments.length === 0)} size="sm">
          <Send className="h-4 w-4" />
        </Button>
      </div>
      {isMeta && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          meta command — handled locally, not sent to LLM
        </p>
      )}
    </div>
  );
}
