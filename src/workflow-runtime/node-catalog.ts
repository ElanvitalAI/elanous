// M4-5 (2026-05-12 · Phase 4 N5-5) — workflow node catalog.
//
// Single source of truth for the 20 workflow-runtime node kinds.
// CLI (`elanous wf node search/spec/list`) + PWA NodeCreator + external
// LLM (R3 NL synth · M4-1 node suggestion) all read this catalog.
//
// F6 default (ROADMAP §2 · 2026-05-12) — catalog data lives in this
// TypeScript module (next to the type defs in `types.ts`) so adding
// a new node kind = edit two files (types + catalog) reviewed
// together. Auto-generation from JSDoc is a v2 option; the data is
// concise enough that maintenance overhead is negligible (~15 LOC
// per node kind).

export type NodeCategory =
  | 'core'         // prompt · bash · skill · cft
  | 'hitl'         // approval
  | 'branch'       // if · switch
  | 'iteration'    // iteration
  | 'transform'    // classify · extract · set · filter · template
  | 'integration'  // http · task
  | 'trigger';     // scheduleTrigger · webhookTrigger · discordTrigger · telegramTrigger · manualTrigger · chatTrigger

export interface NodeSpec {
  /** Stable identifier (snake-case in the YAML key when relevant). */
  kind: string;
  category: NodeCategory;
  /** One-line description (≤ 80 chars). */
  summary: string;
  /** YAML field name distinguishing this variant from other nodes. */
  yamlKey: string;
  /** Required fields under the yamlKey block (besides node-level `id`). */
  required: string[];
  /** Optional fields under the yamlKey block (besides node-level
   *  `depends_on` / `when` / `model` / `provider` / `idle_timeout` /
   *  `allowed_tools` / `denied_tools` / `output_format` / `requires`,
   *  which apply to all variants). */
  optional: string[];
  /** Self-contained YAML snippet (just the node — caller adds it under
   *  `workflow.nodes`). */
  example: string;
  /** Related node kinds (for "Did you mean ..." UX). */
  related?: string[];
}

