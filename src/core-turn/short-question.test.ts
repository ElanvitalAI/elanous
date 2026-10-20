import { describe, expect, test } from 'bun:test';
import { classifyTuiChatIntent } from './short-question';

// TUI-H1-ROUTE-WRITEVERB-FP (재점검 A · TF 10-17 #28487):
// «도구 쓰지 말고 답해: … 첫 줄을 그대로 옮기고» 는 복사·전사 지시다 — write-verb 오탐으로
// 코딩·구현 goal loop 로 가면 chat.route 가 route≠코딩·구현 을 결정한 것과 어긋난다.
describe('TUI-H1-ROUTE-WRITEVERB-FP · «도구 쓰지 말고 답해: … 첫 줄을 그대로 옮기고» 오탐 수정', () => {
  test('copy/no-tool directive routes away from 코딩·구현', () => {
    const verdict = classifyTuiChatIntent('도구 쓰지 말고 답해: … 첫 줄을 그대로 옮기고');
    expect(verdict.route).not.toBe('코딩·구현');
    expect(verdict.route).toBe('읽기·분석');
    expect(verdict.goalLoop).toBe(false);
  });

  test('a seat rides the goal loop but stays 읽기·분석', () => {
    expect(classifyTuiChatIntent('도구 쓰지 말고 답해: … 첫 줄을 그대로 옮기고', { seat: true }).route).toBe('읽기·분석');
    expect(classifyTuiChatIntent('도구 쓰지 말고 답해: … 첫 줄을 그대로 옮기고', { seat: true }).goalLoop).toBe(true);
  });

  test('real write verbs still route to 코딩·구현', () => {
    expect(classifyTuiChatIntent('파일을 그대로 옮겨줘').route).toBe('코딩·구현');
    expect(classifyTuiChatIntent('파일을 다른 폴더로 옮기고').route).toBe('코딩·구현');
    expect(classifyTuiChatIntent('지워줘').route).toBe('코딩·구현');
    expect(classifyTuiChatIntent('도구 쓰지 말고 파일을 지워줘').route).toBe('코딩·구현');
    expect(classifyTuiChatIntent('도구 쓰지 말고 답해: 첫 줄을 그대로 옮기고 파일을 지워줘').route).toBe('코딩·구현');
    expect(classifyTuiChatIntent('첫 줄을 그대로 옮기고 다음 명령을 실행해').route).toBe('코딩·구현');
    expect(classifyTuiChatIntent('첫 줄 요약하고 파일을 그대로 옮겨').route).toBe('코딩·구현');
    expect(classifyTuiChatIntent('문서의 첫 줄을 그대로 옮기고').route).toBe('코딩·구현');
    expect(classifyTuiChatIntent('도구 쓰지 말고 첫 줄을 그대로 옮기고').route).toBe('코딩·구현');
    expect(classifyTuiChatIntent('도구 쓰지 말고 답해: 파일의 첫 줄을 그대로 옮기고').route).toBe('읽기·분석');
  });
});
