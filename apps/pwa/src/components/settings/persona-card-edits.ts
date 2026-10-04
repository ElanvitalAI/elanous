import type { PersonaEdits, PersonaWireEntry } from '@/nexus/client';

export type PersonaDraft = Required<PersonaEdits>;

export function personaDraft(persona: PersonaWireEntry): PersonaDraft {
  return {
    displayName: persona.displayName,
    description: persona.description ?? '',
    systemPrompt: persona.systemPrompt ?? '',
  };
}

/** Only send fields changed by this row; omitted fields remain untouched on the server. */
export function changedPersonaEdits(persona: PersonaWireEntry, draft: PersonaDraft): PersonaEdits {
  const original = personaDraft(persona);
  const edits: PersonaEdits = {};
  if (draft.displayName !== original.displayName) edits.displayName = draft.displayName;
  if (draft.description !== original.description) edits.description = draft.description;
  if (draft.systemPrompt !== original.systemPrompt) edits.systemPrompt = draft.systemPrompt;
  return edits;
}
