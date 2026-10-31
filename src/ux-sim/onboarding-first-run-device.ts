// ux-sim device: the PRODUCTION fresh-install setup menu, driven under a real util-linux PTY.
//
// Why this exists: the fresh-install setup menu is only reachable when
// `process.stdin.isTTY` is true. A plain pipe makes the CLI take the non-TTY
// `needs-llm` shortcut instead, so the board (how many times the menu comes
// back, which phrase ends the run, whether `onboarding.ready` is written) is
// unmeasurable without a TTY. This device allocates one the same way the live
// seat does — util-linux `script -q -e -c` — so the production entrypoint
// `bin/elanous.mjs --test` runs its real `src/index.ts` → `runFirstRun` →
// `runFirstRunProviderSetup` path.
//
// Isolation (K-MK-03): HOME/XDG/claude dirs are a fresh temp tree and the CLI
// is spawned with `--test --config-dir <temp>`, so the run cannot touch a real
// seat's config/state. `script` comes from `fake-bin`'s PTY shim, which records
// the call — the observation therefore proves the PTY was util-linux, not a
// hand-rolled pipe.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FIRST_RUN_PROVIDER_MENU_PROMPT, formatProviderMenu, orderProviderChoices } from '../onboarding/first-run.js';
import {
  FIRST_RUN_PROVIDER_SETUP_MENU_CHOICES,
  FIRST_RUN_PROVIDER_SETUP_MENU_HEADING,
  FIRST_RUN_PROVIDER_SETUP_MENU_MAX_MISSES,
} from '../cli/setup-keys.js';
import { spawnElanousSync } from '../instance/spawn-elanous.js';
import { createFakeBins, utilLinuxScript, type FakeBinCall } from './fake-bin.js';
/** English provider chooser and Korean fresh-install chooser headings. */
export const FIRST_RUN_MENU_MARKERS = [FIRST_RUN_PROVIDER_MENU_PROMPT, FIRST_RUN_PROVIDER_SETUP_MENU_HEADING] as const;

/** Count menu renders independently of the selected user-facing locale. */
export function countFirstRunMenuRenders(output: string): number {
  const markerCounts = FIRST_RUN_MENU_MARKERS.map((marker) => output.split(marker).length - 1);
  // A process keeps one locale; max also avoids counting one bilingual render twice.
  return Math.max(...markerCounts);
}
/** Fixed provider-chooser choice line, taken from the production renderer. */
export const FIRST_RUN_MENU_CHOICES = formatProviderMenu(orderProviderChoices());
export const FIRST_RUN_MENU_CHOICE_MARKERS = [FIRST_RUN_MENU_CHOICES, FIRST_RUN_PROVIDER_SETUP_MENU_CHOICES] as const;
/** Line `runFirstRun` prints before a fresh install has to pick a provider. */
export const FIRST_RUN_SETUP_HINT = 'eln setup llm 으로 고르세요';
/** Misses the parser must reject: out of range, exponent, and full-width digits. */
export const FIRST_RUN_MENU_ANSWERS = ['4', '1e0', '１'] as const;

const repoRoot = resolve(import.meta.dir, '../..');
const cliEntry = join(repoRoot, 'bin', 'elanous.mjs');

export interface FirstRunPtySupport {
  /** True when this host can run the production CLI under util-linux `script`. */
  readonly available: boolean;
  /** Why the stage is unavailable (`null` when available). */
  readonly reason: string | null;
  /** Absolute path of the util-linux `script` that would allocate the PTY. */
  readonly scriptPath: string | null;
}

/**
 * Can this host allocate the PTY stage? macOS ships BSD `script`, whose flags are
 * not `-q -e -c`, so the stage is Linux-only — the two production TTY tests keep
 * their existing Darwin skip and report this reason instead of silently passing.
 */
export function firstRunPtySupport(): FirstRunPtySupport {
  if (process.platform !== 'linux') {
    return {
      available: false,
      reason: `util-linux \`script -q -e -c\` PTY stage needs Linux (this host is ${process.platform})`,
      scriptPath: null,
    };
  }
  const scriptPath = utilLinuxScript();
  if (scriptPath === null) {
    return { available: false, reason: 'no util-linux `script` on PATH', scriptPath: null };
  }
  return { available: true, reason: null, scriptPath };
}

export interface FirstRunMenuDeviceOptions {
  /** Answers written to the PTY, one per rendered menu (default `FIRST_RUN_MENU_ANSWERS`). */
  readonly answers?: readonly string[];
  /** Hard stop for the child (default 45 s; the caller's own test budget must exceed it). */
  readonly timeoutMs?: number;
  /** Delay between «menu seen» and «answer written» so readline is listening (default 300 ms). */
  readonly answerDelayMs?: number;
  /** Keep the isolated home/config tree instead of deleting it (default false). */
  readonly keepRoot?: boolean;
}

