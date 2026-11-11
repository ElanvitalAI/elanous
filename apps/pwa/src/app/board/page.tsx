'use client';

import { useMemo } from 'react';
import { MemberMiniBoardScreen } from '@/components/member-board/MemberMiniBoardView';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import { createMemberMiniBoardApi } from '@/lib/member-mini-board-api';

export default function MemberBoardPage() {
  const nexus = useOptionalNexusClient();
  const api = useMemo(() => nexus ? createMemberMiniBoardApi(nexus.baseUrl) : null, [nexus]);
  return <MemberMiniBoardScreen api={api} />;
}
