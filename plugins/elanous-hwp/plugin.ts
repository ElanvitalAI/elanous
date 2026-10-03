import { readFileSync, writeFileSync } from 'node:fs';
import type { ElanousPlugin } from '../../src/plugins/core/types.js';
import { hwpxToMarkdown, markdownToHwpx } from './converter.js';

const plugin: ElanousPlugin = {
  name: 'elanous-hwp',
  version: '0.1.0',
  description: 'Convert HWPX to Markdown and write minimal HWPX from Markdown.',
  initialState: () => undefined,
  panes: {},
  llmTools: [
    {
      name: 'HwpxToMarkdown',
      description: 'Read an HWPX ZIP document as Markdown (paragraphs, headings, tables). Legacy .hwp is unsupported.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      async handler(args) {
        const path = args.path;
        if (typeof path !== 'string') throw new Error('path must be a string');
        if (/\.hwp$/i.test(path)) throw new Error('HWP(옛 바이너리)는 지원 안 함 · hwpx 로 저장해 달라');
        if (!/\.hwpx$/i.test(path)) throw new Error('Expected .hwpx input');
        return { markdown: hwpxToMarkdown(readFileSync(path), path) };
      },
    },
    {
      name: 'MarkdownToHwpx',
      description: 'Write paragraphs and headings from a Markdown file to a new HWPX ZIP document.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, output: { type: 'string' } }, required: ['path', 'output'] },
      async handler(args) {
        const { path, output } = args;
        if (typeof path !== 'string' || typeof output !== 'string') throw new Error('path and output must be strings');
        if (/\.hwp$/i.test(path) || /\.hwp$/i.test(output)) throw new Error('HWP(옛 바이너리)는 지원 안 함 · hwpx 로 저장해 달라');
        if (!/\.md$/i.test(path) || !/\.hwpx$/i.test(output)) throw new Error('Expected .md input and .hwpx output');
        writeFileSync(output, markdownToHwpx(readFileSync(path, 'utf8')), { flag: 'wx' });
        return { output };
      },
    },
  ],
};

export default plugin;
