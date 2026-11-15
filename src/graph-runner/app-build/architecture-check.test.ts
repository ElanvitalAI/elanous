import { describe, expect, test } from 'bun:test';
import { ARCHITECTURE_SECTION_KEYS, checkArchitectureDocument } from './architecture-check.js';

const content: Record<string, string> = Object.fromEntries(ARCHITECTURE_SECTION_KEYS.map((key) => [key, `${key} facts`])) as Record<string, string>;
const bodies: Record<string, string> = {
  context: 'User and application boundary.\n```mermaid\ngraph TD\n  User-->App\n```\n![container diagram](diagrams/system.svg)',
  dataModel: 'Entities, keys, and persistence.\n```mermaid\nerDiagram\n  User ||--o{ Order : places\n```\n![ERD](diagrams/data.drawio)',
  api: 'Methods, paths, schemas, and errors. [API](contracts/api.md)',
  sequences: 'Main flow and conflicting concurrent calls.\n```mermaid\nsequenceDiagram\n  User->>App: request\n```\n![sequence](diagrams/sequence.svg)',
  deployment: 'Local ports and storage; proposed cloud is separate.',
  security: 'Trust boundaries, validation, and secrets.',
  tradeOffs: 'Assumptions, limits, and alternatives.',
  operations: 'Health, logs, restart, and undo.',
};
function document(over: Partial<Record<string, string>> = {}): string {
  return ARCHITECTURE_SECTION_KEYS.map((key) => `## ${key}\n\n${over[key] ?? bodies[key]}`).join('\n\n');
}
const files = ['diagrams/system.svg', 'diagrams/data.drawio', 'diagrams/sequence.svg', 'contracts/api.md'];

