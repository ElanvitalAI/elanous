import { expect, test, spyOn } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { DaemonProvider } from '@/components/providers/DaemonProvider';
import * as workspace from './WorkspaceProvider';
import { WorkspaceCanvas } from './WorkspaceCanvas';

test('workspace intake tab prerenders the front door without the legacy panel or a daemon connection', () => {
  const workspaceSpy = spyOn(workspace, 'useWorkspace').mockReturnValue({
    state: {
      tabs: [{ id: 'intake-tab', kind: 'intake', createdAt: 0 }],
      order: ['intake-tab'],
      activeId: 'intake-tab',
      frozenIds: [],
    },
    addTab: () => 'intake-tab',
    closeTab: () => {},
    activateTab: () => {},
    reorderTab: () => {},
    updateChatTab: () => {},
    activateOrAdd: () => 'intake-tab',
    pickerMode: null,
    openPicker: () => {},
    closePicker: () => {},
  });
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(
    async (..._args: Parameters<typeof fetch>): Promise<Response> => {
      throw new Error('prerender must not request a daemon');
    },
    { preconnect: () => {} },
  ));

  try {
    let html = '';
    expect(() => {
      html = renderToStaticMarkup(
        <DaemonProvider>
          <WorkspaceCanvas />
        </DaemonProvider>,
      );
    }).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(html).toContain('data-tab-id="intake-tab"');
    expect(html).toContain('data-testid="intake-front-door-field"');
    expect(html).not.toContain('No intake sessions found.');
    expect(html).not.toContain('Capture a new intake note');
  } finally {
    workspaceSpy.mockRestore();
    fetchSpy.mockRestore();
  }
});
