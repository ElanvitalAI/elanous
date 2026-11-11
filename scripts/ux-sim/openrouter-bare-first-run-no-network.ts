/** Preload for the isolated manual PTY receipt. Never forward a request to the network. */
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === 'https://openrouter.ai/api/v1/key') {
    process.stderr.write('PTY_FAKE_FETCH openrouter key verification\n');
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  process.stderr.write('PTY_FAKE_FETCH blocked other network request\n');
  throw new Error('test-world network blocked');
}, {
  preconnect: () => { throw new Error('test-world network blocked'); },
});
