import { expect, test } from 'bun:test';
import { createFakeAppHost } from '../../ux-sim/fake-app-host.js';
import { applyMadeWithBadge, MADE_WITH_BADGE_ENTITLEMENT } from './made-with-badge.js';

test('free app simulation places one made-with badge at the bottom and remains idempotent', () => {
  const appHost = createFakeAppHost([{ slug: 'notes', versions: [{ id: 'v1', files: {
    'index.html': '<!doctype html><html><body><main>hello</main></body></html>',
  } }] }]);
  appHost.deploy('notes', 'v1');
  const hosted = appHost.fetch('notes.app.sim.invalid', '/index.html');
  expect(hosted.status).toBe(200);

  const decorated = applyMadeWithBadge(hosted.body);
  expect(decorated).toBe('<!doctype html><html><body><main>hello</main><footer data-elanous-made-with-badge="true" class="elanous-made-with-badge" style="all:revert!important;display:block!important;font:14px/1.4 sans-serif!important;color:#555!important;background:transparent!important;height:auto!important;max-height:none!important;min-height:1em!important;overflow:visible!important;width:auto!important;max-width:100%!important;text-indent:0!important;visibility:visible!important;opacity:1!important;position:static!important;clip:auto!important;clip-path:none!important;transform:none!important">made with elanous</footer></body></html>');
  expect(applyMadeWithBadge(decorated)).toBe(decorated);
});

test('managed app simulation removes the owned badge when its plan entitlement is disabled', () => {
  const appHost = createFakeAppHost([{ slug: 'notes', versions: [{ id: 'v1', files: {
    'index.html': '<html><body><main>managed</main><footer data-elanous-made-with-badge="true">old</footer></body></html>',
  } }] }]);
  appHost.deploy('notes', 'v1');
  const hosted = appHost.fetch('notes.app.sim.invalid', '/index.html');
  // Source: 내부 문서 `nexus-revenue-and-market` §2⑤ — the managed plan disables free attribution.
  const entitlements = { [MADE_WITH_BADGE_ENTITLEMENT]: 0 };

  const decorated = applyMadeWithBadge(hosted.body, entitlements);
  expect(decorated).toContain('<main>managed</main>');
  expect(decorated).not.toContain('made-with-badge');
  expect(decorated).not.toContain('made with elanous');
});

test('owned badge is kept singular without removing app content', () => {
  const source = '<html><body><main>made with elanous is user content</main></body></html>';
  const decorated = applyMadeWithBadge(source);
  expect(applyMadeWithBadge(decorated)).toBe(decorated);
  expect(decorated).toContain('<main>made with elanous is user content</main>');
});

test('unterminated owned footer cleanup preserves following app content', () => {
  const source = '<html><body><footer data-elanous-made-with-badge="true">old badge<main>keep app content</main></body></html>';
  // Source: 내부 문서 `nexus-revenue-and-market` §2⑤ — managed plan disables attribution.
  const managedEntitlements = { [MADE_WITH_BADGE_ENTITLEMENT]: 0 };
  const managed = applyMadeWithBadge(source, managedEntitlements);
  expect(managed).toContain('<main>keep app content</main>');
  expect(managed).not.toContain('made-with-badge');
  expect(managed).not.toContain('old badge');

  const free = applyMadeWithBadge(source);
  expect(free).toContain('<main>keep app content</main>');
  expect(free.match(/<footer[^>]*class="elanous-made-with-badge"/g)).toHaveLength(1);
  expect(free).not.toContain('old badge');
});

test('a slash on a non-void owned footer does not preserve its old contents', () => {
  const source = '<html><body><main>keep app content</main><footer data-elanous-made-with-badge="true"/>old badge</footer></body></html>';
  // Source: 내부 문서 `nexus-revenue-and-market` §2⑤ — managed plan disables attribution.
  const managedEntitlements = { [MADE_WITH_BADGE_ENTITLEMENT]: 0 };
  const managed = applyMadeWithBadge(source, managedEntitlements);
  expect(managed).toContain('<main>keep app content</main>');
  expect(managed).not.toContain('old badge');
  expect(managed).not.toContain('made-with-badge');

  const free = applyMadeWithBadge(source);
  expect(free).toContain('<main>keep app content</main>');
  expect(free).not.toContain('old badge');
  expect(free.match(/<footer[^>]*class="elanous-made-with-badge"/g)).toHaveLength(1);
});

