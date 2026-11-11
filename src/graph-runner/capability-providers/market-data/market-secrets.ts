import { getSecretAsync, selectBackendFromConfig } from '../../../nexus/config/secrets/index.js';

/** The same secret-store resolver used by `eln secret`; tests inject a fixed lookup. */
export type MarketSecretLookup = (id: string) => Promise<string | undefined>;
export const marketSecretLookup: MarketSecretLookup = async (id) => {
  selectBackendFromConfig();
  return getSecretAsync(id);
};

export async function requiredMarketSecret(id: string, lookup: MarketSecretLookup): Promise<string> {
  const value = await lookup(id);
  if (!value?.trim()) throw new Error('key_required');
  return value;
}
