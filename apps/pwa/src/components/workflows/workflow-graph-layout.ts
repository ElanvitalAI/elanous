// Archon-port T2B (2026-05-08) — pure YAML→graph layout for the
// /workflows visual builder Phase 1 (read-only).
//
// Splits the work into two pieces so ReactFlow rendering stays a thin
// shell and the heavy lifting is unit-testable:
//   1. `buildGraphFromDefinition` — workflow definition → node/edge
//      objects + variant classification (matches the 5 builtin node
//      kinds: prompt | bash | skill | cft | approval).
//   2. `layoutGraph`              — runs dagre to assign x/y
//      coordinates so ReactFlow can render top-down without the user
//      having to drag every node into place.

import dagre from '@dagrejs/dagre';
import { previewTriggerCard } from './triggers/trigger-card-preview';

/** Workflow definition shape we accept. Mirrors the parsed schema
 *  served by `GET /v1/workflows/:name` (apps/pwa/src/nexus/client.ts
 *  WorkflowDetail.definition) but is permissive enough that we can
 *  also hand-feed validation output (`ValidateWorkflowResponse.
 *  validation.workflow`). */
export interface WorkflowDefinitionLike {
  name: string;
  description?: string;
  nodes: Array<{
    id: string;
    depends_on?: string[];
    when?: string;
    trigger_rule?: string;
    [variantKey: string]: unknown;
  }>;
  [topKey: string]: unknown;
}

export type NodeVariant = 'prompt' | 'bash' | 'skill' | 'cft' | 'approval' | 'if' | 'switch' | 'iteration' | 'classify' | 'extract' | 'set' | 'filter' | 'template' | 'http' | 'scheduleTrigger' | 'webhookTrigger' | 'discordTrigger' | 'telegramTrigger' | 'manualTrigger' | 'chatTrigger' | 'unknown';

/** Identify which of the 5 known node variants a node is by checking
 *  the variant-discriminating field. Order matters — `cft` and
 *  `approval` go before `skill` because both have additional siblings
 *  but a unique presence key. */
