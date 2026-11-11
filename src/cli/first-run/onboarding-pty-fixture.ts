import { realIO } from '../../onboarding.js';
import { runFirstRun } from '../../onboarding/first-run.js';
import { buildUserConfig } from '../../user-config.js';
import { runFirstRunProviderSetup } from '../setup-keys.js';
import type { loginWithCodex } from '../../oauth/codex.js';

const [mode, path] = process.argv.slice(2);
if (!path || (mode !== 'codex' && mode !== 'openrouter' && mode !== 'interrupt')) throw new Error('mode and config path required');
const io = realIO();
try {
  if (mode === 'interrupt') {
    let interrupted = false;
    const unsubscribe = io.onInterrupt?.(() => { interrupted = true; io.print('INTERRUPT_CALLBACK'); });
    await io.askSecret?.('SECRET_FOR_INTERRUPT: ');
    await io.ask('AFTER_SECRET: ');
    io.print(`INTERRUPT_RESULT ${interrupted}`);
    unsubscribe?.();
    process.exit(0);
  }
  const env: NodeJS.ProcessEnv = { HOME: process.env.HOME };
  const result = await runFirstRun({
    path, config: buildUserConfig(path), env, isTTY: process.stdin.isTTY,
    detectProviders: async () => [], print: (line) => io.print(line),
    setupWhenNoProvider: (config) => runFirstRunProviderSetup(io, {
      config, env,
      loginWithCodex: (async () => undefined) as unknown as typeof loginWithCodex,
      verifier: async () => ({ success: true, verification: 'verified' }),
      saveCredentialSlotBatch: async () => {},
    }),
  });
  const saved = buildUserConfig(path);
  io.print(`PTY_RESULT ${JSON.stringify({ result, provider: saved.llm.provider, model: saved.llm.model,
    role: saved.roleLlm?.implement, ready: saved.onboarding.ready, isTTY: process.stdin.isTTY })}`);
} finally { io.close(); }
