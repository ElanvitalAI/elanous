/** Diagram generation — Mermaid inline (no external deps) + Excalidraw stub */

import { env } from './env.js';
import { compactText } from './util.js';

/**
 * Ask Grok to generate a Mermaid diagram definition from content.
 * Returns raw mermaid code (```mermaid ... ``` block).
 */
export async function generateMermaidDiagram(
  content: string,
  opts?: { diagramType?: string; title?: string },
): Promise<string> {
  const apiKey = env('XAI_API_KEY');
  if (!apiKey) throw new Error('XAI_API_KEY 필요');

  const model = env('GROK_MODEL', 'grok-4-1-fast-reasoning');
  const diagramType = opts?.diagramType || 'flowchart';
  const prompt = `다음 콘텐츠를 바탕으로 Mermaid ${diagramType} 다이어그램을 생성하세요.
요구사항:
- 유효한 Mermaid 문법만 출력
- 한국어 레이블 사용
- 핵심 흐름/구조/관계를 시각화
- 코드 블록(\`\`\`mermaid ... \`\`\`) 형태로만 출력, 설명 없이

${opts?.title ? `제목: ${opts.title}` : ''}

콘텐츠:
${compactText(content, 6000)}`;

  const res = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      input: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(`Diagram generation failed: ${res.status}`);
  const data = await res.json();
  for (const item of data.output || [])
    for (const c of item.content || [])
      if ((c.type === 'output_text' || c.type === 'text') && c.text) return c.text.trim();
  throw new Error('다이어그램 생성 실패');
}

/**
 * Append mermaid diagram section to markdown body.
 * Generates diagram from summary content.
 */
export async function appendDiagramToMarkdown(
  markdownBody: string,
  opts?: { diagramType?: string; title?: string },
): Promise<string> {
  try {
    console.log('  다이어그램 생성 중...');
    const mermaidBlock = await generateMermaidDiagram(markdownBody, opts);
    console.log('  다이어그램 생성 완료');
    return `${markdownBody}\n\n## 다이어그램\n\n${mermaidBlock}`;
  } catch (e: any) {
    console.log(`  다이어그램 생성 실패: ${e.message}`);
    return markdownBody;
  }
}

/**
 * Check if user wants diagrams (from intent text).
 */
export function wantsDiagram(intentText: string): boolean {
  return /다이어그램|diagram|시각화|visualize|플로우|flowchart|아키텍처|architecture/i.test(intentText);
}