export function classifyNodeVariant(node: { [k: string]: unknown }): NodeVariant {
  if (typeof node['prompt'] === 'string') return 'prompt';
  if (typeof node['bash'] === 'string') return 'bash';
  if (typeof node['skill'] === 'string') return 'skill';
  if (typeof node['cft'] === 'string') return 'cft';
  if (
    node['approval'] !== undefined
    && typeof node['approval'] === 'object'
    && node['approval'] !== null
  ) {
    return 'approval';
  }
  // Node-catalog N1.1 (2026-05-11) — control-flow `if` node.
  if (
    node['if'] !== undefined
    && typeof node['if'] === 'object'
    && node['if'] !== null
    && typeof (node['if'] as { condition?: unknown }).condition === 'string'
  ) {
    return 'if';
  }
  // Node-catalog N1.2 (2026-05-11) — control-flow `switch` node.
  if (
    node['switch'] !== undefined
    && typeof node['switch'] === 'object'
    && node['switch'] !== null
    && typeof (node['switch'] as { value?: unknown }).value === 'string'
    && Array.isArray((node['switch'] as { cases?: unknown }).cases)
  ) {
    return 'switch';
  }
  // Node-catalog N1.3 (2026-05-11) — control-flow `iteration` node.
  if (
    node['iteration'] !== undefined
    && typeof node['iteration'] === 'object'
    && node['iteration'] !== null
    && typeof (node['iteration'] as { items?: unknown }).items === 'string'
    && typeof (node['iteration'] as { body?: unknown }).body === 'string'
  ) {
    return 'iteration';
  }
  // Node-catalog N2.1 (2026-05-11) — LLM-driven classification node.
  if (
    node['classify'] !== undefined
    && typeof node['classify'] === 'object'
    && node['classify'] !== null
    && typeof (node['classify'] as { input?: unknown }).input === 'string'
    && Array.isArray((node['classify'] as { classes?: unknown }).classes)
  ) {
    return 'classify';
  }
  // Node-catalog N2.2 (2026-05-11) — LLM-driven extract node.
  if (
    node['extract'] !== undefined
    && typeof node['extract'] === 'object'
    && node['extract'] !== null
    && typeof (node['extract'] as { input?: unknown }).input === 'string'
    && typeof (node['extract'] as { schema?: unknown }).schema === 'object'
  ) {
    return 'extract';
  }
  // Node-catalog N3.1 (2026-05-11) — set / variable assigner.
  if (
    node['set'] !== undefined
    && typeof node['set'] === 'object'
    && node['set'] !== null
    && typeof (node['set'] as { fields?: unknown }).fields === 'object'
  ) {
    return 'set';
  }
  // Node-catalog N3.2 (2026-05-11) — array filter.
  if (
    node['filter'] !== undefined
    && typeof node['filter'] === 'object'
    && node['filter'] !== null
    && typeof (node['filter'] as { items?: unknown }).items === 'string'
    && typeof (node['filter'] as { condition?: unknown }).condition === 'string'
  ) {
    return 'filter';
  }
  // Node-catalog N3.3 (2026-05-11) — template transform.
  if (
    node['template'] !== undefined
    && typeof node['template'] === 'object'
    && node['template'] !== null
    && typeof (node['template'] as { template?: unknown }).template === 'string'
  ) {
    return 'template';
  }
  // Node-catalog N4.3 (2026-05-11) — HTTP request.
  if (
    node['http'] !== undefined
    && typeof node['http'] === 'object'
    && node['http'] !== null
    && typeof (node['http'] as { url?: unknown }).url === 'string'
  ) {
    return 'http';
  }
  // Node-catalog N4.1 (2026-05-11) — schedule trigger.
  if (
    node['scheduleTrigger'] !== undefined
    && typeof node['scheduleTrigger'] === 'object'
    && node['scheduleTrigger'] !== null
    && typeof (node['scheduleTrigger'] as { type?: unknown }).type === 'string'
  ) {
    return 'scheduleTrigger';
  }
  // Node-catalog N4.2 (2026-05-11) — webhook trigger.
  if (
    node['webhookTrigger'] !== undefined
    && typeof node['webhookTrigger'] === 'object'
    && node['webhookTrigger'] !== null
    && typeof (node['webhookTrigger'] as { path?: unknown }).path === 'string'
  ) {
    return 'webhookTrigger';
  }
  // Node-catalog N4.4 (2026-05-11 · scheduler-retirement R6) — Discord trigger.
  if (
    node['discordTrigger'] !== undefined
    && typeof node['discordTrigger'] === 'object'
    && node['discordTrigger'] !== null
    && typeof (node['discordTrigger'] as { kind?: unknown }).kind === 'string'
  ) {
    return 'discordTrigger';
  }
  // Node-catalog N4.5 (2026-05-11 · scheduler-retirement R7) — Telegram trigger.
  if (
    node['telegramTrigger'] !== undefined
    && typeof node['telegramTrigger'] === 'object'
    && node['telegramTrigger'] !== null
    && typeof (node['telegramTrigger'] as { kind?: unknown }).kind === 'string'
  ) {
    return 'telegramTrigger';
  }
  // Surface-unification §B6 (2026-05-11 · n8n ManualTrigger port).
  if (
    node['manualTrigger'] !== undefined
    && typeof node['manualTrigger'] === 'object'
    && node['manualTrigger'] !== null
  ) {
    return 'manualTrigger';
  }
  // Surface-unification §B7 (2026-05-11 · n8n ChatTrigger v1 port).
  if (
    node['chatTrigger'] !== undefined
    && typeof node['chatTrigger'] === 'object'
    && node['chatTrigger'] !== null
    && typeof (node['chatTrigger'] as { path?: unknown }).path === 'string'
  ) {
    return 'chatTrigger';
  }
  return 'unknown';
}

/** Plugin node kind (`<plugin>:<name>`) — plugin nodes carry `kind` instead of a variant key,
 *  so `classifyNodeVariant` says «unknown»; this is the name to show instead. */
export function pluginNodeKind(node: { [k: string]: unknown }): string | null {
  const kind = node['kind'];
  return typeof kind === 'string' && /^[a-z0-9-]+:[a-z0-9-]+$/.test(kind) ? kind : null;
}

