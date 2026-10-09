'use client';

// PR #2 — page-agnostic settings panel.
//
// 기존 `/settings` page.tsx 의 본문 전체를 컴포넌트로 추출.

import { useCallback, useEffect, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { useTheme, THEMES } from '@/components/providers/ThemeProvider';
import {
  MERMAID_THEME_PREFERENCES,
  readMermaidThemePreference,
  writeMermaidThemePreference,
  type MermaidThemePreference,
} from '@/components/vault/mermaid-theme';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import {
  rotatePushcutSecret,
  listPushcutBindings,
  upsertPushcutBinding,
  deletePushcutBinding,
  generatePushcutToken,
  PUSHCUT_BINDING_CHANNEL,
  PUSHCUT_SECRET_ID,
  type PushcutBinding,
} from '@/lib/pushcut-runtime';
import {
  enableNotifications,
  disableNotifications,
  getNotificationStatus,
  type NotificationStatus,
} from '@/lib/web-push';
import { QuickSetupCard } from './QuickSetupCard';
import { ObsidianSkillsCard } from './ObsidianSkillsCard';
import { ChildLlmPreferenceCard } from './ChildLlmPreferenceCard';
import { AnswerDepthCard } from './AnswerDepthCard';
import { WelcomeCard } from './WelcomeCard';
import { AdvancedSetupMap } from './AdvancedSetupMap';
import { ConnectTokenCard } from './ConnectTokenCard';
import { PlatformConnectionsCard } from './PlatformConnectionsCard';
import { ChannelBotSetupCard } from './ChannelBotSetupCard';
import { PushcutSettingsCard } from './PushcutSettingsCard';
import { IntentPanelSettingsCard } from './IntentPanelSettingsCard';
import { ChatRoutingCard } from './ChatRoutingCard';
import { FastReplyCard } from './FastReplyCard';
import { NotesMetricsCard } from './NotesMetricsCard';
import { OcrPrefsCard } from './OcrPrefsCard';
import { LlmHostsCard } from './LlmHostsCard';
import { VoicePrefsCard } from './VoicePrefsCard';
import { VoiceModelTierCard } from './VoiceModelTierCard';
import { LlmModelTierCard } from './LlmModelTierCard';
import { TtsModelTierCard } from './TtsModelTierCard';
import { TtsVoiceIdPickerCard } from './TtsVoiceIdPickerCard';
import { PresetCardGrid } from './PresetCardGrid';
import { LlmCatalogCard } from './LlmCatalogCard';
import { BudgetGuardWatcher } from './BudgetGuardWatcher';
import { EmbeddingVisionTierCard } from './EmbeddingVisionTierCard';
import { PersonaCard } from './PersonaCard';
import { BuildInfoCard } from './BuildInfoCard';
import { MenuVisibilityCard } from './MenuVisibilityCard';

const PROVIDER_OPTIONS = ['', 'claude', 'gemini', 'grok', 'codex'];

export function MermaidThemeSelector() {
  const [mermaidTheme, setMermaidTheme] = useState<MermaidThemePreference>(readMermaidThemePreference);
  const chooseMermaidTheme = (value: MermaidThemePreference) => {
    setMermaidTheme(value);
    writeMermaidThemePreference(value);
  };
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Mermaid theme</h2>
      <p className="text-xs text-muted-foreground">자동은 밝은 default 도식입니다. 노트의 init 테마 지시가 이 설정보다 우선합니다.</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Mermaid theme">
        {MERMAID_THEME_PREFERENCES.map((choice) => (
          <Button
            key={choice}
            type="button"
            variant={mermaidTheme === choice ? 'default' : 'outline'}
            size="sm"
            aria-pressed={mermaidTheme === choice}
            onClick={() => chooseMermaidTheme(choice)}
          >
            {choice === 'auto' ? '자동' : choice}
          </Button>
        ))}
      </div>
    </section>
  );
}

interface HealthState {
  status: 'idle' | 'loading' | 'ok' | 'error';
  sessions?: number;
  latencyMs?: number;
  error?: string;
  checkedAt?: number;
}

interface ToolSpec {
  name: string;
  description: string;
}

interface ToolsState {
  status: 'idle' | 'loading' | 'ok' | 'error';
  kind?: 'none' | 'readonly' | 'webterm';
  specs?: ToolSpec[];
  error?: string;
}

interface AuthTraceEntry {
  ts: number;
  method: string;
  path: string;
  ok: boolean;
  reason: string;
  sfs: string | null;
  origin: string | null;
  host: string | null;
  referer: string | null;
  hasBearer: boolean;
}

interface AuthTraceState {
  status: 'idle' | 'loading' | 'ok' | 'error';
  entries?: AuthTraceEntry[];
  error?: string;
  fetchedAt?: number;
}

interface ScreenshotState {
  status: 'idle' | 'loading' | 'ok' | 'none' | 'error';
  objectUrl?: string;
  error?: string;
  fetchedAt?: number;
}

interface PushcutState {
  /** `idle` until first list call · `loading` during refresh ·
   *  `ok` once list resolved · `nexus-missing` on 404 (NEXUS HTTP
   *  not running — `elanous serve` standalone case) · `error` for
   *  other failures (e.g. wrong token). */
  status: 'idle' | 'loading' | 'ok' | 'nexus-missing' | 'error';
  bindings?: PushcutBinding[];
  error?: string;
  /** Last secret-rotate result so the UI can show the redacted ref. */
  secretRef?: string;
  /** Server-side token shown ONCE right after rotate so the user
   *  can copy it into the iPhone Pushcut Shortcut. Cleared on next
   *  refresh — never re-fetched (server returns `[redacted]`). */
  pendingSecretValue?: string;
}

