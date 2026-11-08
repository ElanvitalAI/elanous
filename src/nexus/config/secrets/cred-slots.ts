import { currentBackend, removeCredentialSlotValue, writeCredentialSlotBatchValue, writeCredentialSlotValue } from './registry.js';
import { assertCredentialSlotId, CREDENTIAL_SLOT_DEFINITIONS, type CredentialSlotId } from './cred-slot-schema.js';
export { assertCredentialSlotId, CREDENTIAL_SLOT_DEFINITIONS, parseCredentialSlotId, type CredentialSlotId } from './cred-slot-schema.js';

export interface CredentialSlotStatus {
  id: CredentialSlotId;
  service: string;
  label: string;
  field: string;
  setupUrl: string;
  present: boolean;
}

/** Credentials are looked up just in time; consumers receive only this call's value. */
/** The only typed write path for shared credential slots. */
export async function setCredentialSlotAsync(id: string, value: string): Promise<void> {
  assertCredentialSlotId(id);
  if (!value.trim() || value.includes('\0')) throw new Error('ELANOUS_CREDENTIAL_SLOT_VALUE_INVALID');
  await writeCredentialSlotValue(id, value);
}

/** Store every field of a multi-part credential in one file mutation. */
export async function setCredentialSlotBatchAsync(values: Readonly<Record<string, string>>): Promise<void> {
  const entries = Object.entries(values);
  if (entries.length === 0) throw new Error('ELANOUS_CREDENTIAL_SLOT_BATCH_INVALID');
  for (const [id, value] of entries) {
    assertCredentialSlotId(id);
    if (!value.trim() || value.includes('\0')) throw new Error('ELANOUS_CREDENTIAL_SLOT_VALUE_INVALID');
  }
  writeCredentialSlotBatchValue(values);
}

export async function deleteCredentialSlotAsync(id: string): Promise<boolean> {
  assertCredentialSlotId(id);
  return removeCredentialSlotValue(id);
}

/** Slot inventory is metadata only: this never reads or returns secret values. */
export async function listCredentialSlotsAsync(): Promise<CredentialSlotStatus[]> {
  const backend = currentBackend();
  const storedIds = new Set(await backend.list());
  return CREDENTIAL_SLOT_DEFINITIONS.flatMap((definition) => definition.fields.map((field) => {
    const id = `cred:${definition.service}.${field}` as CredentialSlotId;
    return {
      id,
      service: definition.service,
      label: definition.label,
      field,
      setupUrl: definition.setupUrl,
      present: storedIds.has(id),
    };
  }));
}
