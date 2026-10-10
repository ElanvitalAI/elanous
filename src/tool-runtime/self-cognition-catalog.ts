/** Canonical names for the read-only self-cognition surface. */
export const SELF_COGNITION_TOOL_NAMES = [
  'self_recall',
  'logs_query',
  'ops_status',
  'memory_recall',
  'context_now',
] as const;

/** MCP catalog metadata derived from the same name ledger as the runtimes. */
export const SELF_COGNITION_MCP_CATALOG_ENTRIES = SELF_COGNITION_TOOL_NAMES.map(name => ({
  id: name,
  kind: 'other',
  aliases: [name] as [typeof name],
  displayName: name,
  description: 'Read-only self-cognition query over elanous history, memory, operations, or logs.',
  promptSummary: `\`${name}\` (read-only self-cognition query)`,
  host: ['mcp'] as ['mcp'],
  safety: ['read-only'] as ['read-only'],
  supportsParallel: true,
  defaultEnabled: true,
  intentScope: 'ops-ui',
} as const));
