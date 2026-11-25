export const FIRECRAWL_CREDENTIAL_SLOT = 'cred:firecrawl.api_key';
export const FIRECRAWL_LEGACY_SECRET = 'FIRECRAWL_API_KEY';

/** Legacy storage is read-only compatibility; a backend failure never selects another credential. */
export async function readStoredFirecrawlKey(get?: (id: string) => Promise<string | undefined>): Promise<string | undefined> {
  const read = get ?? (await import('../nexus/config/secrets/index.js')).getSecretAsync;
  return (await read(FIRECRAWL_CREDENTIAL_SLOT))?.trim() || (await read(FIRECRAWL_LEGACY_SECRET))?.trim() || undefined;
}

export interface FirecrawlKeySetupDeps {
  promptSecret: (message: string) => Promise<string | undefined>;
  print: (message: string) => void;
  setSecret?: (id: string, value: string) => Promise<void>;
}

/** No provider probe/charge, CLI dependency, plaintext config or key prefix output. */
export async function configureFirecrawlKey(deps: FirecrawlKeySetupDeps): Promise<'saved' | 'skipped' | 'failed'> {
  try {
    const key = (await deps.promptSecret('Optional Firecrawl API key for web search (Enter to skip; later: elanous setup firecrawl): '))?.trim();
    if (!key) { deps.print('Firecrawl skipped · set it any time with `elanous setup firecrawl`'); return 'skipped'; }
    if (/\s|[\u0000-\u001f\u007f]/.test(key)) { deps.print('The Firecrawl key format is not valid.'); return 'failed'; }
    const write = deps.setSecret ?? (await import('../nexus/config/secrets/cred-slots.js')).setCredentialSlotAsync;
    await write(FIRECRAWL_CREDENTIAL_SLOT, key);
    deps.print('Firecrawl key saved to the secret store.');
    return 'saved';
  } catch { deps.print('Could not save the Firecrawl key. Sensitive error details are hidden.'); return 'failed'; }
}