describe('checkArchitectureDocument', () => {
  test('accepts all eight populated sections, a diagram, and existing in-memory references', () => {
    expect(checkArchitectureDocument({ markdown: document(), sections: content, files })).toEqual({ ok: true, issues: [] });
    expect(checkArchitectureDocument({ markdown: document().replaceAll('\n', '\r\n'), sections: content, files })).toEqual({ ok: true, issues: [] });
  });

  test('accepts canonical heading keys with Korean titles while rejecting a changed key', () => {
    const titles: Record<string, string> = { context: '시스템 맥락', dataModel: '데이터 모델', api: 'API 계약',
      sequences: '핵심 흐름', deployment: '배포 구성', security: '보안', tradeOffs: '설계 대안', operations: '운영' };
    const localized = ARCHITECTURE_SECTION_KEYS.map(key => `## ${key} — ${titles[key]}\n\n${bodies[key]}`).join('\n\n');
    expect(checkArchitectureDocument({ markdown: localized, sections: content, files })).toEqual({ ok: true, issues: [] });
    const changedKey = localized.replace('## context —', '## contextOther —');
    expect(checkArchitectureDocument({ markdown: changedKey, sections: content, files }).issues)
      .toContainEqual({ code: 'missing-heading', section: 'context' });
  });

  test('reports missing structured section, heading, and empty Markdown body independently', () => {
    const markdown = document({ operations: '   ' }).replace(/## security\n\n[^#]+/u, '');
    const result = checkArchitectureDocument({ markdown, sections: { ...content, api: ' ' }, files });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({ code: 'missing-section', section: 'api' });
    expect(result.issues).toContainEqual({ code: 'missing-heading', section: 'security' });
    expect(result.issues).toContainEqual({ code: 'empty-markdown-section', section: 'operations' });
  });

  test('logo in the title does not substitute for an architecture diagram', () => {
    const markdown = `![logo](logo.png)\n\n${document({ context: 'Boundary only.', dataModel: 'Entities. [ERD](diagrams/data.drawio)' })}`;
    const result = checkArchitectureDocument({ markdown, sections: content, files: [...files, 'logo.png'] });
    expect(result.issues).toContainEqual({ code: 'missing-diagram', section: 'context' });
    expect(result.issues).toContainEqual({ code: 'missing-diagram', section: 'dataModel' });
  });

  test('missing local target, path escape and malformed encoding have structured errors', () => {
    const markdown = document({ api: 'See [API](../private/api.md), [bad](%ZZ), [missing](contracts/nope.md).' });
    const result = checkArchitectureDocument({ markdown, sections: content, files });
    expect(result.issues).toContainEqual({ code: 'invalid-reference', reference: '../private/api.md' });
    expect(result.issues).toContainEqual({ code: 'invalid-reference', reference: '%ZZ' });
    expect(result.issues).toContainEqual({ code: 'missing-reference-target', reference: 'contracts/nope.md' });
  });

  test('optional file list skips target existence while still requiring link and diagram syntax', () => {
    const valid = checkArchitectureDocument({ markdown: document(), sections: content });
    expect(valid.ok).toBe(true);
    const noReference = checkArchitectureDocument({ markdown: document({ context: 'No diagram.', dataModel: 'Only entities.', api: 'Only routes.', sequences: 'Only steps.' }), sections: content });
    expect(noReference.issues).toContainEqual({ code: 'missing-diagram', section: 'context' });
    expect(noReference.issues).toContainEqual({ code: 'missing-reference' });
  });

  test('accepts Korean generic headings and an inline Mermaid diagram without claiming semantic quality', () => {
    const names: Record<string, string> = { context: '시스템 맥락', dataModel: '데이터 모델', api: 'API 계약', sequences: '핵심 시퀀스', deployment: '배포 토폴로지', security: '보안', tradeOffs: '확장성과 대안', operations: '운영' };
    const diagrams: Record<string, string> = { context: 'graph TD; A-->B', dataModel: 'erDiagram\n  A ||--o{ B : contains', sequences: 'sequenceDiagram\n  A->>B: call' };
    const markdown = ARCHITECTURE_SECTION_KEYS.map((key) => `## ${names[key]}\n\n${diagrams[key] ? `\`\`\`mermaid\n${diagrams[key]}\n\`\`\`\n[design](design.md)` : '설계 내용'}`).join('\n\n');
    expect(checkArchitectureDocument({ markdown, sections: content, files: ['design.md'] })).toEqual({ ok: true, issues: [] });
  });

  test('ignores headings and links printed inside code fences; resolves Markdown reference definitions', () => {
    const markdown = document({ context: `${bodies.context}\n\n![container][diagram]\n\n[diagram]: diagrams/system.svg` })
      .replace(/## operations\n\nHealth, logs, restart, and undo\./u,
        '```md\n## operations\n\n[fake](nonexistent.md)\n```');
    const result = checkArchitectureDocument({ markdown, sections: content, files });
    expect(result.issues).toContainEqual({ code: 'missing-heading', section: 'operations' });
    expect(result.issues).not.toContainEqual({ code: 'missing-reference-target', reference: 'nonexistent.md' });
    expect(result.issues.some((issue) => issue.code === 'missing-diagram')).toBe(false);
  });

  test('treats an unresolved Markdown reference as literal text under CommonMark', () => {
    const markdown = document({ context: 'Boundary. ![container][unknown]' });
    const result = checkArchitectureDocument({ markdown, sections: content, files });
    expect(result.issues).toContainEqual({ code: 'missing-diagram', section: 'context' });
    expect(result.issues.some((issue) => issue.code === 'missing-reference-definition')).toBe(false);
  });

  test('requires the matching diagram grammar in each section', () => {
    const markdown = document({
      context: 'Boundary. ```mermaid\nerDiagram\nA ||--o{ B : has\n```',
      dataModel: 'Entities. ```mermaid\nsequenceDiagram\nA->>B: query\n```',
      sequences: 'Flow. ```mermaid\ngraph TD; A-->B\n```',
    }).replaceAll('```mermaid', '\n```mermaid');
    const result = checkArchitectureDocument({ markdown, sections: content, files });
    for (const section of ['context', 'dataModel', 'sequences']) {
      expect(result.issues).toContainEqual({ code: 'missing-diagram', section });
    }
  });

  test('respects heading hierarchy and an unrelated peer heading as a section boundary', () => {
    const markdown = document({ context: `${bodies.context}\n### Details\nNested facts.` })
      .replace(`## dataModel\n\n${bodies.dataModel}`,
        '## dataModel\n\n### Empty child\n## Appendix\n![ERD](diagrams/data.drawio)');
    const result = checkArchitectureDocument({ markdown, sections: content, files });
    expect(result.issues).toContainEqual({ code: 'empty-markdown-section', section: 'dataModel' });
    expect(result.issues).toContainEqual({ code: 'missing-diagram', section: 'dataModel' });
    expect(result.issues).not.toContainEqual({ code: 'missing-diagram', section: 'context' });
  });

  test('ignores inline-code pseudo-links and parses a local path containing parentheses', () => {
    const markdown = document({ api: 'Read `[fake](missing.md)` and [API](contracts/api(v1).md).' });
    const result = checkArchitectureDocument({ markdown, sections: content, files: [...files, 'contracts/api(v1).md'] });
    expect(result.ok).toBe(true);
    expect(result.issues).not.toContainEqual({ code: 'missing-reference-target', reference: 'missing.md' });
  });

  test('accepts canonical section headings at depth three under a parent and stops at peer boundaries', () => {
    const markdown = `## Architecture\n\n${ARCHITECTURE_SECTION_KEYS.map((key) => `### ${key}\n\n${bodies[key]}`).join('\n\n')}`;
    expect(checkArchitectureDocument({ markdown, sections: content, files })).toEqual({ ok: true, issues: [] });
    const emptyContext = markdown.replace(bodies.context, '### Detail\n\n## Next chapter\n\nOutside text');
    const result = checkArchitectureDocument({ markdown: emptyContext, sections: content, files });
    expect(result.issues).toContainEqual({ code: 'empty-markdown-section', section: 'context' });
    expect(result.issues).toContainEqual({ code: 'missing-diagram', section: 'context' });
  });

  test('restores the parent section after a nested canonical heading closes', () => {
    const context = '### security\n\nNested policy.\n\n### Details\n\nParent context resumes.\n```mermaid\ngraph TD\n  User-->App\n```';
    const markdown = document({ context });
    const result = checkArchitectureDocument({ markdown, sections: content, files });
    expect(result.issues).not.toContainEqual({ code: 'missing-diagram', section: 'context' });
    expect(result.issues).not.toContainEqual({ code: 'empty-markdown-section', section: 'context' });
    expect(result.ok).toBe(true);
  });

  test('fails closed for PlantUML, Markdown images, and HTML images as diagram substitutes', () => {
    const markdown = document({
      context: 'Boundary.\n```plantuml\n@startuml\nAlice -> Bob\n@enduml\n```',
      dataModel: 'Entities. ![ERD](diagrams/data.drawio)',
      sequences: 'Flow. <img src="diagrams/sequence.svg" alt="sequence">',
    });
    const result = checkArchitectureDocument({ markdown, sections: content, files });
    for (const section of ['context', 'dataModel', 'sequences']) {
      expect(result.issues).toContainEqual({ code: 'missing-diagram', section });
    }
  });
});
