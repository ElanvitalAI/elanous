/** Next TUI public-approval-URL session seam (JUD-TUI-77965-C).
 *
 * Standalone state machine + copy for the owner publish-approval screen: it shows the
 * public approval URL, opens it only on an explicit key press, and then waits for the
 * owner to approve or reject. It deliberately does not touch `entry.ts`,
 * `shell-approval-session.ts` or the CLI `presentApprovalUrl` contract; integration is a
 * separate, later claim. The URL carries a secret token, so it is only ever returned
 * through `lines()`; status text never contains it.
 */
import type { Key } from '../tui.js';

export type PublishApprovalPhase = 'url' | 'waiting' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'acknowledged';
export type PublishApprovalOutcome = Exclude<PublishApprovalPhase, 'url' | 'waiting'>;

export interface PublishApprovalSessionPorts {
  readonly setStatus: (status: string) => void;
  readonly render: () => void;
  /** Explicit open request; never called without a key press. Failure keeps the URL visible. */
  readonly openUrl?: (url: string) => Promise<void> | void;
  readonly now?: () => number;
  readonly columns?: () => number;
  /** How often the screen re-renders so the countdown moves without other events (default 1 s; 0 = off). */
  readonly tickMs?: number;
  /** Enter on the URL screen: the owner has seen the URL and now waits for the decision. */
  readonly onWaiting?: () => void;
}

export const publishApprovalStatus = (phase: PublishApprovalPhase): string => ({
  url: '공개 승인 URL 확인 필요 · o 열기',
  waiting: '소유자 승인 대기 중 · Esc 취소',
  approved: '소유자 승인됨',
  rejected: '소유자 거절됨',
  expired: '승인 시간 초과 · 거부됨',
  cancelled: '승인 취소됨',
  acknowledged: '확인됨 · 소유자 승인을 기다리는 중',
}[phase]);

export const publishApprovalHelp = (phase: PublishApprovalPhase): string =>
  phase === 'url' ? 'o 브라우저에서 열기 · Enter 대기 · Esc 취소'
    : phase === 'waiting' ? 'o 다시 열기 · Esc 취소' : '닫기: Enter';

/** Hosts that only mean something on this machine or its network — never a public approval address. */
const PRIVATE_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet', '.corp'] as const;

/** A public approval address has a DNS name: no IP literal (v4 or v6), no single-label host, nothing local or internal. */
const isPublicHostname = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.startsWith('[') || host.includes(':')) return false; // IPv6 literal
  if (/^[0-9.]+$/.test(host) || /^0x[0-9a-f.]+$/i.test(host)) return false; // IPv4 literal in any spelling the URL parser may leave
  if (!host.includes('.')) return false; // single label: localhost, a LAN machine name
  if (host === 'localhost' || PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  return true;
};

/** Only https URLs with a public DNS host and without credentials may be shown or opened; anything else falls back to the text prompt. */
export const isPublicApprovalUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !/[\s\u0000-\u001f]/.test(value) && isPublicHostname(url.hostname);
  } catch { return false; }
};

export const formatRemaining = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const cellWidth = (text: string): number => Bun.stringWidth(text);

/** Hard-wrap by display width, one grapheme at a time, so a long URL stays fully copyable across lines, an emoji is never split
 *  and no line is wider than `width` (a single grapheme wider than the screen stands alone). */
export const wrapByWidth = (text: string, width: number): string[] => {
  const size = Math.max(1, Math.floor(width));
  const out: string[] = [];
  let line = '';
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const w = cellWidth(segment);
    if (used > 0 && used + w > size) { out.push(line); line = ''; used = 0; }
    line += segment; used += w;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
};

/** Prose (labels, status, help) wrapped at spaces to `width` cells, so nothing is lost on a narrow screen; a word wider than the
 *  line is hard-wrapped. The URL itself is wrapped without regard to spaces by {@link wrapByWidth}. */