test('existing owned marker is recognized across attribute order and quote styles', () => {
  const source = '<html><body><!-- <footer data-elanous-made-with-badge="true">comment</footer> --><script>"<footer data-elanous-made-with-badge=\\"true\\">script</footer>"</script><footer title=\' data-elanous-made-with-badge="true" \' >keep</footer><footer class="x" data-elanous-made-with-badge=\'true\'>made with elanous</footer></body></html>';
  const decorated = applyMadeWithBadge(source);
  expect(decorated).toContain('<!-- <footer data-elanous-made-with-badge="true">comment</footer> -->');
  expect(decorated).toContain('<script>"<footer data-elanous-made-with-badge=\\"true\\">script</footer>"</script>');
  expect(decorated).toContain('<footer title=\' data-elanous-made-with-badge="true" \' >keep</footer>');
  expect(decorated.match(/<footer[^>]*class="elanous-made-with-badge"/g)).toHaveLength(1);
  expect(decorated).toContain('height:auto!important;max-height:none!important;min-height:1em!important;overflow:visible!important');
  expect(decorated).toContain('>made with elanous</footer>');
  expect(applyMadeWithBadge(decorated)).toBe(decorated);
});

test('free badge insertion respects xmp raw-text boundaries', () => {
  const source = '<html><body><xmp>example </body> text</xmp></body></html>';
  expect(applyMadeWithBadge(source))
    .toBe('<html><body><xmp>example </body> text</xmp><footer data-elanous-made-with-badge="true" class="elanous-made-with-badge" style="all:revert!important;display:block!important;font:14px/1.4 sans-serif!important;color:#555!important;background:transparent!important;height:auto!important;max-height:none!important;min-height:1em!important;overflow:visible!important;width:auto!important;max-width:100%!important;text-indent:0!important;visibility:visible!important;opacity:1!important;position:static!important;clip:auto!important;clip-path:none!important;transform:none!important">made with elanous</footer></body></html>');
});

test('body close tags inside template content do not take the insertion point', () => {
  const source = '<html><body><main>app</main><template><div></body></div></template></body></html>';
  const decorated = applyMadeWithBadge(source);
  expect(decorated.indexOf('class="elanous-made-with-badge"')).toBeGreaterThan(decorated.indexOf('</template>'));
  expect(decorated).toContain('<template><div></body></div></template>');
});

test('free badge is inserted before the real body close, not a comment or script string', () => {
  const source = '<html><body><script>const close = "</body>";</script><!-- </body> --><main>app</main></body></html>';
  const decorated = applyMadeWithBadge(source);
  expect(decorated).toBe('<html><body><script>const close = "</body>";</script><!-- </body> --><main>app</main><footer data-elanous-made-with-badge="true" class="elanous-made-with-badge" style="all:revert!important;display:block!important;font:14px/1.4 sans-serif!important;color:#555!important;background:transparent!important;height:auto!important;max-height:none!important;min-height:1em!important;overflow:visible!important;width:auto!important;max-width:100%!important;text-indent:0!important;visibility:visible!important;opacity:1!important;position:static!important;clip:auto!important;clip-path:none!important;transform:none!important">made with elanous</footer></body></html>');
});

test('invalid whitespace after a raw-text end-tag slash cannot break script contents', () => {
  const source = '<html><body><script>const example = "</ script></body>";';
  const decorated = applyMadeWithBadge(source);
  expect(decorated).toContain('<script>const example = "</ script></body>";');
  expect(decorated.indexOf('class="elanous-made-with-badge"')).toBeLessThan(decorated.indexOf('<script>'));
});

