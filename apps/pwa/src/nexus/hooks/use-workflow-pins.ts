'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNexusClient } from './use-nexus-context';

const pinsKey = (name: string) => ['nexus', 'workflow-pins', name] as const;

export function useWorkflowPins(name: string) {
  const client = useNexusClient();
  return useQuery({
    queryKey: pinsKey(name),
    queryFn: () => client.getWorkflowPins(name),
    enabled: name.length > 0,
  });
}

export function usePutWorkflowPin() {
  const client = useNexusClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, nodeId, value, note }: { name: string; nodeId: string; value: unknown; note?: string }) =>
      client.putWorkflowPin(name, nodeId, value, note),
    onSuccess: (_data, { name }) => qc.invalidateQueries({ queryKey: pinsKey(name) }),
  });
}

export function useDeleteWorkflowPin() {
  const client = useNexusClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, nodeId }: { name: string; nodeId: string }) => client.deleteWorkflowPin(name, nodeId),
    onSuccess: (_data, { name }) => qc.invalidateQueries({ queryKey: pinsKey(name) }),
  });
}