/** Badge text for a node card / editor header: the plugin kind for plugin nodes, else the variant. */
export function nodeBadgeLabel(node: { [k: string]: unknown }, variant: NodeVariant): string {
  return variant === 'unknown' ? pluginNodeKind(node) ?? variant : variant;
}

export interface GraphNode {
  id: string;
  variant: NodeVariant;
  /** Badge text — `nodeBadgeLabel` (plugin kind for plugin nodes). */
  badge: string;
  /** Short label rendered on the node card. */
  label: string;
  /** First line of the node's distinguishing payload (the prompt's
   *  first line, the bash command's first line, the skill slug, the
   *  cft method, the approval message). Used as a 1-line preview. */
  preview: string;
  /** Optional metadata flags surfaced as small badges. */
  hasWhen: boolean;
  triggerRule?: string;
  /** Tool policy flags — true if the node has either an allow or a
   *  deny list (workflow author tightened the roster on this node). */
  hasToolPolicy: boolean;
  /** Tier 2 W4 (2026-05-11) — approval node's delivery channel for
   *  the inline channel-icon row on the card. Allowed values come from
   *  src/workflow-runtime/schema.ts:273–282 = {modal, terminal,
   *  telegram, discord, pushcut, all}. */
  approvalDelivery?: string;
  /** Node-catalog v2 (2026-05-11) — branch labels for multi-handle
   *  visualization. `if` → `['then', 'else']`. `switch` → cases + 'default'.
   *  Other variants leave this undefined and render a single source
   *  handle on the right. */
  branches?: string[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface GraphLayout {
  nodes: Array<GraphNode & { position: { x: number; y: number }; width: number; height: number }>;
  edges: GraphEdge[];
  /** Bounds, useful for setting initial viewport / fitView. */
  bounds: { width: number; height: number };
}

const DEFAULT_NODE_WIDTH = 200;
const DEFAULT_NODE_HEIGHT = 64;

function firstLine(s: string | undefined): string {
  if (!s) return '';
  const line = s.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.trim().slice(0, 64);
}

/** Pure: workflow → graph nodes + edges (no layout). The order of the
 *  output mirrors the source `nodes` array to keep snapshots stable. */
export function buildGraphFromDefinition(def: WorkflowDefinitionLike): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (const raw of def.nodes ?? []) {
    if (!raw || typeof raw.id !== 'string' || raw.id.length === 0) continue;
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);

    const variant = classifyNodeVariant(raw);
    let preview = '';
    let approvalDelivery: string | undefined;
    switch (variant) {
      case 'prompt': preview = firstLine(raw['prompt'] as string); break;
      case 'bash':   preview = firstLine(raw['bash'] as string); break;
      case 'skill':  preview = String(raw['skill'] ?? '').slice(0, 64); break;
      case 'cft':    preview = String(raw['cft'] ?? '').slice(0, 64); break;
      case 'approval': {
        const a = raw['approval'] as { message?: string; delivery?: string } | undefined;
        preview = firstLine(a?.message);
        if (typeof a?.delivery === 'string' && a.delivery.length > 0) {
          approvalDelivery = a.delivery;
        }
        break;
      }
      case 'if': {
        const cond = (raw['if'] as { condition?: string } | undefined)?.condition;
        preview = typeof cond === 'string' ? cond.slice(0, 64) : '';
        break;
      }
      case 'switch': {
        const sw = raw['switch'] as { value?: string; cases?: string[] } | undefined;
        const caseSummary = Array.isArray(sw?.cases) ? ` → ${sw!.cases.length} case${sw!.cases.length === 1 ? '' : 's'}` : '';
        preview = `${(sw?.value ?? '').slice(0, 40)}${caseSummary}`;
        break;
      }
      case 'iteration': {
        const it = raw['iteration'] as { items?: string; body?: string } | undefined;
        preview = `over ${(it?.items ?? '').slice(0, 32)}`;
        break;
      }
      case 'classify': {
        const c = raw['classify'] as { input?: string; classes?: string[] } | undefined;
        const count = Array.isArray(c?.classes) ? c!.classes.length : 0;
        preview = `${count} class${count === 1 ? '' : 'es'} from ${(c?.input ?? '').slice(0, 24)}`;
        break;
      }
      case 'extract': {
        const e = raw['extract'] as { input?: string; schema?: Record<string, string> } | undefined;
        const fields = e?.schema ? Object.keys(e.schema).length : 0;
        preview = `${fields} field${fields === 1 ? '' : 's'} from ${(e?.input ?? '').slice(0, 24)}`;
        break;
      }
      case 'set': {
        const s = raw['set'] as { fields?: Record<string, string> } | undefined;
        const count = s?.fields ? Object.keys(s.fields).length : 0;
        preview = `set ${count} field${count === 1 ? '' : 's'}`;
        break;
      }
      case 'filter': {
        const f = raw['filter'] as { items?: string; condition?: string } | undefined;
        preview = `filter ${(f?.items ?? '').slice(0, 28)} on ${(f?.condition ?? '').slice(0, 24)}`;
        break;
      }
      case 'template': {
        const t = raw['template'] as { template?: string } | undefined;
        const firstLineText = firstLine(t?.template);
        preview = `tpl: ${firstLineText.slice(0, 56)}`;
        break;
      }
      // Surface-unification §B8 (2026-05-11) — trigger variants get a
      // single human-readable preview helper (cron → "Every day at
      // 09:00", webhook → "🔗 POST /hooks/deploy · bearer", etc.) so
      // the graph card reads like English instead of raw schema.
      case 'http':
      case 'scheduleTrigger':
      case 'webhookTrigger':
      case 'discordTrigger':
      case 'telegramTrigger':
      case 'manualTrigger':
      case 'chatTrigger': {
        preview = previewTriggerCard(variant, raw as Record<string, unknown>) ?? '';
        break;
      }
      default:
        preview = '';
    }

    // Node-catalog v2 (2026-05-11) — derive multi-handle branch labels
    // so the custom node component can render N source handles
    // for if/switch nodes (visual polish · runtime stays single-output).
    if (variant === 'unknown' && pluginNodeKind(raw as Record<string, unknown>)) {
      // Plugin node — preview the first filled string input (e.g. the Markdown body).
      const inputs = raw['inputs'];
      const first = inputs && typeof inputs === 'object'
        ? Object.values(inputs as Record<string, unknown>).find((v): v is string => typeof v === 'string' && v.trim() !== '')
        : undefined;
      preview = first ? firstLine(first) : '';
    }
    let branches: string[] | undefined;
    if (variant === 'if') {
      branches = ['then', 'else'];
    } else if (variant === 'switch') {
      const cases = (raw['switch'] as { cases?: unknown } | undefined)?.cases;
      if (Array.isArray(cases)) {
        const stringCases = cases.filter((c): c is string => typeof c === 'string' && c.length > 0);
        branches = [...stringCases, 'default'];
      }
    }

    nodes.push({
      id: raw.id,
      variant,
      badge: nodeBadgeLabel(raw as Record<string, unknown>, variant),
      label: raw.id,
      preview,
      hasWhen: typeof raw.when === 'string' && raw.when.trim() !== '',
      ...(typeof raw.trigger_rule === 'string' ? { triggerRule: raw.trigger_rule } : {}),
      hasToolPolicy:
        Array.isArray(raw['allowed_tools']) || Array.isArray(raw['denied_tools']),
      ...(approvalDelivery !== undefined ? { approvalDelivery } : {}),
      ...(branches ? { branches } : {}),
    });

    const deps = Array.isArray(raw.depends_on) ? raw.depends_on : [];
    for (const src of deps) {
      if (typeof src !== 'string' || src.length === 0) continue;
      edges.push({ id: `${src}->${raw.id}`, source: src, target: raw.id });
    }
  }

