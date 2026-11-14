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
    const key = (await deps.promptSecret('Firecrawl API key (Enter = 건너뛰기; 나중에 elanous setup firecrawl): '))?.trim();
    if (!key) { deps.print('Firecrawl 건너뜀 · elanous setup firecrawl 로 언제든 설정'); return 'skipped'; }
    if (/\s|[\u0000-\u001f\u007f]/.test(key)) { deps.print('Firecrawl 키 형식이 올바르지 않습니다.'); return 'failed'; }
    const write = deps.setSecret ?? (await import('../nexus/config/secrets/cred-slots.js')).setCredentialSlotAsync;
    await write(FIRECRAWL_CREDENTIAL_SLOT, key);
    deps.print('Firecrawl 키를 secret 저장소에 저장했습니다.');
    return 'saved';
  } catch { deps.print('Firecrawl 키를 저장하지 못했습니다. 민감한 오류는 숨겼습니다.'); return 'failed'; }
}
