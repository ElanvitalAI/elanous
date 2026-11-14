// Legacy nexus setup-firecrawl entry. New onboarding uses elanous setup firecrawl.
// CLI detection is only informational for model discovery; built-in website crawling needs no CLI.
// Persist new keys in the secret store, reuse legacy config/env reads, and never render a key prefix.
// The legacy inline option is retained for compatibility; prefer the masked setup command.

import { isFirecrawlCliAvailable } from '../registry/discovery/sources/firecrawl-crawl.js';
import { askValidated } from '../onboarding/validators.js';
import { defaultIO, type WizardIO } from '../onboarding.js';
import { getFirecrawlConfig } from '../registry/discovery/config.js';
import { FIRECRAWL_CREDENTIAL_SLOT, readStoredFirecrawlKey } from '../setup/firecrawl-key.js';
import { setCredentialSlotAsync } from '../nexus/config/secrets/cred-slots.js';

export interface FirecrawlSetupDeps {
  io?: WizardIO;
  /** Skip the interactive prompt; persist this key directly. Useful
   *  for CI / scripted runs (`--api-key <value>` flag). When set the
   *  CLI binary check still runs but produces a hint only — the key
   *  is persisted regardless because the user may be pre-loading
   *  config before installing the CLI. */
  apiKeyInline?: string;
  /** Test seam — replace the CLI probe. Production reads
   *  `isFirecrawlCliAvailable()`. */
  cliProbeFn?: () => boolean | Promise<boolean>;
  /** Test seam — replace the secret-store writer. */
  patchFn?: (apiKey: string) => void | Promise<void>;
  /** Test seam — replace getFirecrawlConfig reader for the existing-
   *  key reuse hint. */
  readExistingFn?: () => { apiKey: string } | Promise<{ apiKey: string }>;
  out?: { log: (s: string) => void; error: (s: string) => void };
}

export interface FirecrawlSetupResult {
  exitCode: number;
  /** True when the wizard wrote an API key to the secret store. */
  keyWritten: boolean;
  /** True when the CLI binary was detected. False = wizard surfaced
   *  the install hint; key may still have been written. */
  cliPresent: boolean;
}

function validateApiKey(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Empty value — paste the key or press Ctrl-C to abort.';
  // Firecrawl keys are typically 30+ characters. Defensive lower
  // bound — catches obvious typos / partial pastes.
  if (trimmed.length < 12) return 'Key looks too short — verify from app.firecrawl.dev → API Keys.';
  return null;
}

const defaultPatchFn = async (apiKey: string): Promise<void> => {
  await setCredentialSlotAsync(FIRECRAWL_CREDENTIAL_SLOT, apiKey);
};

export async function runFirecrawlSetup(opts: FirecrawlSetupDeps = {}): Promise<FirecrawlSetupResult> {
  const ownIo = opts.io === undefined;
  const io = opts.io ?? defaultIO();
  const out = opts.out ?? console;
  const cliProbe = opts.cliProbeFn ?? isFirecrawlCliAvailable;
  const patchFn = opts.patchFn ?? defaultPatchFn;
  const readExisting = opts.readExistingFn ?? (async () => ({ apiKey: (await readStoredFirecrawlKey()) || getFirecrawlConfig().apiKey }));

  try {
    io.print('');
    io.print('  Firecrawl setup (legacy entry; prefer elanous setup firecrawl)');
    io.print('');

    // Step 1 — CLI binary detection (informational; doesn't gate the key).
    const cliPresent = await cliProbe();
    if (cliPresent) {
      io.print('  ✓ Firecrawl CLI detected on PATH.');
    } else {
      io.print('  ⚠ Firecrawl CLI not found on PATH.');
      io.print('    Install (after registering at https://www.firecrawl.dev):');
      io.print('      npm install -g firecrawl-cli');
      io.print('    Built-in website crawling needs no CLI. Discovery activates once');
      io.print('    the CLI binary is on PATH.');
    }
    io.print('');

    // Step 2 — collect / reuse the key.
    let apiKey = (opts.apiKeyInline ?? '').trim();
    if (!apiKey) {
      if (!io.askSecret || io.nonInteractive) {
        out.error('Use elanous setup firecrawl from an interactive terminal.');
        return { exitCode: 1, keyWritten: false, cliPresent };
      }
      const existing = (await readExisting()).apiKey;
      if (existing) {
        io.print('  Found existing key. Press Enter to keep,');
        io.print('  or paste a new key to replace.');
      } else {
        io.print('  Paste the API key from https://app.firecrawl.dev → API Keys.');
      }
      const prompt = existing ? '  API key (Enter = keep existing): ' : '  API key: ';
      const entered = (await askValidated(
        io,
        prompt,
        (raw: string): string | null => {
          if (raw.trim().length === 0 && existing) return null; // allow keep-existing
          return validateApiKey(raw);
        },
        { secret: true, maxAttempts: 3 },
      )).trim();
      apiKey = entered.length > 0 ? entered : existing;
    }

    if (!apiKey) {
      out.error('firecrawl setup: no key provided.');
      return { exitCode: 1, keyWritten: false, cliPresent };
    }

    // Step 3 — persist.
    await patchFn(apiKey);
    out.log('✓ Firecrawl API key saved to secret store.');
    out.log('  Used by: website crawl tool · model discovery');
    if (cliPresent) {
      out.log('  Discovery will pick up the new key on the next /v1/registry/discovery call.');
    } else {
      out.log('  Install the firecrawl CLI to activate discovery.');
    }
    return { exitCode: 0, keyWritten: true, cliPresent };
  } catch (err) {
    out.error('firecrawl setup failed; sensitive error details hidden.');
    return { exitCode: 1, keyWritten: false, cliPresent: false };
  } finally {
    if (ownIo) io.close();
  }
}
