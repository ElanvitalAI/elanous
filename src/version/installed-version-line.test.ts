import { expect, test } from 'bun:test';
import { parseInstalledVersionLine } from './installed-version-line.js';

test('parses installed versions with a full commit across legacy and stamped output', () => {
  const commit = '33ae2756b195987a883976d21e5310a4d5083c09';
  const expected = { version: '0.3.32', commit };
  expect(parseInstalledVersionLine(`0.3.32 ${commit}`)).toEqual(expected);
  expect(parseInstalledVersionLine(`0.3.32 261121_0855 ${commit}`)).toEqual(expected);
  expect(parseInstalledVersionLine(`0.3.32 official ${commit}`)).toEqual(expected);
  expect(parseInstalledVersionLine(`0.3.32-dev.0 261121_0855 ${commit}`)).toEqual({ ...expected, version: '0.3.32-dev.0' });
  for (const bad of [`0.3.32 unknown ${commit}`, `0.3.32 261121_0855 ${commit.slice(0, 12)}`,
    `0.3.32 261121_0855 ${commit}\nextra`, `0.3.32 261121_0855 ${commit} extra`]) {
    expect(parseInstalledVersionLine(bad)).toBeNull();
  }
});
