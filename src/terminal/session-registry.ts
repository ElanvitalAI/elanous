// Terminal session registry.
//
// Long-lived store of PTY sessions that outlive their modal wrapper.
// Central contract:
//
//   • session.preview is the authoritative PTY + emulator instance.
//   • session.modal is the optional, disposable wrapper binding that
//     preview to a coordinator ModalSurface.
//   • detach() disposes modal BUT keeps preview alive; attach()
//     wraps the existing preview in a fresh modal (possibly against
//     different bounds because the terminal was resized).
//
// At most one session may be foreground at a time — attaching a
// background session auto-detaches the current foreground.
//
// No persistence at this phase (P16 adds metadata write). Kill
// cleans up both halves and removes the session entry.

import {
  PreviewTerminal,
  type PreviewTerminalOpts,
  type SpawnFn,
} from '../preview/terminal.js';
import { getGlobalElementRegistry, publishElementEvent } from '../element-registry/index.js';
import {
  createInteractiveTerminalModal,
  type InteractiveTerminalModalHandle,
  type InteractiveTerminalModalSpec,
} from '../interactive-terminal-modal.js';
import type { DisplayCoordinator } from '../display/coordinator.js';
import type { DisplayEventBus } from '../display/events.js';
import { defaultControlSignalBus, type ControlSignalBus } from '../input/control-signal.js';

export type SessionState = 'foreground' | 'background' | 'exited';
export type SessionKind = 'shell' | 'coding-agent';
export type CodingAgentBrand = 'claude-code' | 'codex' | 'gemini';

export interface TerminalSession {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly command?: string;
  readonly kind: SessionKind;
  readonly agentBrand?: CodingAgentBrand;
  readonly startedAt: number;
  readonly termName?: string;
  state: SessionState;
  lastFocusedAt: number;
  exitCode: number | null;
  attentionLevel: 0 | 1 | 2 | 3;
  lastNotification?: { title: string; body?: string; at: number };
  preview: PreviewTerminal;
  modal: InteractiveTerminalModalHandle | null;
}

export type SessionEvent =
  | { type: 'spawned'; session: TerminalSession }
  | { type: 'attached'; session: TerminalSession }
  | { type: 'detached'; session: TerminalSession }
  | { type: 'exited'; session: TerminalSession }
  | { type: 'killed'; session: TerminalSession }
  | { type: 'attention'; session: TerminalSession; level: 1 | 2 | 3 };

export interface SessionSpawnSpec extends Omit<InteractiveTerminalModalSpec, 'onExit' | 'onClose'> {
  kind?: SessionKind;
  agentBrand?: CodingAgentBrand;
  onExit?: (session: TerminalSession, code: number | null) => void;
}

export const MAX_SESSIONS = 8;

export interface RegistryDeps {
  coordinator: DisplayCoordinator;
  eventBus?: DisplayEventBus;
  now?: () => number;
  terminalFactory?: (opts: PreviewTerminalOpts, spawn?: SpawnFn) => PreviewTerminal;
  spawn?: SpawnFn;
  signalBus?: ControlSignalBus;
}

export class TerminalSessionRegistry {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly subscribers = new Set<(ev: SessionEvent) => void>();
  private readonly now: () => number;
  private readonly signalBus: ControlSignalBus;
  private idCounter = 1;

  constructor(private readonly deps: RegistryDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.signalBus = deps.signalBus ?? defaultControlSignalBus();
    this.signalBus.subscribe(
      { kind: 'terminal-session-stop', minUrgency: 'quick-pass' },
      (signal) => {
        const sessionId = signal.scope?.sessionId;
        if (!sessionId) return;
        this.kill(sessionId);
      },
    );
  }

  list(): TerminalSession[] {
    return [...this.sessions.values()];
  }

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  foreground(): TerminalSession | undefined {
    return this.list().find(s => s.state === 'foreground');
  }

  backgrounded(): TerminalSession[] {
    return this.list().filter(s => s.state === 'background');
  }

