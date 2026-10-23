import { describe, expect, test } from 'bun:test';
import { createPasteFold, pasteFoldToken, PASTE_FOLD_MIN_CHARS, shouldFoldPaste } from './paste-fold.js';

const fifty = Array.from({ length: 50 }, (_, i) => `paste-line-${String(i).padStart(2, '0')}`).join('\n');

describe('paste-fold — 긴 붙여넣기 자리표시', () => {
  test('짧은 붙여넣기는 그대로 넣는다(접지 않음 · 관측 0)', () => {
    const logs: string[] = [];
    const f = createPasteFold((_c, e) => logs.push(e));
    expect(f.fold('paste-short-hello')).toBe('paste-short-hello');
    expect(f.fold('한 줄\n두 줄\n세 줄')).toBe('한 줄\n두 줄\n세 줄');
    expect(f.size()).toBe(0);
    expect(logs).toEqual([]);
  });

  test('50줄은 «[붙여넣음 #1 · 50줄 · 699자]» 한 덩어리 · 제출 때 원문 전체', () => {
    const logs: Array<{ e: string; d: Record<string, unknown> }> = [];
    const f = createPasteFold((_c, e, d) => logs.push({ e, d }));
    const token = f.fold(fifty);
    expect(token).toBe('[붙여넣음 #1 · 50줄 · 699자]');
    expect(token).toBe(pasteFoldToken(1, fifty));
    expect(f.expand(`요약해줘 ${token}`)).toBe(`요약해줘 ${fifty}`);
    expect(f.size()).toBe(0);
    expect(logs.map((l) => l.e)).toEqual(['folded', 'expanded']);
    expect(logs[0]!.d).toEqual({ id: 1, lines: 50, chars: 699 });
  });

  test('줄은 적어도 글자가 길면 접는다 · 끝 줄바꿈 하나는 줄 수에 안 넣는다', () => {
    const long = 'x'.repeat(PASTE_FOLD_MIN_CHARS);
    expect(shouldFoldPaste(long)).toBe(true);
    const f = createPasteFold(() => {});
    expect(f.fold('a\nb\nc\nd\n')).toBe('[붙여넣음 #1 · 4줄 · 7자]');
  });

  test('토큰을 지우면 그 붙여넣기는 안 간다 · 여러 개는 각자 펼친다 · 남은 것은 다음 제출까지 쥔다', () => {
    const f = createPasteFold(() => {});
    const a = f.fold(fifty);
    const b = f.fold(fifty.replace(/paste/g, 'other'));
    expect(f.expand('지웠다')).toBe('지웠다');
    expect(f.size()).toBe(2);
    expect(f.expand(`${b}`)).toBe(fifty.replace(/paste/g, 'other'));
    expect(f.size()).toBe(1);
    expect(f.expand(`앞 ${a} 뒤`)).toBe(`앞 ${fifty} 뒤`);
    expect(f.size()).toBe(0);
  });

  test('CRLF·끝 줄바꿈은 표시에서만 정규화하고 제출은 원문 바이트 그대로', () => {
    const f = createPasteFold(() => {});
    const crlf = f.fold('1\r\n2\r\n3\r\n4');
    expect(crlf).toBe('[붙여넣음 #1 · 4줄 · 7자]');
    expect(f.expand(crlf)).toBe('1\r\n2\r\n3\r\n4');
    const trailing = f.fold('a\nb\nc\nd\n');
    expect(f.expand(trailing)).toBe('a\nb\nc\nd\n');
  });

  test('한 번에 훑는다 — 펼친 원문 안의 다른 토큰 글은 다시 치환하지 않는다(지운 붙여넣기 되살아남 0)', () => {
    const f = createPasteFold(() => {});
    const b = f.fold(fifty.replace(/paste/g, 'bbbbb'));
    const aBody = `${b}\n${fifty}`; // A 의 원문 안에 B 의 토큰 «글»이 들어 있다
    const a = f.fold(aBody);
    // 사람이 입력칸에서 B 토큰을 지우고 A 만 제출
    expect(f.expand(a)).toBe(aBody);
    expect(f.expand(a)).not.toContain('bbbbb-line-00');
  });

  test('retainOnly: 입력칸·대기열에 없는 토큰(지운 붙여넣기)의 원문을 놓는다 · 남은 것은 쥔다', () => {
    const logs: string[] = [];
    const f = createPasteFold((_c, e) => logs.push(e));
    const a = f.fold(fifty);
    const b = f.fold(fifty.replace(/paste/g, 'other'));
    expect(f.retainOnly([`큐에 남은 ${b}`])).toBe(1);
    expect(f.size()).toBe(1);
    expect(logs).toContain('dropped');
    // 지운 A 의 토큰 글을 나중에 손으로 쳐도 원문이 되살아나지 않는다
    expect(f.expand(a)).toBe(a);
    expect(f.expand(b)).toBe(fifty.replace(/paste/g, 'other'));
  });
});

