import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatMessageView } from './ChatMessage';

const diagnostics = [
  'Error: {"command":"cat /private/token","stdout":"API_TOKEN=secret"}',
  'Error: stdout: API_TOKEN=secret\nraw command output on the next line',
];

for (const minimal of [false, true]) {
  for (const mobileSimple of [false, true]) {
    test(`system error keeps diagnostic out of ${minimal ? 'minimal' : 'wide'} ${mobileSimple ? 'mobile' : 'desktop'} view`, () => {
      for (const text of diagnostics) {
        const html = renderToStaticMarkup(<ChatMessageView
          message={{ id: 'system-error', role: 'system', text, timestamp: 0, meta: { systemLevel: 'error' } }}
          minimal={minimal}
          mobileSimple={mobileSimple}
        />);
        expect(html).toContain('요청을 처리하지 못했습니다.');
        expect(html).not.toContain('API_TOKEN');
        expect(html).not.toContain('command');
        expect(html).not.toContain('stdout');
        expect(html).not.toContain('<details');
        expect(html).not.toContain('text-muted-foreground/80');
      }
    });
    test(`system note preserves text and time in ${minimal ? 'minimal' : 'wide'} ${mobileSimple ? 'mobile' : 'desktop'} view`, () => {
      const html = renderToStaticMarkup(<ChatMessageView
        message={{ id: 'system-note', role: 'system', text: '작업을 다시 시작했습니다.', timestamp: 0, meta: { systemLevel: 'note' } }}
        minimal={minimal}
        mobileSimple={mobileSimple}
      />);
      expect(html).toContain('작업을 다시 시작했습니다.');
      expect(html).not.toContain('요청을 처리하지 못했습니다.');
      if (minimal) {
        expect(html).toContain('<details');
      } else {
        expect(html).toContain('text-muted-foreground/80');
      }
    });
  }
}