export const NODE_CATALOG: readonly NodeSpec[] = [
  // ── core ────────────────────────────────────────────────────────
  {
    kind: 'prompt',
    category: 'core',
    summary: 'LLM prompt call · output = response text (or parsed JSON via output_format)',
    yamlKey: 'prompt',
    required: [],
    optional: [],
    example: `- id: summarize
  prompt: |
    $ARGUMENTS 의 핵심 3가지를 bullet 로 정리.`,
    related: ['classify', 'extract', 'template'],
  },
  {
    kind: 'bash',
    category: 'core',
    summary: 'Shell command · output = stdout (trimmed)',
    yamlKey: 'bash',
    required: [],
    optional: [],
    example: `- id: hello
  bash: |
    echo "hello $ARGUMENTS"`,
    related: ['skill'],
  },
  {
    kind: 'skill',
    category: 'core',
    summary: 'Invoke a registered skill by slug · output = skill display',
    yamlKey: 'skill',
    required: [],
    optional: ['arguments'],
    example: `- id: web
  skill: omni-crawl
  arguments: "monad-agent github"`,
    related: ['cft'],
  },
  {
    kind: 'cft',
    category: 'core',
    summary: 'Call a CFT (capability function tool) method · output = method return',
    yamlKey: 'cft',
    required: [],
    optional: ['config'],
    example: `- id: notify
  cft: send-pushcut
  config:
    title: "Workflow done"`,
    related: ['skill'],
  },

  // ── hitl ────────────────────────────────────────────────────────
  {
    kind: 'approval',
    category: 'hitl',
    summary: 'Human-in-the-loop approval gate · races configured channels (PWA · Telegram · Discord · Pushcut · terminal)',
    yamlKey: 'approval',
    required: ['message'],
    optional: ['capture_response', 'delivery'],
    example: `- id: confirm
  approval:
    message: "Deploy to production?"
    delivery: pushcut`,
  },

  // ── branch ──────────────────────────────────────────────────────
  {
    kind: 'if',
    category: 'branch',
    summary: "Boolean branch · output = 'then' or 'else' string (downstream nodes branch via when)",
    yamlKey: 'if',
    required: ['condition'],
    optional: [],
    example: `- id: route
  if:
    condition: $score.output == 'high'`,
    related: ['switch'],
  },
  {
    kind: 'switch',
    category: 'branch',
    summary: 'N-way branch · output = matched case string (or "default")',
    yamlKey: 'switch',
    required: ['value', 'cases'],
    optional: [],
    example: `- id: route
  switch:
    value: $kind.output
    cases: [bug, feature, chore]`,
    related: ['if'],
  },

  // ── iteration ───────────────────────────────────────────────────
  {
    kind: 'iteration',
    category: 'iteration',
    summary: 'Sequential bash iteration over an array · output = array of per-item stdout',
    yamlKey: 'iteration',
    required: ['items', 'body'],
    optional: [],
    example: `- id: each
  iteration:
    items: $list.output
    body: |
      echo "item $index = $item"`,
    related: ['filter'],
  },

  // ── transform ───────────────────────────────────────────────────
  {
    kind: 'classify',
    category: 'transform',
    summary: 'LLM classifier · picks one of the provided classes',
    yamlKey: 'classify',
    required: ['input', 'classes'],
    optional: ['hint', 'retries', 'retryDelayMs'],
    example: `- id: pick
  classify:
    input: $ARGUMENTS
    classes: [music, sports, news]`,
    related: ['extract', 'prompt'],
  },
  {
    kind: 'extract',
    category: 'transform',
    summary: 'LLM structured extraction · output = JSON object matching schema',
    yamlKey: 'extract',
    required: ['input', 'schema'],
    optional: ['hint', 'retries', 'retryDelayMs'],
    example: `- id: pull
  extract:
    input: $ARGUMENTS
    schema:
      title: short headline
      score: 0-100 importance`,
    related: ['classify', 'prompt'],
  },
  {
    kind: 'set',
    category: 'transform',
    summary: 'Build a JSON record from interpolated field values',
    yamlKey: 'set',
    required: ['fields'],
    optional: [],
    example: `- id: record
  set:
    fields:
      title: $extract.output.title
      ts: "$ARGUMENTS"`,
    related: ['template'],
  },
  {
    kind: 'filter',
    category: 'transform',
    summary: 'Array filter · keeps elements where condition is truthy',
    yamlKey: 'filter',
    required: ['items', 'condition'],
    optional: [],
    example: `- id: keep
  filter:
    items: $list.output
    condition: $item != 'skip'`,
    related: ['iteration'],
  },
  {
    kind: 'knowledge',
    category: 'transform',
    summary: '볼트 검색 · 찾은 조각을 다음 노드에',
    yamlKey: 'knowledge',
    required: ['query'],
    optional: ['limit'],
    example: `- id: notes
  knowledge:
    query: $ARGUMENTS
    limit: 3`,
    related: ['prompt'],
  },
  {
    kind: 'template',
    category: 'transform',
    summary: 'Handlebars-lite text template · {{ <id>.output }} substitution',
    yamlKey: 'template',
    required: ['template'],
    optional: [],
    example: `- id: render
  template:
    template: |
      Hi {{ user.output.name }}, your score is {{ score.output }}.`,
    related: ['set'],
  },

  // ── integration ─────────────────────────────────────────────────
  {
    kind: 'http',
    category: 'integration',
    summary: 'HTTP request · output = parsed JSON (when content-type=json) or raw text',
    yamlKey: 'http',
    required: ['method', 'url'],
    optional: ['headers', 'body', 'auth', 'timeout'],
    example: `- id: ping
  http:
    method: GET
    url: https://api.example.com/health
    timeout: 5000`,
  },
  {
    kind: 'task',
    category: 'integration',
    summary: 'Create a TOX task with its external origin · waits for approval unless autoRun matches',
    yamlKey: 'task',
    required: ['title', 'external'],
    optional: ['description', 'priority', 'eventId'],
    example: `- id: file
  depends_on: [hook]
  task:
    title: $hook.output.body.data.title
    priority: high
    eventId: $hook.output.body.webhookId
    external:
      provider: linear
      ref: $hook.output.body.data.identifier
      url: $hook.output.body.data.url`,
    related: ['http'],
  },

  // ── trigger ─────────────────────────────────────────────────────
  {
    kind: 'scheduleTrigger',
    category: 'trigger',
    summary: 'Time-based trigger · cron expression or interval (ms)',
    yamlKey: 'scheduleTrigger',
    required: ['type'],
    optional: ['cron', 'interval', 'timezone', 'jitter_seconds', 'max_runs', 'enabled'],
    example: `- id: cron
  scheduleTrigger:
    type: cron
    cron: "0 9 * * *"
    timezone: Asia/Seoul`,
    related: ['webhookTrigger', 'manualTrigger'],
  },
  {
    kind: 'webhookTrigger',
    category: 'trigger',
    summary: 'HTTP webhook trigger · POST/GET/PUT/PATCH/DELETE under /v1/workflows/webhooks/*',
    yamlKey: 'webhookTrigger',
    required: ['method', 'path'],
    optional: ['auth'],
    example: `- id: webhook
  webhookTrigger:
    method: POST
    path: /incident
    auth:
      type: bearer
      token: secret`,
    related: ['chatTrigger', 'scheduleTrigger'],
  },
  {
    kind: 'discordTrigger',
    category: 'trigger',
    summary: 'Discord message/mention/reaction trigger (V2.2-3 · in-process bot)',
    yamlKey: 'discordTrigger',
    required: ['kind'],
    optional: ['channel', 'user', 'pattern'],
    example: `- id: dc
  discordTrigger:
    kind: message
    pattern: "^!run-build"`,
    related: ['telegramTrigger', 'chatTrigger'],
  },
  {
    kind: 'telegramTrigger',
    category: 'trigger',
    summary: 'Telegram message/command/callback trigger (V2.2-4 · in-process bot)',
    yamlKey: 'telegramTrigger',
    required: ['kind'],
    optional: ['chat', 'user', 'command', 'pattern'],
    example: `- id: tg
  telegramTrigger:
    kind: command
    command: summary`,
    related: ['discordTrigger', 'chatTrigger'],
  },
  {
    kind: 'manualTrigger',
    category: 'trigger',
    summary: 'Manual entry point · workflow runs only when explicitly invoked (CLI / "Run now")',
    yamlKey: 'manualTrigger',
    required: [],
    optional: ['description'],
    example: `- id: in
  manualTrigger:
    description: "Run from PWA workflows page"`,
    related: ['scheduleTrigger'],
  },
  {
    kind: 'chatTrigger',
    category: 'trigger',
    summary: 'Chat HTTP trigger · POST /v1/workflows/chat<path> · optional streaming + hosted UI (V2.2-1 · V2.2-2)',
    yamlKey: 'chatTrigger',
    required: ['path'],
    optional: ['auth', 'sessionMode', 'streaming', 'hostedUi'],
    example: `- id: chat
  chatTrigger:
    path: /research-bot
    streaming: true
    hostedUi:
      enabled: true
      bearer: share-secret`,
    related: ['webhookTrigger', 'discordTrigger'],
  },
] as const;