export interface FirstRunMenuObservation {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly timedOut: boolean;
  /** How many times the menu block was rendered on stdout. */
  readonly menuRenderCount: number;
  /** Answers actually written to the PTY, in order. */
  readonly answersSent: readonly string[];
  /** `FIRST_RUN_SETUP_HINT` when the run ended on the fresh-install hint, else null. */
  readonly finalPhrase: string | null;
  /** True when the isolated config recorded `onboarding.ready`. */
  readonly readyRecorded: boolean;
  /** Parsed isolated config at exit (null when unreadable). */
  readonly config: Record<string, unknown> | null;
  /** Path of the isolated config file the CLI was pointed at. */
  readonly configPath: string;
  /** The exec'd argv (bin, `--test`, `--config-dir`) — the production entrypoint shape. */
  readonly childCommand: readonly string[];
  /** The `script` invocation recorded by the fake-bin PTY shim. */
  readonly scriptCall: FakeBinCall | null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Spawn the production CLI (`bin/elanous.mjs --test --config-dir <temp>`) under a
 * util-linux `script -q -e -c` PTY, feed `answers` as each menu render appears, and
 * return what the production path actually did.
 */
export async function driveFirstRunMenu(
  options: FirstRunMenuDeviceOptions = {},
): Promise<FirstRunMenuObservation> {
  const support = firstRunPtySupport();
  if (!support.available) {
    throw new Error(`first-run device: no PTY stage on this host — ${support.reason ?? 'unknown reason'}`);
  }
  const answers = [...(options.answers ?? FIRST_RUN_MENU_ANSWERS)];
  const timeoutMs = options.timeoutMs ?? 45_000;
  const answerDelayMs = options.answerDelayMs ?? 300;

  const fakeBins = createFakeBins({ script: { pty: true } });
  const root = mkdtempSync(join(tmpdir(), 'onb-first-run-device-'));
  const home = join(root, 'home');
  const configDir = join(root, 'cfg');
  const configPath = join(configDir, 'config.json');
  try {
    mkdirSync(home, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      CODEX_HOME: join(home, '.codex'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      XDG_CONFIG_HOME: '',
      PATH: fakeBins.path(),
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      CI: '',
      TERM: 'xterm-256color',
    };
    delete env.ELANOUS_CONFIG_DIR;
    delete env.ELANOUS_STATE_DIR;
    // FIRST_RUN_SETUP_HINT and the :253 finalPhrase check are fixed Korean strings:
    // pin the locale so an en/C runner cannot null out the N08 measurement path.
    env.ELANOUS_LANG = 'ko';
    delete env.CLAUDE_CODE_SSE_PORT;
    // A bare machine has no provider: inherited credentials would change the board
    // (a usable key makes the run ready instead of landing on the setup hint).
    for (const key of [
      'ELANOUS_LLM_PROVIDER',
      'ELANOUS_ESCALATE_PROVIDER',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'XAI_API_KEY',
      'GROK_API_KEY',
      'GROK_CODE_XAI_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'OPENROUTER_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
      'LOCAL_LLM_URL',
    ]) {
      env[key] = '';
    }

    // Warm the bundle cache with a non-TTY call first: the cold compile alone can
    // outlast the PTY budget, and a timeout would read as a parser defect.
    spawnElanousSync(['--test', '--config-dir', configDir, '--version'], {
      cwd: repoRoot,
      env,
      stateDir: configDir,
      stdio: 'ignore',
      timeout: 180_000,
    });

    const childCommand = [process.execPath, cliEntry, '--test', '--config-dir', configDir];
    const childLine = childCommand.map(shellQuote).join(' ');
    const child = spawn('sh', ['-c', 'script -q -e -c "$1" /dev/null', 'sh', childLine], {
      cwd: repoRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // `script` only allocates a TTY when it is *not* started on one, so it is
      // deliberately spawned on pipes and the answers are written into its stdin.
    });

    let stdout = '';
    let stderr = '';
    let seen = 0;
    let keyPasteAnswered = false;
    const answersSent: string[] = [];
    let closed = false;
    let timedOut = false;

    const writeNext = (): void => {
      if (answersSent.length >= answers.length) return;
      const answer = answers[answersSent.length]!;
      answersSent.push(answer);
      child.stdin.write(`${answer}\n`);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const count = countFirstRunMenuRenders(stdout);
      while (seen < count) {
        seen += 1;
        setTimeout(() => {
          if (!closed) writeNext();
        }, answerDelayMs);
      }
      if (!keyPasteAnswered && stdout.includes('.env 형식 키를 붙여 넣고 빈 줄로 끝내세요')) {
        keyPasteAnswered = true;
        setTimeout(() => {
          if (!closed) child.stdin.write('\n');
        }, answerDelayMs);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const status = await new Promise<number | null>((done) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.on('close', (code) => {
        closed = true;
        clearTimeout(timer);
        done(code);
      });
      child.on('error', () => {
        closed = true;
        clearTimeout(timer);
        done(null);
      });
    });

    let config: Record<string, unknown> | null = null;
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      config = null;
    }
    const onboarding = config?.['onboarding'];
    const readyRecorded = typeof onboarding === 'object' && onboarding !== null
      && Object.prototype.hasOwnProperty.call(onboarding, 'ready');

    return {
      stdout,
      stderr,
      status,
      timedOut,
      menuRenderCount: Math.min(seen, countFirstRunMenuRenders(stdout)),
      answersSent,
      finalPhrase: stdout.includes(FIRST_RUN_SETUP_HINT) ? FIRST_RUN_SETUP_HINT : null,
      readyRecorded,
      config,
      configPath,
      childCommand,
      scriptCall: fakeBins.calls().find((call) => call.name === 'script') ?? null,
    };
  } finally {
    fakeBins.cleanup();
    if (options.keepRoot !== true) rmSync(root, { recursive: true, force: true });
  }
}