  return { nodes, edges };
}

/** Pure: run dagre over the abstract graph and assign x/y to each
 *  node. Left-to-right by default (Ergonomic-port Tier E1.2 — matches
 *  n8n / Zapier convention; user-reported pain "커넥터 위아래 이상" before
 *  this flip). Returns positions in screen-pixel space anchored at
 *  (0, 0).
 *
 *  Defaults are tuned for LR: `ranksep` (column gap) = 100,
 *  `nodesep` (row gap) = 40 — wider horizontally, tighter vertically. */
export function layoutGraph(input: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Px between rank stripes (default 100 for LR / 80 for TB). */
  rankSep?: number;
  /** Px between nodes in the same rank (default 40 for LR / 60 for TB). */
  nodeSep?: number;
  /** 'LR' (left-right · default · Tier E1.2) or 'TB' (top-bottom · legacy). */
  direction?: 'TB' | 'LR';
}): GraphLayout {
  const dir = input.direction ?? 'LR';
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: dir,
    ranksep: input.rankSep ?? (dir === 'LR' ? 100 : 80),
    nodesep: input.nodeSep ?? (dir === 'LR' ? 40 : 60),
    marginx: 20,
    marginy: 20,
  });

  for (const n of input.nodes) {
    g.setNode(n.id, { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT });
  }
  for (const e of input.edges) {
    g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  const placed: GraphLayout['nodes'] = input.nodes.map((n) => {
    const layoutNode = g.node(n.id) as { x?: number; y?: number; width?: number; height?: number } | undefined;
    const x = (layoutNode?.x ?? 0) - DEFAULT_NODE_WIDTH / 2;
    const y = (layoutNode?.y ?? 0) - DEFAULT_NODE_HEIGHT / 2;
    return {
      ...n,
      position: { x, y },
      width: layoutNode?.width ?? DEFAULT_NODE_WIDTH,
      height: layoutNode?.height ?? DEFAULT_NODE_HEIGHT,
    };
  });

  // Compute bounds by walking placed nodes. Useful for fitView /
  // initial viewport; dagre doesn't expose this directly.
  let maxRight = 0;
  let maxBottom = 0;
  for (const p of placed) {
    maxRight = Math.max(maxRight, p.position.x + p.width);
    maxBottom = Math.max(maxBottom, p.position.y + p.height);
  }

  return {
    nodes: placed,
    edges: input.edges,
    bounds: { width: maxRight, height: maxBottom },
  };
}