/** Look up a node spec by kind. Case-insensitive. */
export function getNodeSpec(kind: string): NodeSpec | undefined {
  const lower = kind.trim().toLowerCase();
  return NODE_CATALOG.find(s => s.kind.toLowerCase() === lower);
}

export interface NodeSearchResult {
  spec: NodeSpec;
  score: number;
  matched: 'kind' | 'summary' | 'related';
}

/** Search the catalog by free-text query. Ranks: exact kind > kind
 *  substring > summary substring > related-kinds substring. Case-
 *  insensitive. Empty / whitespace query returns []. */
export function searchNodes(query: string, opts: { category?: NodeCategory } = {}): NodeSearchResult[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const results: NodeSearchResult[] = [];
  for (const spec of NODE_CATALOG) {
    if (opts.category && spec.category !== opts.category) continue;
    const kindLower = spec.kind.toLowerCase();
    if (kindLower === q) {
      results.push({ spec, score: 100, matched: 'kind' });
      continue;
    }
    if (kindLower.includes(q)) {
      results.push({ spec, score: 80, matched: 'kind' });
      continue;
    }
    if (spec.summary.toLowerCase().includes(q)) {
      results.push({ spec, score: 50, matched: 'summary' });
      continue;
    }
    if (spec.related?.some(r => r.toLowerCase().includes(q))) {
      results.push({ spec, score: 30, matched: 'related' });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

/** Render a single node spec as human-readable markdown. */
export function renderNodeSpec(spec: NodeSpec): string {
  const lines: string[] = [];
  lines.push(`# ${spec.kind}`);
  lines.push('');
  lines.push(`**Category**: ${spec.category}`);
  lines.push('');
  lines.push(spec.summary);
  lines.push('');
  lines.push(`**YAML key**: \`${spec.yamlKey}\``);
  lines.push('');
  if (spec.required.length > 0) {
    lines.push('**Required fields**:');
    for (const f of spec.required) lines.push(`- \`${f}\``);
    lines.push('');
  }
  if (spec.optional.length > 0) {
    lines.push('**Optional fields**:');
    for (const f of spec.optional) lines.push(`- \`${f}\``);
    lines.push('');
  }
  lines.push('**Example**:');
  lines.push('');
  lines.push('```yaml');
  lines.push(spec.example);
  lines.push('```');
  if (spec.related && spec.related.length > 0) {
    lines.push('');
    lines.push(`**Related**: ${spec.related.map(r => `\`${r}\``).join(' · ')}`);
  }
  return lines.join('\n');
}

/** Render a compact catalog listing (`elanous wf node list` output). */
export function renderCatalogList(opts: { category?: NodeCategory } = {}): string {
  const lines: string[] = [];
  const byCategory = new Map<NodeCategory, NodeSpec[]>();
  for (const spec of NODE_CATALOG) {
    if (opts.category && spec.category !== opts.category) continue;
    const bucket = byCategory.get(spec.category) ?? [];
    bucket.push(spec);
    byCategory.set(spec.category, bucket);
  }
  const order: NodeCategory[] = ['trigger', 'core', 'branch', 'iteration', 'transform', 'integration', 'hitl'];
  for (const cat of order) {
    const bucket = byCategory.get(cat);
    if (!bucket || bucket.length === 0) continue;
    lines.push(`## ${cat}`);
    lines.push('');
    const pad = Math.max(...bucket.map(s => s.kind.length));
    for (const spec of bucket) {
      lines.push(`  ${spec.kind.padEnd(pad)}  ${spec.summary}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
