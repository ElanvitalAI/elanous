// els nesting rule (ELS-NESTING-RULE, 내부 문서 `SIDETAB-ONE-SPACE` «겹침 규칙»): a program running INSIDE an els pane
// is told so by its environment (`ELANOUS_ELS_SOCKET` = the socket of the server that owns the pane). A second full screen
// inside that pane would draw a frame in a frame, so bare `els` there says why and stops. Subcommands are socket requests
// and work anywhere. A shell reached over ssh has no such variable and is the outermost frame.

/** True when `env` says this process runs in a pane of the server listening on `socketPath`. */
export function insideElsPane(env: Readonly<Record<string, string | undefined>>, socketPath: string): boolean {
  const mine = env.ELANOUS_ELS_SOCKET;
  return mine !== undefined && mine !== '' && mine === socketPath;
}

export const NESTED_ELS_MESSAGE =
  'els: 이미 els 안입니다(이 pane 은 els 서버가 소유합니다) — 바깥 els 에서 ctrl+b 로 이동하세요 · `els --list` 와 하위 명령(`els new` · `els pane read` …)은 여기서도 됩니다';

// eln-side rules (ELS-NESTING-RULE ① ③). Decisions are pure; the effects (talk to the server, start the outer frame) are injected.

/** Rule ①: an eln whose environment names a pane (`ELANOUS_ELS_PANE`) lives inside els — its sidetab is drawn inside itself. */
export function elnSidetabPlacement(env: Readonly<Record<string, string | undefined>>): 'inside-pane' | 'bare' {
  const pane = env.ELANOUS_ELS_PANE;
  return pane !== undefined && pane !== '' ? 'inside-pane' : 'bare';
}

export interface ElsHandoffDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly sessionId: string;
  readonly cwd: string;
  /** Workspace the session's pane joins. */
  readonly ws: string;
  /** One els server request (the real one is `requestEls` on the server socket). */
  readonly request: (req: { readonly op: 'new'; readonly ws: string; readonly cwd: string; readonly command: readonly string[]; readonly title: string }) => Promise<{ readonly exitCode: number; readonly message: string }>;
  /** Starts the outer els frame; resolves true when it is up. */
  readonly launchOuter: () => Promise<boolean>;
}

export type ElsHandoffResult =
  | { readonly kind: 'not-bare'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'handed-off'; readonly message: string };

/**
 * Rule ③: a bare eln's toggle puts els around the running session. The same session id is resumed (`eln --resume <id>`) in a
 * new pane first; only when that pane exists is the outer frame launched. On any failure nothing is lost: the caller keeps
 * its session and exits itself only on `handed-off`.
 */
export async function handOffToEls(deps: ElsHandoffDeps): Promise<ElsHandoffResult> {
  if (elnSidetabPlacement(deps.env) === 'inside-pane') return { kind: 'not-bare', message: NESTED_ELS_MESSAGE };
  const made = await deps.request({ op: 'new', ws: deps.ws, cwd: deps.cwd, command: ['eln', '--resume', deps.sessionId], title: 'eln' });
  if (made.exitCode !== 0) return { kind: 'failed', message: `els: 세션을 패널로 옮기지 못했습니다 — ${made.message}` };
  if (!(await deps.launchOuter())) return { kind: 'failed', message: 'els: 바깥 els 를 띄우지 못했습니다 — 패널은 els 서버에 남아 있습니다(`els --list`)' };
  return { kind: 'handed-off', message: `els: 세션 ${deps.sessionId} 을 패널로 옮겼습니다` };
}
