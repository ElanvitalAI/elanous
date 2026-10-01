import { expect, test } from 'bun:test';
import { recommendedSetup } from './setup-recommend.js';

test('recommends only doctor fixes and the current fast-path setting', () => {
  const on = recommendedSetup({ chat: { fastPath: true } });
  const off = recommendedSetup({ chat: { fastPath: false } });

  expect(on).toHaveLength(2);
  expect(on[0]).toContain('고칠 것 고치기');
  expect(on[0]).toContain('권한');
  expect(on[0]).toContain('PATH');
  expect(on[0]).toContain('elanous doctor --fix --yes');
  expect(on[1]).toContain('짧은 물음은 빠르게');
  expect(on[1]).toContain('chat.fastPath=true');
  expect(off[1]).toContain('chat.fastPath=false');
  expect(on[1]).toContain('elanous config set chat.fastPath false');
  // 꺼져 있으면 «켜기» 명령을 준다(10-01 실측: 꺼진 상태에도 «끄기 … false»가 나왔다).
  expect(off[1]).toContain('켜기: `elanous config set chat.fastPath true`');
  expect(off[1]).not.toContain('fastPath false`');
  expect(on[0]).toBe(off[0]);
  expect(on.every(line => !line.includes('\n') && !line.includes('smart'))).toBe(true);
});
