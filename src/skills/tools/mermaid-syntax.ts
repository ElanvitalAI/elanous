import type { LLMToolSpec } from '../../llm/tool-spec.js';
// Native tool: mermaid_syntax — T3-A2.
//
// Quick reference for the 9 Mermaid diagram kinds. Companion of
// mermaid_render: when an LLM is about to emit mermaid source it
// can call this tool first to get a known-good template + the
// gotchas that actually trip Mermaid's parser. Source is a hand-
// curated subset of diagram-master's 2247-line syntax-reference.md
// plus domain-templates.md — extracted here so the tool runs
// without reading any file on disk (reliable in every cwd).
//
// Shape:
//
//   mermaid_syntax(domain, query?) →
//     { output, template, notes[], domain }
//
// domain ∈ {flowchart, sequence, class, state, er, gantt,
//           mindmap, timeline, pie}
//
// Future: query-keyword driven template selection (e.g. "subgraph
// with styling" narrows within flowchart). MVP returns the one
// representative template per kind with a classDef palette so
// every diagram comes out pre-styled.



export type MermaidDomain =
  | 'flowchart'
  | 'sequence'
  | 'class'
  | 'state'
  | 'er'
  | 'gantt'
  | 'mindmap'
  | 'timeline'
  | 'pie';

export interface MermaidSyntaxArgs {
  domain: string;
  query?: string;
}

export interface MermaidSyntaxResult {
  output: string;
  template: string;
  notes: string[];
  domain: MermaidDomain | 'unknown';
}

export const MERMAID_DOMAINS: MermaidDomain[] = [
  'flowchart', 'sequence', 'class', 'state', 'er',
  'gantt', 'mindmap', 'timeline', 'pie',
];

const PALETTE = `classDef primary fill:#3b82f6,stroke:#1e3a5f,color:#fff
    classDef secondary fill:#8b5cf6,stroke:#5b21b6,color:#fff
    classDef accent fill:#f59e0b,stroke:#92400e,color:#fff
    classDef success fill:#bbf7d0,stroke:#166534
    classDef warning fill:#fef08a,stroke:#854d0e
    classDef danger fill:#fecaca,stroke:#991b1b`;

interface TemplateEntry {
  template: string;
  notes: string[];
}

