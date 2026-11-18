/**
 * APP-BUILD-DECLINE-NO-BYPASS-DEPLOY — a declined app_build stays declined for the turn.
 *
 * 11-16 14:02 예행(UX #77384): the owner declined (or did not answer) the app_build
 * confirmation, the tool returned only `confirmation declined for app_build`, and the
 * model then built with Bash and exposed the host with `tailscale serve`. The decline
 * was an owner decision, so a different tool must not carry out the same deploy.
 *
 * Two pieces, both deterministic and plugin-layer only:
 *   1. `appBuildDeclinedFailure` — the explicit, structured result the model sees.
 *   2. `createAppBuildDeclineTurnGuard` — after that result, shell calls in the same
 *      turn that expose a host or deploy are refused before they run.
 */

export const APP_BUILD_DECLINED_CODE = 'APP_BUILD_DECLINED';
export const APP_BUILD_PLUGIN_ID = 'elanous-app-build';
export const APP_BUILD_DECLINE_INSTRUCTION =
  'Do not build or deploy by other means in this turn (no Bash build/serve, no tailscale serve/funnel, no public listener, no deploy CLI); ask the user.';

export interface AppBuildDeclinedFailure {
  ok: false;
  error: string;
  code: typeof APP_BUILD_DECLINED_CODE;
  declined: true;
  reason: 'declined' | 'confirmation-failed';
  instruction: string;
}

/** The structured result returned when the owner declines or does not answer app_build. */
export function appBuildDeclinedFailure(toolName: string, reason: AppBuildDeclinedFailure['reason']): AppBuildDeclinedFailure {
  return {
    ok: false,
    // The error text carries the instruction too, so hosts that keep only `error` still tell the model.
    error: `${APP_BUILD_DECLINED_CODE}: the user declined or did not answer the ${toolName} confirmation. ${APP_BUILD_DECLINE_INSTRUCTION}`,
    code: APP_BUILD_DECLINED_CODE,
    declined: true,
    reason,
    instruction: APP_BUILD_DECLINE_INSTRUCTION,
  };
}

/** True for a dispatch result that is the structured app_build decline. */
export function isAppBuildDeclined(result: unknown): boolean {
  return !!result && typeof result === 'object' && !Array.isArray(result)
    && (result as { code?: unknown }).code === APP_BUILD_DECLINED_CODE;
}

/**
 * Explicit bypass-deploy patterns. Small on purpose: each entry is a way to put a
 * built app in front of other people without the app_build graph.
 */
export const BYPASS_DEPLOY_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: 'tailscale-serve', pattern: /\btailscale\s+(?:[^\n;|&]*\s)?serve\b/i },
  { id: 'tailscale-funnel', pattern: /\btailscale\s+(?:[^\n;|&]*\s)?funnel\b/i },
  { id: 'public-tunnel', pattern: /\b(?:ngrok|cloudflared\s+(?:[^\n;|&]*\s)?tunnel|localtunnel|lt\s+--port)\b/i },
  { id: 'all-interfaces-bind', pattern: /(?:^|[\s=:'"(\[])(?:0\.0\.0\.0|\[::\])(?=$|[\s:'")\],])/ },
  { id: 'host-all-interfaces-flag', pattern: /--host(?:=|\s+)(?:0\.0\.0\.0|::|all)\b/i },
  { id: 'python-http-server', pattern: /\bpython3?\s+-m\s+http\.server\b(?![^\n;|&]*--bind\s+127\.0\.0\.1)/i },
  { id: 'deploy-cli', pattern: /\b(?:vercel(?:\s+deploy|\s+--prod)|netlify\s+deploy|fly(?:ctl)?\s+deploy|firebase\s+deploy|wrangler\s+(?:deploy|publish|pages\s+deploy)|gcloud\s+(?:run|app)\s+deploy|surge\b)/i },
  { id: 'elanous-deploy-cli', pattern: /\b(?:elanous|eln)\s+(?:app\s+(?:deploy|publish)|deploy)\b/i },
];

/** Shell-capable tool names whose command text the guard inspects. */
const SHELL_TOOL_NAMES = new Set(['Bash', 'RunShell', 'bash', 'run_shell']);

function shellCommandText(name: string, args: Record<string, unknown>): string | null {
  if (!SHELL_TOOL_NAMES.has(name) && !name.startsWith('PtyShell') && !name.startsWith('pty_shell')) return null;
  const parts: string[] = [];
  for (const key of ['command', 'cmd', 'input', 'text', 'argv', 'args']) {
    const value = args[key];
    if (typeof value === 'string') parts.push(value);
    else if (Array.isArray(value)) parts.push(value.filter((entry): entry is string => typeof entry === 'string').join(' '));
  }
  return parts.join('\n');
}

/** The first bypass-deploy pattern a shell command matches, or null. */
export function matchBypassDeploy(command: string): string | null {
  for (const { id, pattern } of BYPASS_DEPLOY_PATTERNS) if (pattern.test(command)) return id;
  return null;
}

export interface BypassDeployRefusal {
  error: string;
  code: 'APP_BUILD_DECLINED_BYPASS_REFUSED';
  refused: true;
  matched: string;
  instruction: string;
}

/**
 * Per-session guard scoped to one turn. `getTurnId` is the host's turn/request id;
 * a host without one keeps the guard armed for the rest of the session (fail closed).
 */
export function createAppBuildDeclineTurnGuard(getTurnId: () => string | undefined) {
  let armed = false;
  let declinedTurn: string | undefined;
  return {
    /** Feed every plugin dispatch result; a structured decline arms the guard for this turn. */
    observe(result: unknown): void {
      if (!isAppBuildDeclined(result)) return;
      armed = true;
      declinedTurn = getTurnId();
    },
    /** A refusal for a bypass deploy in the declined turn, or null to let the call run. */
    refuse(name: string, args: Record<string, unknown>): BypassDeployRefusal | null {
      if (!armed) return null;
      const turn = getTurnId();
      if (declinedTurn !== undefined && turn !== declinedTurn) { armed = false; declinedTurn = undefined; return null; }
      const command = shellCommandText(name, args);
      if (!command) return null;
      const matched = matchBypassDeploy(command);
      if (!matched) return null;
      return {
        error: `Refused: the user declined app_build in this turn, so ${name} may not deploy or expose a host (${matched}). ${APP_BUILD_DECLINE_INSTRUCTION}`,
        code: 'APP_BUILD_DECLINED_BYPASS_REFUSED',
        refused: true,
        matched,
        instruction: APP_BUILD_DECLINE_INSTRUCTION,
      };
    },
  };
}

export type AppBuildDeclineTurnGuard = ReturnType<typeof createAppBuildDeclineTurnGuard>;