  subscribe(cb: (ev: SessionEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => { this.subscribers.delete(cb); };
  }

  spawn(spec: SessionSpawnSpec, deps: { termCols: number; termRows: number }): TerminalSession {
    const alive = this.list().filter(s => s.state !== 'exited');
    if (alive.length >= MAX_SESSIONS) {
      throw new Error(`max ${MAX_SESSIONS} concurrent terminal sessions reached`);
    }
    const id = spec.id ?? `term-session:${this.idCounter++}`;

    // Auto-detach existing foreground so only one is visible.
    const prior = this.foreground();
    if (prior) this.detach(prior.id);

    const session: TerminalSession = {
      id,
      title: spec.title,
      cwd: spec.cwd,
      command: spec.command,
      kind: spec.kind ?? 'shell',
      agentBrand: spec.agentBrand,
      termName: spec.termName,
      startedAt: this.now(),
      state: 'foreground',
      lastFocusedAt: this.now(),
      exitCode: null,
      attentionLevel: 0,
      // filled in below
      preview: undefined as unknown as PreviewTerminal,
      modal: null,
    };

    const handle = createInteractiveTerminalModal(
      {
        id,
        title: spec.title,
        cwd: spec.cwd,
        command: spec.command,
        shell: spec.shell,
        shellArgs: spec.shellArgs,
        env: spec.env,
        unsetEnv: spec.unsetEnv,
        termName: spec.termName,
        useRegistry: spec.useRegistry,
        registryKind: spec.registryKind,
        registryNickname: spec.registryNickname,
        registryOrigin: spec.registryOrigin,
        registryPurpose: spec.registryPurpose,
        registrySeat: spec.registrySeat,
        bounds: spec.bounds,
        sizePreset: spec.sizePreset,
        onExit: (code) => {
          session.exitCode = code;
          session.state = 'exited';
          this.emit({ type: 'exited', session });
          try { spec.onExit?.(session, code); } catch { /* swallow */ }
        },
        // P13 — funnel OSC notifications into attention-level +
        // lastNotification fields on the session. Background
        // sessions getting a notify now light up the roster ring
        // and surface in session picker.
        onOscNotify: (ev) => {
          const level = ev.code === 777 ? 2 : ev.code === 9 ? 1 : 2;
          this.raiseAttention(
            id,
            level as 1 | 2,
            { title: ev.title, body: ev.body || undefined },
          );
        },
        // Forward title-bar control clicks ([─] minimize / [✕] close)
        // through to the caller so it can map them to detach / kill
        // operations against the session registry.
        onTitleAction: spec.onTitleAction,
      },
      {
        coordinator: this.deps.coordinator,
        eventBus: this.deps.eventBus,
        termCols: deps.termCols,
        termRows: deps.termRows,
        terminalFactory: this.deps.terminalFactory,
        spawn: this.deps.spawn,
      },
    );
    session.preview = handle.preview;
    session.modal = handle;
    this.sessions.set(id, session);
    getGlobalElementRegistry().register('session', id, { kind: 'session', id });
    publishElementEvent('session', id, 'create', { title: session.title, kind: session.kind });
    this.emit({ type: 'spawned', session });
    return session;
  }

  /** Send foreground session to background: dispose modal, keep
   *  preview alive for later re-attach. No-op if already background
   *  or exited. */
  detach(id: string): TerminalSession | undefined {
    const session = this.sessions.get(id);
    if (!session || session.state !== 'foreground') return session;
    if (session.modal) {
      session.modal.dispose({ keepPreview: true });
      session.modal = null;
    }
    session.state = 'background';
    this.emit({ type: 'detached', session });
    return session;
  }

  /** Bring a background session to foreground. Rewraps preview in
   *  a fresh modal; any prior foreground auto-detaches. */
  attach(id: string, deps: { termCols: number; termRows: number }): TerminalSession | undefined {
    const session = this.sessions.get(id);
    if (!session || session.state === 'exited') return session;
    if (session.state === 'foreground') return session;

    const prior = this.foreground();
    if (prior && prior.id !== id) this.detach(prior.id);

    const handle = createInteractiveTerminalModal(
      {
        id: session.id,
        title: session.title,
        cwd: session.cwd,
        command: session.command,
        termName: session.termName,
      },
      {
        coordinator: this.deps.coordinator,
        eventBus: this.deps.eventBus,
        termCols: deps.termCols,
        termRows: deps.termRows,
        existingPreview: session.preview,
      },
    );
    session.modal = handle;
    session.state = 'foreground';
    session.lastFocusedAt = this.now();
    this.emit({ type: 'attached', session });
    return session;
  }

  /** Kill the PTY + drop the session. Safe to call on any state. */
  kill(id: string, signal: NodeJS.Signals = 'SIGTERM'): TerminalSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    try {
      if (session.modal) session.modal.dispose({ keepPreview: true });
    } catch { /* ignore */ }
    try {
      // PreviewTerminal.stop sends SIGHUP; for explicit SIGKILL we'd
      // need to expose kill(sig) on PreviewTerminal — deferred.
      void signal;
      session.preview.stop();
    } catch { /* ignore */ }
    session.modal = null;
    session.state = 'exited';
    this.emit({ type: 'killed', session });
    return session;
  }

  /** Report an attention event (OSC 9/99/777 from P13 will call
   *  into this). Level is clamped to [1, 3]. */
  raiseAttention(id: string, level: 1 | 2 | 3, note?: { title: string; body?: string }): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.attentionLevel = Math.max(session.attentionLevel, Math.min(3, level)) as 0 | 1 | 2 | 3;
    if (note) session.lastNotification = { title: note.title, body: note.body, at: this.now() };
    this.emit({ type: 'attention', session, level });
  }

  /** Clear attention — called when the session re-gains focus. */
  clearAttention(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.attentionLevel = 0;
  }

  /** Purge exited sessions. Returns how many were removed. */
  gc(): number {
    let n = 0;
    const reg = getGlobalElementRegistry();
    for (const [id, s] of [...this.sessions.entries()]) {
      if (s.state === 'exited') {
        this.sessions.delete(id);
        reg.unregister('session', id);
        publishElementEvent('session', id, 'delete');
        n++;
      }
    }
    return n;
  }

  private emit(ev: SessionEvent): void {
    for (const cb of this.subscribers) {
      try { cb(ev); } catch { /* subscriber errors are contained */ }
    }
  }
}
