/** Canonical shared credential slots consumed by Nexus app actions. */
export const CREDENTIAL_SLOT_DEFINITIONS = [
  { service: 'openai', label: 'OpenAI', fields: ['api_key'], setupUrl: 'https://platform.openai.com/api-keys' },
  { service: 'elevenlabs', label: 'ElevenLabs', fields: ['api_key'], setupUrl: 'https://elevenlabs.io/app/settings/api-keys' },
  { service: 'higgsfield', label: 'Higgsfield', fields: ['key_id', 'secret'], setupUrl: 'https://console.higgsfield.ai/' },
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
