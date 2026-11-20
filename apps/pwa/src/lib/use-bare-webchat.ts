'use client';

import { useSyncExternalStore } from 'react';
import { isBareWebChatOrigin } from './daemon-config';

const subscribe = (): (() => void) => () => {};

/** Server-delivered bare-origin flag as React state. The static build has no meta tag, so the server snapshot is
 * false (hydration-safe); the client snapshot reads the meta the Nexus injected into the served HTML. */
export function useIsBareWebChat(): boolean {
  return useSyncExternalStore(subscribe, () => isBareWebChatOrigin(), () => false);
}
