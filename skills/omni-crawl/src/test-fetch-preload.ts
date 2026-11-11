/** Fixed HTTP boundary for the child-process CLI contract test. */
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url === 'https://r.jina.ai/https://example.com/article')
    return new Response('Title: CLI fixture\nMarkdown Content:\nThis fixed article body is long enough to pass the reader content threshold.', { status: 200 });
  throw new Error(`unexpected fetch target: ${url}`);
}) as typeof fetch;