const TEMPLATES: Record<MermaidDomain, TemplateEntry> = {
  flowchart: {
    template: `---
title: "Flowchart title"
config:
  layout: elk
  theme: base
---
flowchart LR
    subgraph S1 ["Step 1"]
        A[Input] --> B{Decision}
    end
    B -->|yes| C[Result]
    B -->|no|  D[Skip]
    ${PALETTE}
    class A primary
    class C success
    class D warning`,
    notes: [
      'flowchart direction: LR (left→right), RL, TB (top→bottom), BT.',
      'Node shapes: [rect] (round), (round), {diamond}, ((circle)), >flag], [/slant/], [(cylinder)].',
      'Edges: --> (arrow), --- (line), -.-> (dotted), ==> (thick).',
      'Edge label: A -->|label text| B.',
      '`end` is a reserved word — wrap in quotes: `"end"`.',
      'Comments: `%%` only (NOT `//`).',
      'Frontmatter + classDef is optional but keeps rendered output consistent.',
    ],
  },
  sequence: {
    template: `---
title: "Sequence diagram"
config:
  theme: base
---
sequenceDiagram
    participant U as User
    participant S as Server
    participant DB as Database
    U->>+S: request
    S->>+DB: query
    DB-->>-S: rows
    S-->>-U: response
    Note over U,S: round trip complete`,
    notes: [
      'Arrow types: ->>, -->>, -x, --x, -), --).',
      '+/- on arrow = activate/deactivate participant (lifeline bars).',
      'participant U as User → alias then display name.',
      'Notes: `Note over A,B: text` / `Note left of A: …` / `Note right of A: …`.',
      'Loops: `loop name` / `end`. Alt: `alt condition` / `else other` / `end`.',
    ],
  },
  class: {
    template: `---
title: "Class diagram"
config:
  theme: base
---
classDiagram
    class Animal {
      +String name
      +int age
      +bark() void
    }
    class Dog {
      +String breed
    }
    Animal <|-- Dog
    Animal "1" o-- "many" Bone`,
    notes: [
      'Visibility: + public, - private, # protected, ~ package.',
      'Inheritance: <|-- (extends). Composition: *--. Aggregation: o--. Association: -->.',
      'Cardinality quoted: `"1" o-- "many"`.',
      'Method body: parens + return type at end (e.g. `bark() void`).',
    ],
  },
  state: {
    template: `---
title: "State diagram"
config:
  theme: base
---
stateDiagram-v2
    [*] --> Idle
    Idle --> Active: start
    Active --> Idle: stop
    Active --> Error: fail
    Error --> Idle: reset
    Idle --> [*]`,
    notes: [
      '`[*]` = start/end marker.',
      'Transitions: `A --> B: label`.',
      'Composite state: `state Compound { ... }`.',
      'Use stateDiagram-v2 (not stateDiagram) for modern syntax.',
    ],
  },
  er: {
    template: `---
title: "ER diagram"
config:
  theme: base
---
erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE-ITEM : contains
    CUSTOMER {
      string name
      string email
    }
    ORDER {
      int id
      date placed
    }`,
    notes: [
      'Relationships: `||--o{` (one-to-many), `}|--||` (many-to-one), etc.',
      'Cardinality chars: `|` exactly one, `o` zero or one, `{`/`}` many.',
      'Attribute block uses braces; type precedes name (string, int, date…).',
      'Entity names are uppercase by convention.',
    ],
  },
  gantt: {
    template: `---
title: "Project timeline"
config:
  theme: base
---
gantt
    dateFormat YYYY-MM-DD
    section Design
    Spec        :done, des1, 2026-01-01, 2026-01-05
    Review      :active, des2, after des1, 3d
    section Dev
    Implement   :dev1, after des2, 10d
    Ship        :milestone, 2026-02-01, 0d`,
    notes: [
      'Required: `dateFormat YYYY-MM-DD` at top.',
      'Status flags: `done`, `active`, `crit`.',
      'Dependencies: `after taskId` or absolute date.',
      'Duration: Xd/Xw/Xh or explicit end date.',
      '`milestone` marks single-point events (duration 0).',
    ],
  },
  mindmap: {
    template: `---
title: "Mindmap"
---
mindmap
  root((Topic))
    Concept1
      Detail1a
      Detail1b
    Concept2
      Detail2a
    Concept3::icon(fa fa-book)`,
    notes: [
      'Indentation defines hierarchy (2 spaces per level).',
      'Root shape: `root((text))` (circle) | `root[text]` (box) | `root(text)` (rounded).',
      'Icons: `::icon(fa fa-name)` — requires FontAwesome CSS in the render target.',
      'Cannot combine mindmap with classDef — styling is simpler than flowchart.',
    ],
  },
  timeline: {
    template: `---
title: "Timeline"
---
timeline
    title Product roadmap
    2025 Q1 : Research
            : Market sizing
    2025 Q2 : Prototype
            : Internal demo
    2025 Q3 : Beta launch
    2025 Q4 : General availability`,
    notes: [
      'Each entry: `<time point> : <event>` — subsequent lines starting with `:` continue the same time point.',
      'Use `title` keyword INSIDE the diagram body, not via frontmatter.',
      'No arrows, no nodes — timeline is purely vertical text layout.',
    ],
  },
  pie: {
    template: `---
title: "Distribution"
---
pie showData
    "Alpha" : 40
    "Beta"  : 35
    "Gamma" : 25`,
    notes: [
      'Quoted labels + numeric values.',
      '`showData` adds percentages to each slice.',
      'Only supports 2D pie — use `xychart` for histograms / bar charts.',
    ],
  },
};

export function buildMermaidSyntaxTool(): LLMToolSpec {
  return {
    name: 'MermaidSyntax',
    description:
      'Return a known-good Mermaid template + syntax notes for one of the 9 diagram kinds (flowchart, sequence, class, state, er, gantt, mindmap, timeline, pie). ' +
      'Call before producing mermaid source so the output compiles on the first try. Use the returned template as a starting point, swap node names and labels, then pass to MermaidRender.',
    parameters: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          enum: MERMAID_DOMAINS,
          description: 'One of: flowchart, sequence, class, state, er, gantt, mindmap, timeline, pie.',
        },
        query: {
          type: 'string',
          description: 'Optional keyword hint (currently informational — reserved for future narrowing).',
        },
      },
      required: ['domain'],
      additionalProperties: false,
    },
  };
}

export async function dispatchMermaidSyntax(
  rawArgs: Record<string, unknown>,
): Promise<MermaidSyntaxResult> {
  const domainRaw = String(rawArgs.domain ?? '').toLowerCase().trim();
  const domain = (MERMAID_DOMAINS as readonly string[]).includes(domainRaw)
    ? (domainRaw as MermaidDomain)
    : null;
  if (!domain) {
    const list = MERMAID_DOMAINS.join(', ');
    throw new Error(`'domain' must be one of: ${list}. Got "${domainRaw}".`);
  }
  const entry = TEMPLATES[domain];
  const output = [
    `MermaidSyntax domain=${domain}`,
    '',
    '## Template',
    '```mermaid',
    entry.template,
    '```',
    '',
    '## Notes',
    ...entry.notes.map((n) => `- ${n}`),
  ].join('\n');
  return {
    output,
    template: entry.template,
    notes: [...entry.notes],
    domain,
  };
}
