import { describe, it, expect, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChatCliCommand, toDevChatOpts, type ChatCliDeps } from './chat-cli.js';
import { SOLAR_SCENE5_QUESTION, parseSolarScene4Receipt } from './solar-scene5-context.js';
import type { runDevPipeline, DevPipelineSpec, DevPipelineDeps, DevChatOpts, ResolvedDevPlan } from '../self-dev/dev-pipeline.js';

describe('toDevChatOpts — CLI 옵션 → DevChatOpts 매핑(무손실)', () => {
  it('--new→forceNew · json/tools/goalLoop→boolean · session 통과', () => {
    expect(toDevChatOpts({ session: 's1', new: true, json: true, tools: true, goalLoop: true }))
      .toEqual({ session: 's1', forceNew: true, continueActive: false, json: true, enableTools: true, goalLoop: true });
  });
  it('옵션 없음 → 전부 false · session 생략(undefined)', () => {
    expect(toDevChatOpts({})).toEqual({ forceNew: false, continueActive: false, json: false, enableTools: false, goalLoop: false });
  });
  it('#73 — 이어하기는 명시만: --continue · 값 없는 --resume → continueActive · --resume <id> → session', () => {
    expect(toDevChatOpts({ continue: true }).continueActive).toBe(true);
    expect(toDevChatOpts({ resume: true }).continueActive).toBe(true);
    expect(toDevChatOpts({ resume: 'abc123' })).toMatchObject({ session: 'abc123', continueActive: false });
    expect(toDevChatOpts({ session: 's1', resume: 'other' }).session).toBe('s1');
    // 반증: 인자 없음은 이어하지 않는다.
    expect(toDevChatOpts({}).continueActive).toBe(false);
  });
  it('빈 문자열 session 도 통과(!== undefined·원 explicitSessionId 정확 등가)', () => {
    expect(toDevChatOpts({ session: '' }).session).toBe(''); // 누락 아님 — 중간값까지 무손실
  });
});

describe('runChatCliCommand — interactive 재라우팅 글루', () => {
  it('interactive spec 빌드 + runChatTurn 을 runDevPipeline deps 로 주입', async () => {
    let gotSpec: DevPipelineSpec | undefined;
    let gotDeps: DevPipelineDeps | undefined;
    const runChatTurn = async (): Promise<void> => {};
    const fakeRun = (async (spec: DevPipelineSpec, deps: DevPipelineDeps) => {
      gotSpec = spec; gotDeps = deps;
      return { plan: {} as ResolvedDevPlan, kind: 'interactive' as const, result: null };
    }) as typeof runDevPipeline;
    await runChatCliCommand('hi', { new: true, tools: true }, { runChatTurn, runDevPipeline: fakeRun });
    expect(gotSpec).toEqual({
      input: { text: 'hi' },
      executor: { kind: 'self' },
      context: 'interactive',
      chat: { forceNew: true, continueActive: false, json: false, enableTools: true, goalLoop: false },
    });
    expect(gotDeps?.runChatTurn).toBe(runChatTurn); // 주입된 chat 엔진 그대로 전달
  });

  it('chat --json: CLI 진행 줄은 stderr, stdout은 JSON 한 줄만', async () => {
    let stdout = '';
    let stderr = '';
    const stdoutWrite = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    const stderrWrite = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    try {
      await runChatCliCommand('hello', { json: true }, {
        runChatTurn: async (_text, chat) => {
          expect(chat.json).toBe(true);
          process.stdout.write(JSON.stringify({ sessionId: 's1', reply: 'hello' }) + '\n');
        },
      });
      expect(stdout.split('\n').filter(Boolean)).toHaveLength(1);
      expect(JSON.parse(stdout.trim())).toEqual({ sessionId: 's1', reply: 'hello' });
      // CHAT1 — a plain chat turn is not a dev run: no dev completion/base lines on either stream.
      expect(stderr).not.toContain('[dev]');
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }
  });

  it('plain chat prints no dev-run progress lines (CHAT1)', async () => {
    const stdoutLines: string[] = [];
    let stderr = '';
    const consoleLog = spyOn(console, 'log').mockImplementation((line) => { stdoutLines.push(String(line)); });
    const stderrWrite = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    try {
      await runChatCliCommand('hello', {}, { runChatTurn: async () => {} });
      expect(stdoutLines.join('\n')).not.toContain('[dev]');
      expect(stderr).not.toContain('[dev]');
    } finally {
      consoleLog.mockRestore();
      stderrWrite.mockRestore();
    }
  });

  it('실 runDevPipeline 경유 e2e — runChatTurn 이 text+매핑된 chat 으로 호출됨', async () => {
    let gotText: string | undefined;
    let gotChat: DevChatOpts | undefined;
    const deps: ChatCliDeps = { runChatTurn: async (text, chat) => { gotText = text; gotChat = chat; } };
    await runChatCliCommand('실제 텍스트', { session: 'sX', goalLoop: true }, deps);
    expect(gotText).toBe('실제 텍스트');
    expect(gotChat).toEqual({ session: 'sX', forceNew: false, continueActive: false, json: false, enableTools: false, goalLoop: true });
  });
});

