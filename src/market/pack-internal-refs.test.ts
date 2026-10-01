import { expect, test } from 'bun:test';
import { scanPackInternalRefs } from './pack-internal-refs';

test('detects internal paths, private PR numbers and cut hashes with 1-based lines', () => {
  expect(scanPackInternalRefs([{ path: 'script.json', text: '\n"docs/marketing (LAUNCH 초안) · PR #21849 · 컷 e24cb6e"\ncut abcdef123' }])).toEqual([
    { file: 'script.json', line: 2, marker: 'internal-doc-path' },
    { file: 'script.json', line: 2, marker: 'private-pr-number' },
    { file: 'script.json', line: 2, marker: 'cut-hash' },
    { file: 'script.json', line: 3, marker: 'cut-hash' },
  ]);
  expect(scanPackInternalRefs([{ path: 'README.md', text: 'docs/brand/icon\n#12345 PR #1234 PR #123456' }])).toEqual([
    { file: 'README.md', line: 1, marker: 'internal-doc-path' },
    { file: 'README.md', line: 2, marker: 'private-pr-number' },
    { file: 'README.md', line: 2, marker: 'private-pr-number' },
    { file: 'README.md', line: 2, marker: 'private-pr-number' },
  ]);
});

test('detects Markdown links and punctuation-bound internal document paths', () => {
  expect(scanPackInternalRefs([{ path: 'README.md', text: '[문서](docs/marketing) docs/brand, docs/manual. docs/goals] docs/system>\ndocs/marketingx' }])).toEqual([
    { file: 'README.md', line: 1, marker: 'internal-doc-path' },
    { file: 'README.md', line: 1, marker: 'internal-doc-path' },
    { file: 'README.md', line: 1, marker: 'internal-doc-path' },
    { file: 'README.md', line: 1, marker: 'internal-doc-path' },
    { file: 'README.md', line: 1, marker: 'internal-doc-path' },
  ]);
});

test('ignores six-digit hex colors, embedded numbers and public release URLs', () => {
  expect(scanPackInternalRefs([{ path: 'README.md', text: 'const C = { deep: "#1D2751", red: "#E95047" }\n#243063\nhttps://github.com/ElanvitalAI/elanous/releases/tag/v0.2.5\na#12345a' }])).toEqual([]);
});