export function SettingsPanel() {
  const { config, setConfig, client, sessionId } = useDaemon();
  // `#bearer-token` 으로 들어오면(웹 터미널 «토큰 없음» 안내의 링크) 그 칸으로 바로 가서 포커스한다.
  useEffect(() => {
    if (typeof window === 'undefined' || window.location.hash !== '#bearer-token') return;
    const t = window.setTimeout(() => {
      const el = document.getElementById('bearer-token');
      el?.scrollIntoView({ block: 'center' });
      (el as HTMLInputElement | null)?.focus();
    }, 50);
    return () => window.clearTimeout(t);
  }, []);
  const { theme, setTheme } = useTheme();
  const [health, setHealth] = useState<HealthState>({ status: 'idle' });
  const [tools, setTools] = useState<ToolsState>({ status: 'idle' });
  const [authTrace, setAuthTrace] = useState<AuthTraceState>({ status: 'idle' });
  const [authTraceNonce, setAuthTraceNonce] = useState(0);
  const [screenshot, setScreenshot] = useState<ScreenshotState>({ status: 'idle' });
  const [screenshotNonce, setScreenshotNonce] = useState(0);
  const [pushcut, setPushcut] = useState<PushcutState>({ status: 'idle' });
  const [pushcutNonce, setPushcutNonce] = useState(0);
  // Service Worker Phase 3 — Web Push notification state.
  const [pushNotif, setPushNotif] = useState<NotificationStatus>(() => ({
    supported: false,
    permission: 'unknown',
    cachedId: null,
    cachedLabel: null,
  }));
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  useEffect(() => {
    setPushNotif(getNotificationStatus());
  }, []);
  const refreshPushStatus = useCallback(() => {
    setPushNotif(getNotificationStatus());
  }, []);
  const handleEnableNotifications = useCallback(async (): Promise<void> => {
    setPushBusy(true);
    setPushError(null);
    try {
      const r = await enableNotifications({
        baseUrl: config.baseUrl,
        ...(config.token ? { token: config.token } : {}),
      });
      if (r.status === 'enabled') {
        toast.success('Notifications enabled');
      } else if (r.status === 'permission-denied') {
        toast.error('Permission denied — enable in browser/iOS settings');
      } else if (r.status === 'unsupported') {
        toast.error(`Push not supported: ${r.reason}`);
      } else {
        setPushError(r.reason);
        toast.error(`Enable failed: ${r.reason}`);
      }
    } finally {
      setPushBusy(false);
      refreshPushStatus();
    }
  }, [config.baseUrl, config.token, refreshPushStatus]);
  const handleDisableNotifications = useCallback(async (): Promise<void> => {
    setPushBusy(true);
    try {
      await disableNotifications({
        baseUrl: config.baseUrl,
        ...(config.token ? { token: config.token } : {}),
      });
      toast.success('Notifications disabled');
    } finally {
      setPushBusy(false);
      refreshPushStatus();
    }
  }, [config.baseUrl, config.token, refreshPushStatus]);
  const handleTestNotification = useCallback(async (): Promise<void> => {
    if (!config.baseUrl) return;
    try {
      const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/v1/push/test`, {
        method: 'POST',
        ...(config.token ? { headers: { authorization: `Bearer ${config.token}` } } : {}),
      });
      if (!res.ok) {
        toast.error(`Test failed: HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { delivered?: number; attempted?: number };
      toast.success(`Test sent: ${body.delivered ?? 0} / ${body.attempted ?? 0} delivered`);
    } catch (e) {
      toast.error(`Test failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [config.baseUrl, config.token]);
  // Add-binding form state
  const [newToken, setNewToken] = useState('');
  const [newSessionId, setNewSessionId] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [busyBinding, setBusyBinding] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);

  useEffect(() => {
    if (!config.baseUrl) {
      setHealth({ status: 'idle' });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const t0 = Date.now();
    setHealth({ status: 'loading' });
    void (async () => {
      try {
        const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/v1/health`, {
          signal: controller.signal,
        });
        if (cancelled) return;
        const elapsed = Date.now() - t0;
        if (!res.ok) {
          setHealth({
            status: 'error',
            error: `HTTP ${res.status}`,
            latencyMs: elapsed,
            checkedAt: Date.now(),
          });
          return;
        }
        const body = (await res.json()) as { ok?: boolean; sessions?: number };
        setHealth({
          status: body.ok ? 'ok' : 'error',
          ...(typeof body.sessions === 'number' ? { sessions: body.sessions } : {}),
          latencyMs: elapsed,
          checkedAt: Date.now(),
          ...(body.ok ? {} : { error: 'health.ok=false' }),
        });
      } catch (e) {
        if (cancelled) return;
        const reason = e instanceof Error ? e.message : String(e);
        setHealth({ status: 'error', error: reason, latencyMs: Date.now() - t0, checkedAt: Date.now() });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [config.baseUrl]);

  useEffect(() => {
    if (health.status !== 'ok' || !config.baseUrl) {
      setTools({ status: 'idle' });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setTools({ status: 'loading' });
    void (async () => {
      try {
        const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/v1/tools`, {
          signal: controller.signal,
          // Explicit same-origin credentials/mode — Safari (esp. iOS PWA
          // installed as standalone) can omit Sec-Fetch-Site / Origin
          // when fetch lacks these. Setting them forces the browser to
          // send same-origin headers so the daemon's check-same-origin
          // tier-1 / tier-3 fallback fires.
          credentials: 'same-origin',
          mode: 'same-origin',
          ...(config.token ? { headers: { authorization: `Bearer ${config.token}` } } : {}),
        });
        if (cancelled) return;
        if (!res.ok) {
          setTools({ status: 'error', error: `HTTP ${res.status}` });
          return;
        }
        // Server returns `[{name, description}, ...]` since PR #1762
        // (was `string[]` before). Normalise both shapes for forward
        // compatibility — string entries get a synthetic empty
        // description so the UI never receives a non-ToolSpec item.
        const body = (await res.json()) as {
          kind?: ToolsState['kind'];
          specs?: Array<ToolSpec | string>;
        };
        const normalisedSpecs: ToolSpec[] = (body.specs ?? []).map((s) =>
          typeof s === 'string'
            ? { name: s, description: '' }
            : { name: s.name, description: s.description ?? '' },
        );
        setTools({
          status: 'ok',
          kind: body.kind ?? 'none',
          specs: normalisedSpecs,
        });
      } catch (e) {
        if (cancelled) return;
        const reason = e instanceof Error ? e.message : String(e);
        setTools({ status: 'error', error: reason });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [health.status, health.checkedAt, config.baseUrl, config.token]);

  // Auth trace — fetched on health-OK + manual refresh. Surfaces the
  // daemon-side `auth-trace` ring buffer so the user can see WHY a
  // /v1/* call returned 401 without tailing nexus logs.
  useEffect(() => {
    if (health.status !== 'ok' || !config.baseUrl) {
      setAuthTrace({ status: 'idle' });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setAuthTrace({ status: 'loading' });
    void (async () => {
      try {
        const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/v1/diag/auth-trace`, {
          signal: controller.signal,
          credentials: 'same-origin',
          mode: 'same-origin',
          ...(config.token ? { headers: { authorization: `Bearer ${config.token}` } } : {}),
        });
        if (cancelled) return;
        if (!res.ok) {
          setAuthTrace({ status: 'error', error: `HTTP ${res.status}` });
          return;
        }
        const body = (await res.json()) as { entries?: AuthTraceEntry[] };
        setAuthTrace({
          status: 'ok',
          entries: body.entries ?? [],
          fetchedAt: Date.now(),
        });
      } catch (e) {
        if (cancelled) return;
        setAuthTrace({ status: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [health.status, health.checkedAt, config.baseUrl, config.token, authTraceNonce]);

  useEffect(() => {
    if (health.status !== 'ok' || !config.baseUrl || !sessionId) {
      setScreenshot({ status: 'idle' });
      return;
    }
    let cancelled = false;
    let createdUrl: string | null = null;
    const controller = new AbortController();
    setScreenshot({ status: 'loading' });
    void (async () => {
      try {
        const url = `${config.baseUrl.replace(/\/$/, '')}/v1/turns/last/screenshot?session=${encodeURIComponent(sessionId)}`;
        const res = await fetch(url, {
          signal: controller.signal,
          ...(config.token ? { headers: { authorization: `Bearer ${config.token}` } } : {}),
        });
        if (cancelled) return;
        if (res.status === 404) {
          setScreenshot({ status: 'none', fetchedAt: Date.now() });
          return;
        }
        if (!res.ok) {
          setScreenshot({ status: 'error', error: `HTTP ${res.status}` });
          return;
        }
        const blob = await res.blob();
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        setScreenshot({ status: 'ok', objectUrl: createdUrl, fetchedAt: Date.now() });
      } catch (e) {
        if (cancelled) return;
        const reason = e instanceof Error ? e.message : String(e);
        setScreenshot({ status: 'error', error: reason });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [health.status, config.baseUrl, config.token, sessionId, screenshotNonce]);

  const recheck = (): void => {
    setConfig({ baseUrl: config.baseUrl });
  };

  // Pushcut bindings list — only probes when daemon health is OK so
  // we don't fire NEXUS calls before the user has configured baseUrl.
  // 404 responses (NEXUS endpoints absent · `elanous serve` standalone)
  // collapse to `nexus-missing` for clear UX.
  useEffect(() => {
    if (health.status !== 'ok' || !config.baseUrl) {
      setPushcut({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setPushcut((prev) => ({ ...prev, status: 'loading' }));
    void (async () => {
      try {
        const res = await listPushcutBindings(client);
        if (cancelled) return;
        setPushcut((prev) => ({
          status: 'ok',
          bindings: res.bindings,
          ...(prev.secretRef ? { secretRef: prev.secretRef } : {}),
          ...(prev.pendingSecretValue ? { pendingSecretValue: prev.pendingSecretValue } : {}),
        }));
      } catch (e) {
        if (cancelled) return;
        const reason = e instanceof Error ? e.message : String(e);
        // fetchJson throws on non-OK; "404" in the message indicates
        // the NEXUS endpoint isn't mounted (daemon-only setup).
        if (reason.includes('404') || reason.includes('Not Found')) {
          setPushcut({ status: 'nexus-missing' });
        } else {
          setPushcut({ status: 'error', error: reason });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, health.status, config.baseUrl, pushcutNonce]);

  const refreshBindings = useCallback(() => {
    setPushcutNonce((n) => n + 1);
  }, []);

  const handleRotateSecret = useCallback(async (): Promise<void> => {
    setRotating(true);
    try {
      const newValue = generatePushcutToken();
      const res = await rotatePushcutSecret(client, newValue);
      setPushcut((prev) => ({
        ...prev,
        secretRef: res.ref,
        pendingSecretValue: newValue,
      }));
      toast.success('Pushcut secret rotated · copy + paste into iPhone Shortcut');
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      toast.error(`secret rotate failed: ${reason}`);
    } finally {
      setRotating(false);
    }
  }, [client]);

  const handleAddBinding = useCallback(async (): Promise<void> => {
    if (!newToken.trim()) {
      toast.error('token required');
      return;
    }
    const sid = newSessionId.trim() || sessionId;
    if (!sid) {
      toast.error('sessionId required (auto-fill: open this session in /term first)');
      return;
    }
    setBusyBinding('__new__');
    try {
      await upsertPushcutBinding(client, {
        token: newToken.trim(),
        sessionId: sid,
        ...(newLabel.trim() ? { label: newLabel.trim() } : {}),
      });
      toast.success('binding saved');
      setNewToken('');
      setNewSessionId('');
      setNewLabel('');
      refreshBindings();
    } catch (e) {
      toast.error(`binding save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyBinding(null);
    }
  }, [client, newToken, newSessionId, newLabel, sessionId, refreshBindings]);

  const handleDeleteBinding = useCallback(async (token: string): Promise<void> => {
    setBusyBinding(token);
    try {
      await deletePushcutBinding(client, token);
      toast.success(`binding deleted: ${token.slice(0, 8)}…`);
      refreshBindings();
    } catch (e) {
      toast.error(`delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyBinding(null);
    }
  }, [client, refreshBindings]);

  const fmtTime = (ms?: number): string => {
    if (typeof ms !== 'number') return '—';
    return `${ms} ms`;
  };

  const fmtChecked = (ts?: number): string => {
    if (!ts) return '';
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 5) return 'just now';
    if (sec < 60) return `${sec}s ago`;
    return `${Math.floor(sec / 60)}m ago`;
  };

  return (
    <div className="mx-auto max-w-2xl space-y-8 p-6">
      {/* M3-1 (Phase 3) — BudgetGuard threshold modal. Polls
          /v1/budget/status every 60s; surfaces a 3-option fallback
          modal once the user crosses notifyAtPct of their monthly
          USD cap. Renders null when no cap is set or the status is
          'ok' — invisible to casual users. */}
      <BudgetGuardWatcher />

      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Daemon connection, provider default, theme. Stored in localStorage.
        </p>
      </header>

      {/* PWA mirror PR 4 — first-boot welcome card. Auto-hides via the
          shared global.nexus.firstBootGuideShown switch (TUI's Esc-on-
          inert-chat dismiss writes the same flag). */}
      <WelcomeCard />

      {/* PWA mirror PR 2 — Chat backend Quick Setup card. Mirrors the
          TUI Settings tab so mobile / iOS / remote PWA users can wire
          a chat backend without dropping into the desktop TUI.
          Reads the NexusClient from context (NexusProvider in app/layout.tsx). */}
      <QuickSetupCard />
      <ObsidianSkillsCard />
      <ChildLlmPreferenceCard />
      <AnswerDepthCard />

      {/* Phase 3 anchor — `/setup/done` link cards 의 도착 지점. SETUP_LINKS
          inventory test (apps/pwa/src/app/setup/done/page.test.ts) 가 동일
          anchor id 셋 보장. CSS scroll-margin-top 로 sticky header 도 OK. */}
      <div id="channels" className="scroll-mt-8" aria-hidden />
      {/* BACKLOG #2 — connected/not-configured Badge per integration
          channel (Discord/Telegram/Pushcut/ACP/Tailscale share).
          Reads GET /v1/platforms · 30s refetch. Silently no-op when
          NexusClient absent (SSR / dev). */}
      <PlatformConnectionsCard />
      <ChannelBotSetupCard />

      {/* Phase 3 anchor — `/setup/done` link cards 도착 지점 (advanced). */}
      <div id="advanced" className="scroll-mt-8" aria-hidden />
      {/* RFC #2161 Phase 7 (2026-05-11) — registry catalog (Layer A)
          card. Provider list + per-provider model list + capability
          badges driven by /v1/registry/catalog. Refresh button hits
          POST /v1/registry/discovery (Phase 6) to re-fetch upstream
          model lists on demand. Phase 8 FU A4 (2026-05-11) absorbed
          the legacy ProviderCapabilityCard's capability matrix table —
          toggle "View: matrix" inside the card to see the 5×14 grid. */}
      <LlmCatalogCard />

      {/* §3.6 (post-DM-Stage-4 dogfood · 2026-05-10) — multi-host
          hot-reload GUI consumer for FU.A3 (#2118). Lets users add
          Anthropic/Gemini hosts at runtime so DM Stage 4 mixed-mode
          dogfood doesn't have to fall through to local LM Studio. */}
      <LlmHostsCard />

      {/* Round 3 PR1 (β-3 · 2026-05-08) — Pushcut HITL channel card.
          Reads /v1/hitl/audit/recent for the "last delivery" snapshot
          and exposes a Test notification button via /v1/hitl/test-pushcut. */}
      <PushcutSettingsCard />

      {/* Chat input automatic-routing preference (default OFF). */}
      <ChatRoutingCard />
      <FastReplyCard />

      {/* CV-3 dogfood follow-up (2026-05-09) — IntentPanel display
          mode (fixed/popup/off). Persisted via localStorage shim in
          intent-panel-storage.ts; the IntentPanel container subscribes
          to the same store + reflects flips immediately. */}
      <IntentPanelSettingsCard />

      {/* R-OCR.4.3 (2026-05-09) — camera-notes pipeline metrics. Polls
          GET /v1/metrics/notes-from-image every 10s; collector resets
          on daemon restart (no persistence at this phase). */}
      <NotesMetricsCard />

      {/* R-OCR follow-up Phase B (2026-05-09) — OCR provider prefs.
          LLM 비전 / 손글씨 default 토글 → NoteFromImageModal 의 초기 상태. */}
      <OcrPrefsCard />

      {/* Phase 3 anchor — `/setup/done` link cards 도착 지점 (voice). */}
      <div id="voice" className="scroll-mt-8" aria-hidden />
      {/* C2 (PWA pre-iOS round 2 follow-up · 2026-05-11) — BI-2 voice
          barge-in tuning slider. speakingThresholdMultiplier 1.0–5.0
          (default 2.0) · TTS 재생 중 자기-에코 false-fire 억제 강도. */}
      <VoicePrefsCard />

      {/* M2-3 (Phase 2) — Use-case preset card grid. 1-click applies
          STT/LLM/TTS tier + voice id + budget cap together. Sits ABOVE
          the individual sliders so casual users find it first. */}
      <PresetCardGrid />

      {/* M1-2 (PLAN-friction-free-model-selection-ux-2026-05-12 · 2026-05-12)
          — 5-tick STT tier slider (Budget · Balanced · Better · Best ·
          Loaded). Abstracts away model ids so the user expresses intent
          and elanous picks the model. Local persistence today · daemon
          sync to ~/.elanous/config.json lands in M1-2b. */}
      <VoiceModelTierCard />

      {/* M2-1 (Phase 2) — same 5-tick slider for LLM. Resolver consults
          the user's active provider (anthropic/openai/gemini/…) and
          maps tier → per-provider model. Token-based cost projection
          arrives in Phase 3 BudgetGuard. */}
      <LlmModelTierCard />

      {/* M2-2 (Phase 2) — TTS quality tier. Budget=macOS say (offline ·
          $0) / Balanced=openai-tts / Better=openai-tts-hd / Best=
          ElevenLabs Flash v2.5 / Loaded=ElevenLabs Multilingual v2.
          Voice identity (Rachel · SoYoung · custom) lives in a separate
          picker (sibling card below). */}
      <TtsModelTierCard />

      {/* M2-2b (Phase 2) — Per-context Voice ID picker. Quality tier
          and voice identity are orthogonal axes — chat reply can use
          Rachel, morning digest a Korean female, alerts urgent male.
          MVP: text-input per context · v2 adds ElevenLabs Library
          (10k+ voices) + 1-click preview + NL search. */}
      <TtsVoiceIdPickerCard />

      {/* M3-2 (Phase 3) — Embedding + Vision tier scaffolding. Sits
          below the voice cards because casual users almost never touch
          these surfaces (RAG / OCR). Resolvers wired daemon-side;
          actual call-site integration follows as RAG/vision pipelines
          come online. */}
      <EmbeddingVisionTierCard />

      <section className="space-y-3">
        <h2 className="text-sm font-medium">데몬 연결</h2>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Base URL</span>
          <Input
            value={config.baseUrl}
            placeholder="http://localhost:31415"
            onChange={(e) => setConfig({ baseUrl: e.target.value })}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">연결 토큰</span>
          <Input
            id="bearer-token"
            type="password"
            value={config.token}
            placeholder="다른 기기에서 만든 연결 토큰을 붙여 넣으세요"
            onChange={(e) => setConfig({ token: e.target.value })}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Default provider</span>
          <select
            value={config.provider}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs focus:outline-none focus:ring-2 focus:ring-ring"
            onChange={(e) => setConfig({ provider: e.target.value })}
          >
            {PROVIDER_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {p || '(none — server default)'}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Daemon health</h2>
          <Button variant="outline" size="sm" onClick={recheck} disabled={!config.baseUrl}>
            Recheck
          </Button>
        </div>
        <div className="rounded-md border border-border bg-card p-3 text-xs">
          {health.status === 'idle' && (
            <p className="text-muted-foreground">Set Base URL above to probe.</p>
          )}
          {health.status === 'loading' && (
            <p className="text-muted-foreground">Probing…</p>
          )}
          {health.status === 'ok' && (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
                <span className="font-medium text-foreground">Reachable</span>
                <span className="text-muted-foreground">{fmtTime(health.latencyMs)}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">{fmtChecked(health.checkedAt)}</span>
              </div>
              {typeof health.sessions === 'number' && (
                <p className="text-muted-foreground">
                  Active sessions: <span className="font-mono text-foreground">{health.sessions}</span>
                </p>
              )}
            </div>
          )}
          {health.status === 'error' && (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full bg-rose-500" aria-hidden />
                <span className="font-medium text-rose-600 dark:text-rose-400">Unreachable</span>
                <span className="text-muted-foreground">{fmtTime(health.latencyMs)}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">{fmtChecked(health.checkedAt)}</span>
              </div>
              <p className="break-all font-mono text-[11px] text-muted-foreground">
                {health.error}
              </p>
              <p className="text-[11px] text-muted-foreground">
                Verify Base URL · daemon running (<code className="rounded bg-muted px-1">elanous serve --status</code>) · network reachable from this device.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Phase 3 anchor — `/setup/done` link cards 도착 지점 (tools).
          Tool surface section 자체가 health probe 가 OK 일 때만 렌더되므로
          anchor 는 외부에서 항상 존재하도록 분리. */}
      <div id="tools" className="scroll-mt-8" aria-hidden />
      {(tools.status === 'ok' || tools.status === 'error') && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">LLM tool surface</h2>
          <div className="rounded-md border border-border bg-card p-3 text-xs">
            {tools.status === 'ok' && tools.kind === 'none' && (
              <p className="text-muted-foreground">
                Tools 미설정 — `elanous serve --tools readonly` 또는 `webterm` 으로 활성화.
              </p>
            )}
            {tools.status === 'ok' && tools.kind && tools.kind !== 'none' && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className={`inline-block h-2 w-2 rounded-full ${tools.kind === 'webterm' ? 'bg-amber-500' : 'bg-emerald-500'}`} aria-hidden />
                  <span className="font-medium text-foreground">kind:</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{tools.kind}</code>
                  {tools.kind === 'webterm' && (
                    <span className="text-[10px] text-amber-600 dark:text-amber-400">(write-capable)</span>
                  )}
                </div>
                {tools.specs && tools.specs.length > 0 && (
                  <ul className="flex flex-wrap gap-1">
                    {tools.specs.map((s) => (
                      <li
                        key={s.name}
                        title={s.description}
                        className="rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]"
                      >
                        {s.name}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {tools.status === 'error' && (
              <p className="text-muted-foreground">
                <span className="text-rose-500">tool surface 조회 실패</span> · {tools.error}
              </p>
            )}
          </div>
        </section>
      )}

      {/* Auth trace — diag ring buffer (in-memory, no file IO). Forensic
          tool for /v1/* 401 root-causing on user devices: shows the
          last N decisions with the headers that drove them. */}
      {(authTrace.status === 'ok' || authTrace.status === 'error') && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Auth trace</h2>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAuthTraceNonce((n) => n + 1)}
            >
              Refresh
            </Button>
          </div>
          <div className="rounded-md border border-border bg-card p-3 text-xs">
            {authTrace.status === 'error' && (
              <p className="text-muted-foreground">
                <span className="text-rose-500">auth-trace 조회 실패</span> · {authTrace.error}
              </p>
            )}
            {authTrace.status === 'ok' && (authTrace.entries?.length ?? 0) === 0 && (
              <p className="text-muted-foreground">
                아직 auth 결정 없음. /v1/* 호출이 한 번도 없었다는 뜻.
              </p>
            )}
            {authTrace.status === 'ok' && authTrace.entries && authTrace.entries.length > 0 && (
              <div className="max-h-64 overflow-auto font-mono text-[10px]">
                <table className="w-full">
                  <thead className="sticky top-0 bg-card text-muted-foreground">
                    <tr>
                      <th className="px-1 text-left">time</th>
                      <th className="px-1 text-left">path</th>
                      <th className="px-1 text-left">ok</th>
                      <th className="px-1 text-left">reason</th>
                      <th className="px-1 text-left">sfs</th>
                      <th className="px-1 text-left">origin</th>
                      <th className="px-1 text-left">host</th>
                    </tr>
                  </thead>
                  <tbody>
                    {authTrace.entries.slice().reverse().slice(0, 30).map((e, i) => (
                      <tr key={`${e.ts}-${i}`} className="border-t border-border/50">
                        <td className="px-1 whitespace-nowrap">{new Date(e.ts).toLocaleTimeString()}</td>
                        <td className="px-1 truncate max-w-[120px]">{e.path}</td>
                        <td className={`px-1 ${e.ok ? 'text-emerald-500' : 'text-rose-500'}`}>{e.ok ? 'Y' : 'N'}</td>
                        <td className="px-1 truncate max-w-[140px]">{e.reason}</td>
                        <td className="px-1 truncate max-w-[80px]">{e.sfs ?? '∅'}</td>
                        <td className="px-1 truncate max-w-[140px]">{e.origin ?? '∅'}</td>
                        <td className="px-1 truncate max-w-[140px]">{e.host ?? '∅'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}

      {sessionId && (tools.kind === 'webterm') && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Last screenshot</h2>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setScreenshotNonce((n) => n + 1)}
              disabled={screenshot.status === 'loading' || !config.baseUrl}
            >
              Refresh
            </Button>
          </div>
          <div className="rounded-md border border-border bg-card p-3 text-xs">
            {screenshot.status === 'loading' && (
              <p className="text-muted-foreground">Probing…</p>
            )}
            {screenshot.status === 'none' && (
              <p className="text-muted-foreground">
                아직 agent 가 screenshot 을 호출한 적 없음. <code className="rounded bg-muted px-1.5 py-0.5">WebTerminalScreenshot</code> tool 실행 후 Refresh.
              </p>
            )}
            {screenshot.status === 'ok' && screenshot.objectUrl && (
              <div className="space-y-1.5">
                <p className="text-muted-foreground">
                  Most recent <code className="rounded bg-muted px-1.5 py-0.5">tool_result</code> image in this session.
                </p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={screenshot.objectUrl}
                  alt="Last screenshot"
                  className="max-w-full rounded border border-border bg-black"
                />
              </div>
            )}
            {screenshot.status === 'error' && (
              <p className="text-muted-foreground">
                <span className="text-rose-500">screenshot 조회 실패</span> · {screenshot.error}
              </p>
            )}
          </div>
        </section>
      )}

      {/* WT-N-3+N-4 P2 — Pushcut webhook routing.
       *  Only renders once daemon is reachable so we don't probe NEXUS
       *  endpoints before the user has configured baseUrl. */}
      {(pushcut.status !== 'idle' || health.status === 'ok') && (
        <section className="space-y-3" data-testid="pushcut-section">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Pushcut webhook</h2>
            <Button
              variant="outline"
              size="sm"
              onClick={refreshBindings}
              disabled={pushcut.status === 'loading' || !config.baseUrl}
              data-testid="pushcut-refresh"
            >
              Refresh
            </Button>
          </div>
          <div className="rounded-md border border-border bg-card p-3 text-xs space-y-3">
            {pushcut.status === 'loading' && (
              <p className="text-muted-foreground">Probing…</p>
            )}
            {pushcut.status === 'nexus-missing' && (
              <p className="text-muted-foreground">
                NEXUS endpoints not reachable. <code className="rounded bg-muted px-1.5 py-0.5">elanous nexus</code> 로 띄우면 secret + binding 관리가 활성됩니다.
                <span className="block mt-1 text-[10px]">
                  (현재 daemon 만 단독 실행 중인 경우 — 본 섹션은 NEXUS HTTP 의 <code className="rounded bg-muted px-1">/v1/registry/bindings</code> + <code className="rounded bg-muted px-1">/v1/config/secrets</code> 의존)
                </span>
              </p>
            )}
            {pushcut.status === 'error' && (
              <p className="text-muted-foreground">
                <span className="text-rose-500">조회 실패</span> · {pushcut.error}
              </p>
            )}
            {(pushcut.status === 'ok' || pushcut.secretRef) && (
              <>
                {/* Secret — rotate UX. The plaintext is only available
                  * right after rotate; subsequent loads show ref only. */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">HMAC secret</span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => { void handleRotateSecret(); }}
                      disabled={rotating || !config.baseUrl}
                      data-testid="pushcut-rotate-secret"
                    >
                      {rotating ? 'Rotating…' : 'Rotate'}
                    </Button>
                  </div>
                  {pushcut.secretRef && (
                    <p className="font-mono text-[10px] text-muted-foreground">
                      ref: <span className="text-foreground">{pushcut.secretRef}</span> · id: <span className="text-foreground">{PUSHCUT_SECRET_ID}</span>
                    </p>
                  )}
                  {pushcut.pendingSecretValue && (
                    <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 dark:border-amber-700 dark:bg-amber-950">
                      <p className="text-[10px] font-semibold text-amber-700 dark:text-amber-200">
                        Copy now — only shown once
                      </p>
                      <code
                        className="block break-all font-mono text-[11px] text-amber-900 dark:text-amber-100 select-all"
                        data-testid="pushcut-secret-value"
                      >
                        {pushcut.pendingSecretValue}
                      </code>
                      <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">
                        Paste into iPhone &ldquo;elanous-camera&rdquo; Pushcut Shortcut Header <code className="rounded bg-muted px-1">X-Pushcut-Sig</code> recipe.
                      </p>
                    </div>
                  )}
                </div>

                {/* Bindings list — token → sessionId mapping. */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">연결 (토큰 → 대화)</span>
                    <span className="text-[10px] text-muted-foreground">
                      {(pushcut.bindings?.length ?? 0)} active
                    </span>
                  </div>
                  {(pushcut.bindings?.length ?? 0) === 0 && pushcut.status === 'ok' && (
                    <p className="text-[11px] text-muted-foreground">
                      No bindings yet. Add one below — the daemon will route Pushcut webhooks for that token to the chosen session.
                    </p>
                  )}
                  {pushcut.bindings && pushcut.bindings.length > 0 && (
                    <ul className="space-y-1" data-testid="pushcut-bindings-list">
                      {pushcut.bindings.map((b) => (
                        <li
                          key={b.key}
                          className="flex items-center gap-2 rounded border border-border bg-muted/30 px-2 py-1"
                        >
                          <div className="flex-1 min-w-0 space-y-0.5">
                            <div className="font-mono text-[11px] font-medium truncate">
                              {b.label ?? '(no label)'}
                            </div>
                            <div className="font-mono text-[10px] text-muted-foreground truncate">
                              token: {b.key.length > 16 ? `${b.key.slice(0, 8)}…${b.key.slice(-4)}` : b.key}
                            </div>
                            <div className="font-mono text-[10px] text-muted-foreground truncate">
                              session: {b.sessionId ?? '(unset)'}
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => { void handleDeleteBinding(b.key); }}
                            disabled={busyBinding === b.key}
                            data-testid={`pushcut-delete-${b.key}`}
                          >
                            {busyBinding === b.key ? 'Deleting…' : 'Delete'}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Add-binding form */}
                  <div className="space-y-1.5 rounded border border-dashed border-border p-2 mt-2">
                    <p className="text-[10px] font-medium text-muted-foreground">Add binding</p>
                    <Input
                      value={newToken}
                      placeholder="token (webhook URL key)"
                      onChange={(e) => setNewToken(e.target.value)}
                      data-testid="pushcut-add-token"
                      className="text-[11px]"
                    />
                    <Input
                      value={newSessionId}
                      placeholder={sessionId ? `sessionId (default: ${sessionId.slice(0, 12)}…)` : 'sessionId'}
                      onChange={(e) => setNewSessionId(e.target.value)}
                      data-testid="pushcut-add-session"
                      className="text-[11px]"
                    />
                    <Input
                      value={newLabel}
                      placeholder="label (e.g. iPhone 15)"
                      onChange={(e) => setNewLabel(e.target.value)}
                      data-testid="pushcut-add-label"
                      className="text-[11px]"
                    />
                    <Button
                      size="sm"
                      onClick={() => { void handleAddBinding(); }}
                      disabled={busyBinding === '__new__' || !newToken.trim()}
                      data-testid="pushcut-add-submit"
                    >
                      {busyBinding === '__new__' ? 'Saving…' : 'Add'}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">
            Channel: <code className="rounded bg-muted px-1">{PUSHCUT_BINDING_CHANNEL}</code> · powered by NEXUS subsystem registry (PR τ #1698) + secret backend (PR σ #1696). Webhook receiver lands in a follow-up daemon-side PR.
          </p>
        </section>
      )}

      {/* Phase 3 anchor — `/setup/done` link cards 도착 지점 (ios).
          Web Push + connect token = mobile companion setup 묶음. */}
      <div id="ios" className="scroll-mt-8" aria-hidden />
      {/* Service Worker Phase 3 — Web Push notifications. */}
      {pushNotif.supported && (
        <section className="space-y-3" data-testid="webpush-section">
          <h2 className="text-sm font-medium">Notifications</h2>
          <div className="rounded-md border border-border bg-card p-3 text-xs space-y-2">
            <div className="flex items-center gap-2">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  pushNotif.cachedId
                    ? 'bg-emerald-500'
                    : pushNotif.permission === 'denied'
                      ? 'bg-rose-500'
                      : 'bg-muted-foreground'
                }`}
                aria-hidden
              />
              <span className="font-medium">
                {pushNotif.cachedId ? 'Subscribed' : pushNotif.permission === 'denied' ? 'Permission denied' : 'Not subscribed'}
              </span>
              {pushNotif.cachedLabel && (
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {pushNotif.cachedLabel}
                </span>
              )}
            </div>
            {pushNotif.permission === 'denied' && (
              <p className="text-[10px] text-muted-foreground">
                Browser/iOS denied notification permission. Enable in Settings → Safari → Notifications, then reload.
              </p>
            )}
            {pushError && (
              <p className="text-[10px] text-rose-500 break-all" data-testid="webpush-error">{pushError}</p>
            )}
            <div className="flex flex-wrap gap-2">
              {!pushNotif.cachedId && (
                <Button
                  size="sm"
                  onClick={() => { void handleEnableNotifications(); }}
                  disabled={pushBusy || !config.baseUrl || pushNotif.permission === 'denied'}
                  data-testid="webpush-enable"
                >
                  {pushBusy ? 'Enabling…' : 'Enable notifications'}
                </Button>
              )}
              {pushNotif.cachedId && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { void handleDisableNotifications(); }}
                    disabled={pushBusy}
                    data-testid="webpush-disable"
                  >
                    {pushBusy ? 'Disabling…' : 'Disable'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { void handleTestNotification(); }}
                    disabled={pushBusy || !config.baseUrl}
                    data-testid="webpush-test"
                  >
                    Send test
                  </Button>
                </>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground">
              Push 알림은 PWA 가 닫혀 있어도 도착합니다 — agent turn 완료 · 녹화 종료 등. iOS 16.4+ home-screen installed PWA 만 작동 (Pushcut 가 fallback).
            </p>
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-medium">대화</h2>
        <div className="rounded-md border border-border bg-card px-3 py-2 font-mono text-xs">
          {sessionId || '(no session yet)'}
        </div>
        <p className="text-xs text-muted-foreground">
          A new session id is allocated on first load. Use Chat&rsquo;s
          <code className="mx-1 rounded bg-muted px-1.5 py-0.5">:fork</code>
          meta-command to start fresh once U-3 ships.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Theme</h2>
        <div className="flex flex-wrap gap-2">
          {THEMES.map((t) => (
            <Button
              key={t}
              variant={t === theme ? 'default' : 'outline'}
              size="sm"
              onClick={() => setTheme(t)}
            >
              {t}
            </Button>
          ))}
        </div>
      </section>

      <MermaidThemeSelector />

      {/* Phase 3 (2026-05-19) — Persona description editor.
          id="personas" anchor 가 본 카드 자체에 있음 (PersonaCard 내부 section).
          v2: list + description text only. Hermes PR #27572 채택 시 ⚗ Auto
          describer + orchestrator picker 가 본 카드 위에 land. */}
      <PersonaCard />

      {/* T1.B — Advanced setup map (NEXUS native vs wizard 분업 안내).
       *  Read-only reference. v2 (ROADMAP §9.1) 에서 dynamic detection 화. */}
      <AdvancedSetupMap />

      {/* T4.D — Generate connect token (다른 머신 elanous nexus connect 용). */}
      <ConnectTokenCard />

      {/* 빌드 정보 (2026-07-08) — 우하단 fixed 배너를 정식 카드로 이관. */}
      <MenuVisibilityCard />
      <BuildInfoCard />

      <Button onClick={() => toast.success('Settings saved')}>Saved</Button>
    </div>
  );
}