describe('Solar demo scene 5 prior-scene receipt', () => {
  it('sends the preceding graph receipt through the real chat dispatch and removes the no-context reply', async () => {
    const root = mkdtempSync(join(tmpdir(), 'solar-scene5-'));
    const file = join(root, 'scene4.json');
    writeFileSync(file, JSON.stringify({
      graphId: 'demo-graph', runId: 'run-42', status: 'done', path: ['prepare', 'finish'],
      nodes: [
        { nodeId: 'prepare', ok: true, executed: true, output: { secret: 'DO_NOT_SEND' } },
        { nodeId: 'finish', ok: true, executed: false },
      ],
    }));
    const replies: string[] = [];
    const runChatTurn = async (text: string): Promise<void> => {
      replies.push(text.includes('graphId: demo-graph') && text.includes('runId: run-42')
        ? '확인: 그래프 run-42 완료. 미확인: Solar 모델 호출.'
        : '맥락 없음');
      if (text.includes('graphId: demo-graph')) {
        expect(text).toContain(SOLAR_SCENE5_QUESTION);
        expect(text).toContain('finish: 실행 안 됨');
        expect(text).toContain('장면 1~3의 결과');
        expect(text).not.toContain('DO_NOT_SEND');
      }
    };
    try {
      await runChatCliCommand(SOLAR_SCENE5_QUESTION, {}, { runChatTurn });
      await runChatCliCommand('', { solarScene5Receipt: file }, { runChatTurn });
      expect(replies).toEqual(['맥락 없음', '확인: 그래프 run-42 완료. 미확인: Solar 모델 호출.']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dispatches a valid graph receipt even when excluded raw node output is large', async () => {
    expect(() => parseSolarScene4Receipt({ status: 'done', path: [], nodes: [] })).toThrow('graphId');
    const root = mkdtempSync(join(tmpdir(), 'solar-scene5-'));
    const file = join(root, 'large.json');
    try {
      // Source: Terra review of #36745 — raw node output can exceed the former 1 MiB file cap.
      const largeOutput = 'RAW_NODE_OUTPUT_MUST_STAY_OUT_OF_PROMPT'.repeat(40000);
      writeFileSync(file, JSON.stringify({
        graphId: 'large-graph', runId: 'large-run', status: 'done', path: ['run'],
        nodes: [{ nodeId: 'run', ok: true, executed: true, output: largeOutput }],
      }));
      let dispatched = false;
      await runChatCliCommand('', { solarScene5Receipt: file }, {
        runChatTurn: async text => {
          dispatched = true;
          expect(text).toContain('graphId: large-graph');
          expect(text).toContain('run: 실행 성공');
          expect(text).not.toContain('RAW_NODE_OUTPUT_MUST_STAY_OUT_OF_PROMPT');
          expect(text.length).toBeLessThan(largeOutput.length);
        },
      });
      expect(dispatched).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
