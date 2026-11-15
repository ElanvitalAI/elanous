import type { MessageBlock } from '../../conv-substrate/message-block.js';
import type { SerializedMessage } from '../../session/index.js';
import { toolActivityTarget } from '../chat/tool-activity.js';

/** Resolve only the trace named by both coordinates; tool call ids may repeat across runs. */
export function resolveMessageBlockRawTrace(messages: readonly SerializedMessage[], block: MessageBlock): SerializedMessage | undefined {
  const ref = block.detail?.rawRef;
  if (!ref || block.body.kind !== 'tool-call' || block.id !== ref.blockId) return undefined;
  const toolCallId = block.body.toolCallId;
  return messages.find((message) => message.role === 'tool'
    && message.toolCallId === toolCallId && message.surfaceRunId === ref.runId);
}

/** Format persisted tool trace fields without hiding stderr or process status. */
export function formatMessageBlockRawTrace(trace: SerializedMessage): string {
  let args: Record<string, unknown> = {};
  if (trace.toolArgs && typeof trace.toolArgs === 'object' && !Array.isArray(trace.toolArgs)) {
    args = trace.toolArgs as Record<string, unknown>;
  } else if (typeof trace.toolArgs === 'string') {
    try {
      const value: unknown = JSON.parse(trace.toolArgs);
      if (value && typeof value === 'object' && !Array.isArray(value)) args = value as Record<string, unknown>;
    } catch { /* a truncated or non-JSON argument record has no safe summary */ }
  }
  const inputSummary = toolActivityTarget(trace.toolName ?? '', args);
  let result: unknown = trace.toolResult;
  if (typeof result === 'string') {
    try { result = JSON.parse(result) as unknown; } catch { /* plain tool output */ }
  }
  const sections: string[] = [];
  if (typeof result === 'string') {
    sections.push(`결과\n${result}`);
  } else if (result && typeof result === 'object' && !Array.isArray(result)) {
    const value = result as Record<string, unknown>;
    const hasStdout = Object.hasOwn(value, 'stdout');
    const hasOutput = Object.hasOwn(value, 'output');
    const render = (entry: unknown): string => typeof entry === 'string' ? entry : JSON.stringify(entry, null, 2) ?? String(entry);
    if (hasStdout && hasOutput && JSON.stringify(value.stdout) === JSON.stringify(value.output)) {
      sections.push(`stdout/output\n${render(value.stdout)}`);
    } else {
      if (hasStdout) sections.push(`stdout\n${render(value.stdout)}`);
      if (hasOutput) sections.push(`output\n${render(value.output)}`);
    }
    if (Object.hasOwn(value, 'stderr')) sections.push(`stderr\n${render(value.stderr)}`);
    const hasExitCode = Object.hasOwn(value, 'exitCode');
    const hasCode = Object.hasOwn(value, 'code');
    if (hasExitCode && hasCode && JSON.stringify(value.exitCode) === JSON.stringify(value.code)) {
      sections.push(`종료 상태 (exitCode/code)\n${render(value.exitCode)}`);
    } else {
      if (hasExitCode) sections.push(`종료 상태\n${render(value.exitCode)}`);
      if (hasCode) sections.push(`code\n${render(value.code)}`);
    }
    if (Object.hasOwn(value, 'status')) sections.push(`상태\n${render(value.status)}`);
    // The Read envelope's transport counts are already represented by the
    // result block. A JSON metadata row under readable output adds visual noise.
    const readTransportEnvelope = trace.toolName === 'Read'
      && typeof value.output === 'string'
      && ['text', 'image', 'pdf', 'binary'].includes(String(value.kind))
      && typeof value.linesRead === 'number' && Number.isSafeInteger(value.linesRead) && value.linesRead >= 0
      && typeof value.totalLines === 'number' && Number.isSafeInteger(value.totalLines) && value.totalLines >= 0
      && typeof value.totalBytes === 'number' && Number.isSafeInteger(value.totalBytes) && value.totalBytes >= 0
      && typeof value.truncated === 'boolean';
    const readTransportFields = readTransportEnvelope
      ? ['linesRead', 'totalLines', 'totalBytes', 'truncated', 'kind'] : [];
    if (readTransportEnvelope && value.truncated === true) sections.push('⚠ 일부 출력만 표시됨 (잘림)');
    const metadata = Object.fromEntries(Object.entries(value).filter(([key]) =>
      !['stdout', 'output', 'stderr', 'exitCode', 'code', 'status', ...readTransportFields].includes(key)));
    if (Object.keys(metadata).length) sections.push(`기타 결과 메타데이터\n${JSON.stringify(metadata)}`);
    if (Object.keys(value).length === 0) sections.push('결과\n{}');
    else if (sections.length === 0) sections.push('결과\n(출력 없음)');
  } else {
    sections.push(`결과\n${result === undefined ? '(결과 없음)' : JSON.stringify(result, null, 2)}`);
  }
  // Persisted arguments can contain command bodies, credentials, and full home
  // paths. Show only the same vetted target used by the live activity line.
  if (inputSummary) sections.push(`입력\n${inputSummary}`);
  return sections.join('\n');
}
