import { createContextKeyService, type ContextKeyService, type ContextKeys } from './context-keys.js';

// Shared lazy singleton for context-key consumers outside the dashboard.
let service: ContextKeyService | null = null;

export function getRuntimeContextKeyService(): ContextKeyService {
  if (!service) service = createContextKeyService();
  return service;
}

export function getRuntimeContextKeys(): Readonly<ContextKeys> {
  return getRuntimeContextKeyService().keys;
}

export function updateRuntimeContextKeys(patch: Partial<ContextKeys>): void {
  getRuntimeContextKeyService().update(patch);
}

export function resetRuntimeContextKeysForTests(): void {
  service = null;
}