test('badge insertion closes an unclosed hidden wrapper before the footer', () => {
  const source = '<html><body><div style="display:none"><main>app</main></body></html>';
  const decorated = applyMadeWithBadge(source);
  expect(decorated).toContain('</main></div><footer data-elanous-made-with-badge="true"');
  expect(decorated).toContain('>made with elanous</footer></body></html>');
});

test('badge stays outside hidden wrappers when the body has no closing tag', () => {
  const source = '<body><div hidden><main>app</main>';
  const decorated = applyMadeWithBadge(source);
  expect(decorated).toContain('<body><div hidden><main>app</main></div><footer data-elanous-made-with-badge="true"');
  expect(decorated).toContain('>made with elanous</footer>');
});

test('textarea slash is ignored so owned-looking user examples stay raw text', () => {
  const source = '<html><body><textarea/><footer data-elanous-made-with-badge="true">example</footer></textarea></body></html>';
  const free = applyMadeWithBadge(source);
  expect(free).toContain('<textarea/><footer data-elanous-made-with-badge="true">example</footer></textarea>');
  expect(free.match(/<footer[^>]*class="elanous-made-with-badge"/g)).toHaveLength(1);

  // Source: 내부 문서 `nexus-revenue-and-market` §2⑤ — managed plans hide only the real attribution.
  const managedEntitlements = { [MADE_WITH_BADGE_ENTITLEMENT]: 0 };
  const managed = applyMadeWithBadge(source, managedEntitlements);
  expect(managed).toContain('<textarea/><footer data-elanous-made-with-badge="true">example</footer></textarea>');
  expect(managed.match(/<footer[^>]*class="elanous-made-with-badge"/g)).toBeNull();
});

test('badge falls back to the HTML root or document end when body is absent', () => {
  expect(applyMadeWithBadge('<html><head></head></html>'))
    .toBe('<html><head></head><footer data-elanous-made-with-badge="true" class="elanous-made-with-badge" style="all:revert!important;display:block!important;font:14px/1.4 sans-serif!important;color:#555!important;background:transparent!important;height:auto!important;max-height:none!important;min-height:1em!important;overflow:visible!important;width:auto!important;max-width:100%!important;text-indent:0!important;visibility:visible!important;opacity:1!important;position:static!important;clip:auto!important;clip-path:none!important;transform:none!important">made with elanous</footer></html>');
  expect(applyMadeWithBadge('<main>fragment</main>'))
    .toBe('<main>fragment</main><footer data-elanous-made-with-badge="true" class="elanous-made-with-badge" style="all:revert!important;display:block!important;font:14px/1.4 sans-serif!important;color:#555!important;background:transparent!important;height:auto!important;max-height:none!important;min-height:1em!important;overflow:visible!important;width:auto!important;max-width:100%!important;text-indent:0!important;visibility:visible!important;opacity:1!important;position:static!important;clip:auto!important;clip-path:none!important;transform:none!important">made with elanous</footer>');
});

test('plaintext pages get the visible badge immediately before their raw-text region', () => {
  const source = '<html><body><main>content</main><plaintext>text </body></plaintext></html>';
  const decorated = applyMadeWithBadge(source);
  expect(decorated.indexOf('class="elanous-made-with-badge"')).toBeLessThan(decorated.indexOf('<plaintext>'));
  expect(decorated).toContain('<plaintext>text </body></plaintext></html>');
});

test('overlapping owned footer markers do not remove following app content', () => {
  const source = '<html><body><footer data-elanous-made-with-badge="true"><footer data-elanous-made-with-badge="true">nested</footer></footer><main>keep me</main></body></html>';
  const decorated = applyMadeWithBadge(source);
  expect(decorated).toContain('<main>keep me</main>');
  expect(decorated.match(/<footer[^>]*class="elanous-made-with-badge"/g)).toHaveLength(1);
  expect(applyMadeWithBadge(decorated)).toBe(decorated);
});
