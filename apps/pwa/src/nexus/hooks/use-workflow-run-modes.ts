'use client';

import { useQuery } from '@tanstack/react-query';
import { useNexusClient } from './use-nexus-context';

export function useWorkflowRunModes() {
  const client = useNexusClient();
  const query = useQuery({
    queryKey: ['nexus', 'workflow-run-modes'],
    queryFn: async () => {
      const health = await client.getHealth();
      return (health as typeof health & { workflowRunModes?: unknown }).workflowRunModes === true;
    },
    staleTime: Infinity,
    retry: false,
  });
  return query.data === true;
}
