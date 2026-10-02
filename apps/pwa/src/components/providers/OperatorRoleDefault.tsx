'use client';

import { useEffect } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { applyOperatorDefaultRole } from '@/lib/operator-role';

/** 운영자 데몬(`/v1/me` operator:true)이면 역할을 안 고른 이 기기를 오너로 — 화면은 그리지 않는다. */
export function OperatorRoleDefault(): null {
  const { config } = useDaemon();
  const baseUrl = config.baseUrl;
  useEffect(() => {
    if (typeof window === 'undefined') return;
    void applyOperatorDefaultRole({ baseUrl, storage: window.localStorage });
  }, [baseUrl]);
  return null;
}
