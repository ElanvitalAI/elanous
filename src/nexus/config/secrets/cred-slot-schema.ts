/** Canonical shared credential slots consumed by Nexus app actions. */
export const CREDENTIAL_SLOT_DEFINITIONS = [
  { service: 'firecrawl', label: 'Firecrawl', fields: ['api_key'], setupUrl: 'https://www.firecrawl.dev/app/api-keys' },
  { service: 'exa', label: 'Exa', fields: ['api_key'], setupUrl: 'https://dashboard.exa.ai/' },
  { service: 'brave', label: 'Brave Search', fields: ['api_key'], setupUrl: 'https://api-dashboard.search.brave.com/' },
  { service: 'openai', label: 'OpenAI', fields: ['api_key'], setupUrl: 'https://platform.openai.com/api-keys' },
  { service: 'openrouter', label: 'OpenRouter', fields: ['api_key'], setupUrl: 'https://openrouter.ai/keys' },
  { service: 'upstage', label: 'Upstage', fields: ['api_key'], setupUrl: 'https://console.upstage.ai/api-keys' },
  { service: 'elevenlabs', label: 'ElevenLabs', fields: ['api_key'], setupUrl: 'https://elevenlabs.io/app/settings/api-keys' },
  { service: 'higgsfield', label: 'Higgsfield', fields: ['key_id', 'secret'], setupUrl: 'https://console.higgsfield.ai/' },
  { service: 'eodhd', label: 'EODHD', fields: ['api_key'], setupUrl: 'https://eodhd.com/register' },
  { service: 'toss', label: 'Toss Securities', fields: ['client_id', 'client_secret', 'account_seq', 'base_url'], setupUrl: 'https://developers.tossinvest.com/docs' },
  { service: 'twelvedata', label: 'Twelve Data', fields: ['api_key'], setupUrl: 'https://twelvedata.com/' },
  { service: 'fds', label: 'Financial Datasets', fields: ['api_key'], setupUrl: 'https://docs.financialdatasets.ai/' },
  { service: 'krx', label: 'KRX Data Marketplace', fields: ['api_key'], setupUrl: 'https://openapi.krx.co.kr/' },
  { service: 'kis', label: 'Korea Investment & Securities', fields: ['app_key', 'app_secret', 'account'], setupUrl: 'https://apiportal.koreainvestment.com/' },
  { service: 'finnhub', label: 'Finnhub', fields: ['api_key'], setupUrl: 'https://finnhub.io/register' },
] as const;

export type CredentialSlotId = `cred:${string}.${string}`;
const definitionFor = (service: string, field: string) => CREDENTIAL_SLOT_DEFINITIONS.find(
  (definition) => definition.service === service && (definition.fields as readonly string[]).includes(field),
);
export function parseCredentialSlotId(id: string): { service: string; field: string } | undefined {
  const match = /^cred:([a-z0-9][a-z0-9-]*)\.([a-zA-Z][a-zA-Z0-9_-]*)$/.exec(id);
  if (!match || !definitionFor(match[1]!, match[2]!)) return undefined;
  return { service: match[1]!, field: match[2]! };
}
export function assertCredentialSlotId(id: string): asserts id is CredentialSlotId {
  if (!parseCredentialSlotId(id)) throw new Error('ELANOUS_CREDENTIAL_SLOT_UNSUPPORTED');
}

/**
 * Rotating login material (OAuth access/refresh tokens, sessions) stays with its single owner host and is
 * never carried by an export/import bundle — 대표 11-16 cred-push decision. Every catalogued slot above is a
 * static API key, so the transferable allowlist is exactly the catalogued slots, and these patterns are an
 * explicit second fence in case a login slot is ever added to the schema by mistake.
 */
const ROTATING_LOGIN_SLOT_PATTERN = /^cred:(?:codex|claude|anthropic|chatgpt|grok)(?:[-.]|$)|oauth|refresh|session|login/i;

/** Classifies a `cred:` ID for encrypted bundle transfer without reading any value. */
export function credentialSlotTransferClass(id: string): 'static' | 'rotating-login' | 'unsupported' {
  if (ROTATING_LOGIN_SLOT_PATTERN.test(id)) return 'rotating-login';
  return parseCredentialSlotId(id) ? 'static' : 'unsupported';
}

export function assertTransferableStaticCredentialSlotId(id: string): asserts id is CredentialSlotId {
  const transferClass = credentialSlotTransferClass(id);
  if (transferClass === 'rotating-login') throw new Error('ELANOUS_CREDENTIAL_SLOT_ROTATING_LOGIN_NOT_TRANSFERABLE');
  if (transferClass !== 'static') throw new Error('ELANOUS_CREDENTIAL_SLOT_IMPORT_UNSUPPORTED');
}
