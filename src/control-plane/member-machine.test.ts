import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nexusMemberMachine } from './member.js';

const roots: string[] = [];
function root(): string {
  const r = mkdtempSync(join(tmpdir(), 'nexus-member-machine-'));
  roots.push(r);
  mkdirSync(join(r, 'control'), { recursive: true });
  return r;
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('넥서스 멤버의 기계 신원', () => {
  test('프로필이 있으면 hostname 이 아니라 프로필 id ⊕ 맡은 일·자리', () => {
    const r = root();
    writeFileSync(join(r, 'control', 'machine.json'), JSON.stringify({ id: 'mbp', duties: ['workstation'], seats: { control: { rank: 1 } } }));
    expect(nexusMemberMachine(r, 'MacBookProM5')).toEqual({
      id: 'machine:mbp', name: 'mbp', attrs: { duties: ['workstation'], seats: { control: { rank: 1 } } },
    });
  });

  test('프로필이 없으면 소문자 hostname(첫 마디)', () => {
    expect(nexusMemberMachine(root(), 'MacBookProM5.local')).toEqual({ id: 'machine:macbookprom5', name: 'macbookprom5' });
  });
});
