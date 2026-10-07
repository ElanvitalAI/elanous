import { debug } from '../debug/log.js';
import { needsFirstRun, needsOnboarding } from '../onboarding.js';
import type { UserConfig } from '../user-config.js';
import type { FirstRunDeps, runFirstRun } from './first-run.js';
import { UNATTENDED_SETUP_COMMAND } from './entry-hints.js';

export interface FirstChatGateDeps {
  isTTY: boolean;
  runFirstRun: (deps: FirstRunDeps) => ReturnType<typeof runFirstRun>;
  runInteractive: () => Promise<boolean>;
  print: (line: string) => void;
}

export async function firstChatGate(cfg: UserConfig, deps: FirstChatGateDeps): Promise<'continue' | 'stop'> {
  const decide = (decision: 'continue' | 'stop', outcome: string): 'continue' | 'stop' => {
    debug.log('onboarding.first-chat', decision, { isTTY: deps.isTTY, outcome });
    return decision;
  };
  if (!needsOnboarding(cfg)) return decide('continue', 'completed');
  if (deps.isTTY) {
    return decide(await deps.runInteractive() ? 'continue' : 'stop', 'interactive');
  }
  if (!needsFirstRun(cfg)) return decide('continue', 'already-ready');
  const result = await deps.runFirstRun({ config: cfg, isTTY: false, print: () => {} });
  if (result.outcome === 'ready') return decide('continue', result.outcome);
  deps.print(`다음: elanous setup llm (또는 ${UNATTENDED_SETUP_COMMAND})`);
  process.exitCode = 2;
  return decide('stop', result.outcome);
}
