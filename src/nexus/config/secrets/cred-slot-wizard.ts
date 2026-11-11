import { SERVICE_KEY_CATALOG } from '../../../setup/service-key-catalog.js';
import { CREDENTIAL_SLOT_DEFINITIONS, parseCredentialSlotId } from './cred-slot-schema.js';

export interface CredentialSlotWizardPlan {
  readonly service: string;
  readonly slots: readonly string[];
}

/** Resolve a catalog service to its typed shared slots; explicit catalog names bound market-data scope. */
export function credentialSlotWizardPlan(service: string): CredentialSlotWizardPlan | undefined {
  const entry = SERVICE_KEY_CATALOG.find((item) => item.id === service && item.kind === 'api-key');
  const definition = CREDENTIAL_SLOT_DEFINITIONS.find((item) => item.service === service);
  if (!entry || !definition || !entry.storeIds?.length) return undefined;
  const slots = [...entry.storeIds];
  if (new Set(slots).size !== slots.length ||
    !slots.every((slot) => parseCredentialSlotId(slot)?.service === service)) return undefined;
  return { service, slots };
}

/** All prompts finish before the canonical batch writer receives any value. The result contains names only. */
export async function runCredentialSlotWizard(plan: CredentialSlotWizardPlan, deps: {
  prompt: (slot: string) => Promise<string | undefined>;
  saveBatch: (values: Readonly<Record<string, string>>) => Promise<void>;
}): Promise<{ service: string; slots: readonly string[] }> {
  const canonical = credentialSlotWizardPlan(plan.service);
  if (!canonical || JSON.stringify(plan.slots) !== JSON.stringify(canonical.slots))
    throw new Error('credential slot setup unsupported');
  const values: Record<string, string> = {};
  for (const slot of canonical.slots) {
    let value: string | undefined;
    try { value = await deps.prompt(slot); } catch { throw new Error('credential slot input cancelled or invalid'); }
    if (!value?.trim() || value.includes('\0')) throw new Error('credential slot input cancelled or invalid');
    values[slot] = value;
  }
  try { await deps.saveBatch(values); } catch { throw new Error('credential slot setup failed'); }
  return { service: canonical.service, slots: canonical.slots };
}
