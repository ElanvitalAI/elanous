'use client';

import { useEffect, useState } from 'react';
import { defaultBaseUrl, loadDaemonConfig } from './daemon-config';
import { readOperator } from './operator-role';

/** Only an exact /v1/me operator:true response enables the operations menu. */
export function useOperator(): boolean {
  const [operator, setOperator] = useState(false);
  useEffect(() => {
    let current = true;
    let request = 0;
    const refresh = (event?: StorageEvent) => {
      if (event && event.key !== null && event.key !== 'elanous.nexus.baseUrl' && event.key !== 'elanous.daemon.baseUrl') return;
      const thisRequest = ++request;
      let baseUrl = '';
      try { baseUrl = loadDaemonConfig().baseUrl; } catch { /* Storage may be unavailable. */ }
      if (!baseUrl) {
        try { baseUrl = defaultBaseUrl(); } catch { /* Location may be unavailable. */ }
      }
      setOperator(false);
      if (!baseUrl) return;
      void readOperator(baseUrl).then((value) => {
        if (current && request === thisRequest) setOperator(value);
      });
    };
    refresh();
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('storage', refresh);
    return () => {
      current = false;
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('storage', refresh);
    };
  }, []);
  return operator;
}