/** ROADMAP Tier 1 W3 (2026-05-11) — read layout-overrides out of the
 *  yaml's `_meta.layout` map. Per-node `{x, y}` pairs are honored;
 *  missing nodes fall back to dagre. `_meta` is a elanous-specific
 *  YAML extension the daemon validator quietly ignores (workflow
 *  authoring is the only place that reads it). */
function extractLayoutOverrides(
  def: WorkflowDefinitionLike,
): Record<string, { x: number; y: number }> {
  const meta = def['_meta'];
  if (!meta || typeof meta !== 'object') return {};
  const layout = (meta as Record<string, unknown>)['layout'];
  if (!layout || typeof layout !== 'object') return {};
  const out: Record<string, { x: number; y: number }> = {};
  for (const [id, entry] of Object.entries(layout as Record<string, unknown>)) {
    if (
      entry
      && typeof entry === 'object'
      && typeof (entry as { x?: unknown }).x === 'number'
      && typeof (entry as { y?: unknown }).y === 'number'
    ) {
      out[id] = {
        x: (entry as { x: number }).x,
        y: (entry as { y: number }).y,
      };
    }
  }
  return out;
}

/** Convenience for the common case: definition → laid-out graph.
 *  Honors `_meta.layout.{nodeId}: {x, y}` overrides per W3 — nodes
 *  with stored positions skip dagre placement, missing nodes fall
 *  back to it. */
export function workflowToLayout(
  def: WorkflowDefinitionLike,
  opts?: { direction?: 'TB' | 'LR' },
): GraphLayout {
  const { nodes, edges } = buildGraphFromDefinition(def);
  const baseline = layoutGraph({
    nodes,
    edges,
    ...(opts?.direction ? { direction: opts.direction } : {}),
  });
  const overrides = extractLayoutOverrides(def);
  if (Object.keys(overrides).length === 0) return baseline;

  // Overlay overrides onto dagre output. Recompute bounds so fitView
  // accounts for a node dragged outside the original dagre rectangle.
  let maxRight = 0;
  let maxBottom = 0;
  const placed = baseline.nodes.map((n) => {
    const override = overrides[n.id];
    const position = override ?? n.position;
    const next = { ...n, position };
    maxRight = Math.max(maxRight, position.x + n.width);
    maxBottom = Math.max(maxBottom, position.y + n.height);
    return next;
  });
  return {
    nodes: placed,
    edges: baseline.edges,
    bounds: { width: maxRight, height: maxBottom },
  };
}