export const wrapProse = (text: string, width: number): string[] => {
  const size = Math.max(1, Math.floor(width));
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ').filter((part) => part.length > 0)) {
    for (const piece of cellWidth(word) > size ? wrapByWidth(word, size) : [word]) {
      if (line && cellWidth(line) + 1 + cellWidth(piece) <= size) line += ` ${piece}`;
      else { if (line) out.push(line); line = piece; }
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
};

export function createPublishApprovalSession(ports: PublishApprovalSessionPorts) {
  const now = ports.now ?? Date.now;
  let url: string | null = null;
  let expiresAtMs = 0;
  let phase: PublishApprovalPhase | null = null;
  let note = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let settle: ((outcome: PublishApprovalOutcome) => void) | null = null;
  /** Which visit an asynchronous browser-open result belongs to: a late answer from an old visit never touches a new one. */
  let visit = 0;

  const clear = (): void => {
    if (timer) clearTimeout(timer);
    if (ticker) clearInterval(ticker);
    timer = null; ticker = null;
  };
  const finish = (outcome: PublishApprovalOutcome): void => {
    if (!settle) return;
    const done = settle;
    settle = null; clear(); phase = outcome; visit += 1;
    // A person's own Esc and a hand-off to the owner's decision leave nothing to read: the status line says it, the screen goes away.
    // An end the person did not choose (approved, rejected, expired) stays up until they dismiss it.
    if (outcome === 'cancelled' || outcome === 'acknowledged') { phase = null; url = null; note = ''; }
    ports.setStatus(publishApprovalStatus(outcome)); ports.render();
    done(outcome);
  };

  return {
    /** Show the approval URL; resolves with how the visit ended. Fails closed on a bad URL. */
    present: (approvalUrl: string, expiresAt: string): Promise<PublishApprovalOutcome> =>
      new Promise<PublishApprovalOutcome>((resolve) => {
        const deadline = Date.parse(expiresAt);
        if (phase === 'url' || phase === 'waiting' || !isPublicApprovalUrl(approvalUrl)
          || !Number.isFinite(deadline) || deadline <= now()) {
          resolve(deadline <= now() ? 'expired' : 'cancelled'); return;
        }
        url = approvalUrl; expiresAtMs = deadline; phase = 'url'; note = ''; settle = resolve; visit += 1;
        timer = setTimeout(() => finish('expired'), Math.max(1, deadline - now()));
        const tickMs = ports.tickMs ?? 1000;
        if (tickMs > 0) {
          ticker = setInterval(() => { if (settle) ports.render(); }, tickMs);
          (ticker as { unref?: () => void }).unref?.();
        }
        ports.setStatus(publishApprovalStatus('url')); ports.render();
      }),
    /** The owner-side answer arrived from the transport. */
    owner: (decision: 'approved' | 'rejected'): void => {
      if (!settle) return;
      // The deadline wins over a late answer: an approval that arrives after it never counts.
      finish(now() >= expiresAtMs ? 'expired' : decision);
    },
    /** The owner has seen the URL and the decision now happens elsewhere: close the screen without calling it a cancellation. */
    acknowledge: (): void => { finish('acknowledged'); },
    phase: (): PublishApprovalPhase | null => phase,
    /** Screen body for the render loop; empty when no visit is active. */
    lines: (): string[] => {
      if (!phase || !url) return [];
      const width = Math.max(1, Math.floor(ports.columns?.() ?? 80));
      const live = phase === 'url' || phase === 'waiting';
      // Every line fits the screen: prose wraps at spaces, the URL wraps anywhere (and is indented only when there is room for it).
      const indent = width >= 8 ? '  ' : '';
      return [
        ...wrapProse('공개 승인 URL', width),
        ...(live ? wrapByWidth(url, width - indent.length).map((l) => indent + l) : []),
        ...wrapProse(live ? `남은 시간 ${formatRemaining(expiresAtMs - now())}` : publishApprovalStatus(phase), width),
        ...(note ? wrapProse(note, width) : []),
        ...wrapProse(publishApprovalHelp(phase), width),
      ];
    },
    handleKey: (key: Key): boolean => {
      // An end screen (approved · rejected · expired) is still up: Enter or Esc closes it; other keys wait, as the help line says.
      if (!settle && url && phase) {
        if (key.name === 'return' || key.name === 'escape') { phase = null; url = null; note = ''; visit += 1; ports.render(); }
        return true;
      }
      if (!settle || !url) return false;
      if (now() >= expiresAtMs) { finish('expired'); return true; }
      if (key.name === 'escape') { finish('cancelled'); return true; }
      if (key.name === 'return' && phase === 'url') {
        phase = 'waiting'; ports.setStatus(publishApprovalStatus('waiting')); ports.render(); ports.onWaiting?.(); return true;
      }
      if (key.name === 'o' && !key.ctrl) {
        const target = url;
        const thisVisit = visit;
        note = ports.openUrl ? '여는 중…' : '자동 열기를 쓸 수 없습니다 · 위 URL을 직접 여세요';
        if (ports.openUrl) {
          Promise.resolve().then(() => ports.openUrl!(target)).then(
            () => { if (visit === thisVisit) { note = '브라우저 열기 요청됨'; ports.render(); } },
            () => { if (visit === thisVisit) { note = '열지 못했습니다 · 위 URL을 직접 여세요'; ports.render(); } },
          );
        }
        ports.render(); return true;
      }
      return true; // swallow other keys while the screen owns input
    },
    dispose: (): void => { finish('cancelled'); phase = null; url = null; },
  };
}

export type PublishApprovalSession = ReturnType<typeof createPublishApprovalSession>;

/**
 * The host side of one publish-approval call from the REPL child: shows the screen, answers `true` once the owner pressed Enter
 * (seen the URL, now waiting — the screen then closes, the decision itself is polled in the child), and answers `false` for
 * Esc, expiry, a cancelled turn or a child-side cancel. One call at a time; a second call is refused.
 */
export function createPublishApprovalHost(ports: Omit<PublishApprovalSessionPorts, 'onWaiting'>) {
  let activeCallId: string | null = null;
  let answer: ((acknowledged: boolean) => void) | null = null;
  const settle = (acknowledged: boolean): void => {
    const done = answer;
    answer = null; activeCallId = null;
    done?.(acknowledged);
  };
  const session = createPublishApprovalSession({
    ...ports,
    onWaiting: () => { settle(true); session.acknowledge(); },
  });
  return {
    session,
    /** The child asks the owner to look at this URL. */
    begin: (call: { url: string; expiresAt: string }, callId: string): Promise<boolean> => new Promise<boolean>((resolve) => {
      if (activeCallId !== null) { resolve(false); return; }
      activeCallId = callId; answer = resolve;
      void session.present(call.url, call.expiresAt).then(() => { settle(false); ports.render(); });
    }),
    /** The child (timeout, cancelled turn) withdrew a call; true when it was the publish call. */
    cancel: (callId: string): boolean => {
      if (callId !== activeCallId) return false;
      session.dispose();
      return true;
    },
    dispose: (): void => { session.dispose(); },
  };
}
