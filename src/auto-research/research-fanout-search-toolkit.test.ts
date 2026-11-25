import { expect, test } from 'bun:test';
import { createResearchSubagent, type ResearchSubagentDeps } from './research-fanout.js';

type Args = Record<string, unknown>;

test('fan-out child gets the read-only search extras next to OmniSearch, and they dispatch locally', async () => {
  let seenOpts: { hostTools?: { name: string }[]; resolveAgentDef?: () => { tools?: string[]; permissionMode?: string }; dispatchTool?: (n: string, a: Args) => Promise<unknown> } = {};
  const localCalls: string[] = [];
  const worker = createResearchSubagent({
    dispatchAgent: (async (_args: Args, opts: typeof seenOpts) => {
      seenOpts = opts;
      await opts.dispatchTool!('DocsSearch', { query: 'q' });
      return { output: 'done', agent: 'general-purpose', cid: 'c', taskId: 't' };
    }) as unknown as ResearchSubagentDeps['dispatchAgent'],
    buildOmniSearchTool: (() => ({ name: 'OmniSearch', description: 'x', parameters: {} })) as unknown as ResearchSubagentDeps['buildOmniSearchTool'],
    dispatchResearchOmniSearch: (async () => ({ output: 'ok' })) as unknown as ResearchSubagentDeps['dispatchResearchOmniSearch'],
    buildReadOnlySearchCatalog: () => ({
      specs: ['Glob', 'Grep', 'Read', 'ListDir', 'DirectiveSearch', 'DocsSearch'].map((name) => ({ name, description: name, parameters: {} })),
      dispatch: async (name: string) => { localCalls.push(name); return 'local'; },
    }),
  });
  await worker({ id: 'a1', label: 'Angle', instruction: 'look' } as never, 'question', new AbortController().signal);
  expect(seenOpts.hostTools!.map((t) => t.name)).toEqual(['OmniSearch', 'Glob', 'Grep', 'Read', 'ListDir', 'DirectiveSearch', 'DocsSearch']);
  const def = seenOpts.resolveAgentDef!();
  expect(def.tools).toEqual(['OmniSearch', 'Glob', 'Grep', 'Read', 'ListDir', 'DirectiveSearch', 'DocsSearch']);
  expect(def.permissionMode).toBe('read-only');
  expect(localCalls).toEqual(['DocsSearch']);
  await expect(seenOpts.dispatchTool!('Bash', {})).rejects.toThrow('research agent tool is not permitted: Bash');
});
