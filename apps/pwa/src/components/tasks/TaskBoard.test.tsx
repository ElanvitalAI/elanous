import { describe, expect, test, spyOn } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { DaemonClient } from '@/lib/daemon-client';
import { boardColumn, cardTitle, foldCard, type TaskCardEntry } from '@/lib/task-card-model';
import type { TaskCardWire } from '@/nexus/client';
import { isSameSelection, cardFromWire, cardsFromEntries, openIncidentCount, TaskBoard, TaskBoardView } from './TaskBoard';

const entries: TaskCardEntry[] = [
  { taskId: 'task-1', section: 'intake', key: 'i1', owner: 'steward', ts: 1700000000000, data: { title: 'Inspect board' } },
  { taskId: 'task-1', section: 'gates', key: 'g1', owner: 'gatekeeper', ts: 1700000001000, runId: '12345678-90ab', data: { budget: 'proceed', location: 'pod' } },
  { taskId: 'task-1', section: 'incidents', key: 'x1', owner: 'operator', ts: 1700000002000, data: { reason: 'quota' } },
];

describe('TaskBoardView detail wiring', () => {
  test('selection renders the production TaskCardDetail; closing removes it', () => {
    const cards = cardsFromEntries(entries);
    const selected = renderToStaticMarkup(<TaskBoardView cards={cards} selectedId="task-1" selectedCard={cards[0]} onSelect={() => {}} />);
    expect(selected).toContain('aria-label="Selected card"');
    expect(selected).toContain('aria-label="Task card detail"');
    expect(selected).toContain('Owner: gatekeeper');
    expect(selected).toContain('Gate · budget: proceed · location: pod');
    expect(selected).toContain('Incidents (1)');
    expect(selected).toContain('12345678');
    const closed = renderToStaticMarkup(<TaskBoardView cards={cards} selectedId={null} onSelect={() => {}} />);
    expect(closed).not.toContain('aria-label="Task card detail"');
    expect(closed).toContain('Inspect board');
  });

  test('does not substitute list data or a different card for pending or failed detail', () => {
    const cards = cardsFromEntries(entries);
    const pending = renderToStaticMarkup(<TaskBoardView cards={cards} selectedId="task-1" onSelect={() => {}} />);
    expect(pending).toContain('Loading card detail…');
    expect(pending).not.toContain('aria-label="Task card detail"');
    const failed = renderToStaticMarkup(<TaskBoardView cards={cards} selectedId="task-1" detailError="Detail unavailable" onSelect={() => {}} />);
    expect(failed).toContain('Detail unavailable');
    expect(failed).not.toContain('aria-label="Task card detail"');
    const mismatched = renderToStaticMarkup(<TaskBoardView cards={cards} selectedId="another-task" selectedCard={cards[0]} onSelect={() => {}} />);
    expect(mismatched).not.toContain('aria-label="Task card detail"');
  });

  test('groups tasks independently before folding sections', () => {
    const other: TaskCardEntry = { ...entries[0]!, taskId: 'task-2', key: 'i2', data: { title: 'Other' } };
    const cards = cardsFromEntries([...entries, other]);
    expect(cards).toHaveLength(2);
    expect(cards[0]?.sections.gates?.key).toBe(foldCard(entries)?.sections.gates?.key);
    expect(cards[1]?.taskId).toBe('task-2');
  });

  test('shows five columns, open incidents, short run id, and update time', () => {
    const cards = cardsFromEntries([...entries,
      { ...entries[2]!, key: 'x2', ts: 1700000003000, data: { status: 'resolved' } },
    ]);
    const markup = renderToStaticMarkup(<TaskBoardView cards={cards} selectedId={null} onSelect={() => {}} />);
    for (const name of ['steward', 'execution', 'landing', 'release', 'done']) {
      expect(markup).toContain(`aria-label="${name} column"`);
    }
    expect(markup).toContain('Inspect board');
    expect(markup).toContain('사고 1 · 런 12345678');
    expect(markup).toContain('2023-11-14T22:13:23.000Z');
    expect(markup).not.toContain('12345678-90ab');
  });

  test('counts the latest state of each incident across open and resolved journal entries', () => {
    const journal: TaskCardEntry[] = [
      { ...entries[2]!, key: 'event-1', ts: 20, data: { incidentId: 'quota', status: 'open' } },
      { ...entries[2]!, key: 'event-2', ts: 30, data: { incidentId: 'pod', status: 'open' } },
      { ...entries[2]!, key: 'event-3', ts: 40, data: { incidentId: 'quota', status: 'resolved' } },
    ];
    const open = cardsFromEntries(journal.slice(0, 2))[0]!;
    const resolved = cardsFromEntries([journal[2]!, journal[1]!, journal[0]!])[0]!;
    expect(openIncidentCount(open)).toBe(2);
    expect(openIncidentCount(resolved)).toBe(1);
    const markup = renderToStaticMarkup(<TaskBoardView cards={[resolved]} selectedId={null} onSelect={() => {}} />);
    expect(markup).toContain('사고 1 ·');
    expect(markup).not.toContain('사고 2 ·');
    const wire: TaskCardWire = {
      id: 'task-1', goalId: 'goal-1', title: 'Incident transitions', status: 'open',
      createdAt: '2023-11-14T22:13:20.000Z',
      sections: [
        { key: 'incidents', owner: 'operator', content: '{"incidentId":"quota","status":"open"}', createdAt: '2023-11-14T22:13:21.000Z' },
        { key: 'incidents', owner: 'operator', content: '{"incidentId":"quota","status":"resolved"}', createdAt: '2023-11-14T22:13:22.000Z' },
      ],
    };
    expect(openIncidentCount(cardFromWire(wire))).toBe(0);
  });

  test('projects the wish reply address from the read-only card journal without treating flow result as a sent reply', () => {
    const wire: TaskCardWire = { id: 'wish-1', goalId: 'wish:pwa:ref', title: '소원', status: 'open',
      createdAt: '2023-11-14T22:13:20.000Z', sections: [
        { key: 'intake:wish:0', owner: 'steward', content: '{"text":"원문"}', createdAt: '2023-11-14T22:13:20.000Z' },
        { key: 'intake:reply:0', owner: 'steward', content: '{"surface":"pwa","address":"session-1"}', createdAt: '2023-11-14T22:13:21.000Z' },
        { key: 'flow:result:0', owner: 'flow', content: '{"text":"전송 전 결과"}', createdAt: '2023-11-14T22:13:22.000Z' },
      ] };
    const card = cardFromWire(wire);
    expect(card.wishReply).toEqual({ surface: 'pwa', address: 'session-1' });
    expect(card).not.toHaveProperty('wishReplyHistory');
    const detail = renderToStaticMarkup(<TaskBoardView cards={[card]} selectedId={card.taskId} selectedCard={card} onSelect={() => {}} />);
    expect(detail).toContain('PWA · session-1');
    expect(detail).not.toContain('전송 전 결과');
    expect(cardFromWire({ ...wire, sections: [] }).wishReply).toBeNull();
  });

  test('loads the list and selected detail via the task-card API', async () => {
    const wire: TaskCardWire = {
      id: 'card-1', goalId: 'goal-1', title: 'Ship it', status: 'open', createdAt: '2023-11-14T22:13:20.000Z', sections: [],
    };
    const calls: string[] = [];
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return Response.json(url.endsWith('/card-1')
        ? { card: { ...wire, sections: [{ key: 'gates', owner: 'gatekeeper', content: '{"budget":"proceed"}', createdAt: wire.createdAt }] } }
        : { cards: [wire] });
    }, { preconnect: fetch.preconnect }));
    const config = { baseUrl: 'http://board.test', token: '', provider: '' };
    const client = new DaemonClient(config);
    let renderer: ReturnType<typeof create> | undefined;
    try {
      await act(async () => {
        renderer = create(<DaemonContext.Provider value={{ config, client, sessionId: '', setConfig: () => {}, setSessionId: () => {} }}>
          <TaskBoard />
        </DaemonContext.Provider>);
      });
      expect(calls).toEqual(['http://board.test/v1/task-cards']);
      await act(async () => { renderer!.root.findByType('button').props.onClick(); });
      expect(calls).toEqual(['http://board.test/v1/task-cards', 'http://board.test/v1/task-cards/card-1']);
      expect(renderer!.root.findByProps({ 'aria-label': 'Gate decisions' })).toBeDefined();
    } finally {
      await act(async () => { renderer?.unmount(); });
      fetchMock.mockRestore();
    }
  });

  test('opens a wish card with the placement and progress from the detail API', async () => {
    const wire: TaskCardWire = { id: 'wish-1', goalId: 'wish:one', title: '소원', status: 'open',
      createdAt: '2023-11-14T22:13:20.000Z', sections: [] };
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: RequestInfo | URL) =>
      Response.json(String(input).endsWith('/wish-1')
        ? { card: wire, placements: [{ cellId: 'C1', cellTitle: '첫 칸', version: '0.2.14', status: 'yellow' }] }
        : { cards: [wire] }), { preconnect: fetch.preconnect }));
    const config = { baseUrl: 'http://board.test', token: '', provider: '' };
    const client = new DaemonClient(config);
    let renderer: ReturnType<typeof create> | undefined;
    try {
      await act(async () => {
        renderer = create(<DaemonContext.Provider value={{ config, client, sessionId: '', setConfig: () => {}, setSessionId: () => {} }}>
          <TaskBoard />
        </DaemonContext.Provider>);
      });
      await act(async () => { renderer!.root.findByType('button').props.onClick(); });
      const line = renderer!.root.findByProps({ 'aria-label': 'Wish placement and progress' });
      expect(line.props.children).toContain('C1 첫 칸 · 0.2.14판 · 진행 중');
    } finally {
      await act(async () => { renderer?.unmount(); });
      fetchMock.mockRestore();
    }
  });

  test('keeps list content out of detail while fetching and after the detail API fails', async () => {
    const wire: TaskCardWire = {
      id: 'card-1', goalId: 'goal-1', title: 'List-only title', status: 'open', createdAt: '2023-11-14T22:13:20.000Z',
      sections: [{ key: 'gates', owner: 'list-only owner', content: '{"budget":"stale"}', createdAt: '2023-11-14T22:13:20.000Z' }],
    };
    let rejectDetail!: (reason: Error) => void;
    const pendingDetail = new Promise<Response>((_resolve, reject) => { rejectDetail = reject; });
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: RequestInfo | URL) =>
      String(input).endsWith('/card-1') ? pendingDetail : Response.json({ cards: [wire] }),
    { preconnect: fetch.preconnect }));
    const config = { baseUrl: 'http://board.test', token: '', provider: '' };
    const client = new DaemonClient(config);
    let renderer: ReturnType<typeof create> | undefined;
    try {
      await act(async () => {
        renderer = create(<DaemonContext.Provider value={{ config, client, sessionId: '', setConfig: () => {}, setSessionId: () => {} }}>
          <TaskBoard />
        </DaemonContext.Provider>);
      });
      await act(async () => { renderer!.root.findByType('button').props.onClick(); });
      expect(renderer!.root.findByProps({ 'aria-label': 'Selected card' }).findByProps({ role: 'status' }).props.children)
        .toBe('Loading card detail…');
      expect(renderer!.root.findAllByProps({ 'aria-label': 'Task card detail' })).toHaveLength(0);
      await act(async () => { rejectDetail(new Error('Detail unavailable')); });
      expect(renderer!.root.findByProps({ 'aria-label': 'Selected card' }).findByProps({ role: 'status' }).props.children)
        .toBe('Detail unavailable');
      expect(renderer!.root.findAllByProps({ 'aria-label': 'Task card detail' })).toHaveLength(0);
    } finally {
      await act(async () => { renderer?.unmount(); });
      fetchMock.mockRestore();
    }
  });

  test('shows pre-E1 only on list 404, and keeps other errors distinct', async () => {
    const responses = [new Response('{"error":"not_found"}', { status: 404 }),
      new Response('{"error":"unauthorized"}', { status: 401 })];
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => responses.shift()!,
      { preconnect: fetch.preconnect }));
    const config = { baseUrl: 'http://board.test', token: '', provider: '' };
    const client = new DaemonClient(config);
    let renderer: ReturnType<typeof create> | undefined;
    try {
      await act(async () => {
        renderer = create(<DaemonContext.Provider value={{ config, client, sessionId: '', setConfig: () => {}, setSessionId: () => {} }}>
          <TaskBoard />
        </DaemonContext.Provider>);
      });
      expect(renderer!.root.findByProps({ role: 'status' }).props.children).toContain('pre-E1');
      await act(async () => { renderer!.unmount(); });
      await act(async () => {
        renderer = create(<DaemonContext.Provider value={{ config, client, sessionId: '', setConfig: () => {}, setSessionId: () => {} }}>
          <TaskBoard />
        </DaemonContext.Provider>);
      });
      expect(renderer!.root.findByProps({ role: 'status' }).props.children).toContain('401');
      expect(renderer!.root.findByProps({ role: 'status' }).props.children).not.toContain('pre-E1');
    } finally {
      await act(async () => { renderer?.unmount(); });
      fetchMock.mockRestore();
    }
  });

  test('keeps the API title when the latest triage and intake sections have no title', () => {
    const wire: TaskCardWire = {
      id: 'card-untitled', goalId: 'goal-1', title: 'API title', status: 'open',
      createdAt: '2023-11-14T22:13:20.000Z',
      sections: [
        { key: 'triage', owner: 'steward', content: '{"priority":"high"}', createdAt: '2023-11-14T22:13:22.000Z' },
        { key: 'intake', owner: 'steward', content: '{"source":"request"}', createdAt: '2023-11-14T22:13:23.000Z' },
      ],
    };
    const card = cardFromWire(wire);
    expect(card.sections.triage?.data.priority).toBe('high');
    expect(card.sections.intake?.data.source).toBe('request');
    expect(cardTitle(card)).toBe('API title');
    expect(cardTitle(cardFromWire({ ...wire, sections: [
      ...wire.sections,
      { key: 'triage', owner: 'steward', content: '{"title":"Journal title"}', createdAt: '2023-11-14T22:13:24.000Z' },
    ] }))).toBe('Journal title');
    expect(renderToStaticMarkup(<TaskBoardView cards={[card]} selectedId={null} onSelect={() => {}} />))
      .toContain('API title');
  });

  test('converts API sections and status to the card model without losing the title or run id', () => {
    const wire: TaskCardWire = {
      id: 'card-1', goalId: 'goal-1', title: 'Ship it', status: 'open', createdAt: '2023-11-14T22:13:20.000Z',
      sections: [
        { key: 'gates', owner: 'gatekeeper', content: '{"budget":"proceed","runId":"abc123456789"}', createdAt: '2023-11-14T22:13:21.000Z' },
        { key: 'incidents', owner: 'operator', content: '{"reason":"quota"}', createdAt: '2023-11-14T22:13:22.000Z' },
      ],
    };
    const card = cardFromWire(wire);
    expect(cardTitle(card)).toBe('Ship it');
    expect(card.sections.gates?.owner).toBe('gatekeeper');
    expect(card.runId).toBe('abc123456789');
    expect(card.incidents).toHaveLength(1);
    expect(boardColumn(card)).toBe('execution');
    const closed = cardFromWire({ ...wire, status: 'closed' });
    expect(boardColumn(closed)).toBe('done');
    expect(renderToStaticMarkup(<TaskBoardView cards={[closed]} selectedId={null} onSelect={() => {}} />))
      .toContain('abc12345');
  });
});

describe('same-card reselect (review R3)', () => {
  test('re-clicking the selected card is ignored; a different card or close is not', () => {
    expect(isSameSelection('task-1', 'task-1')).toBe(true);
    expect(isSameSelection('task-1', 'task-2')).toBe(false);
    expect(isSameSelection(null, 'task-1')).toBe(false);
    expect(isSameSelection('task-1', null)).toBe(false);
  });
});
