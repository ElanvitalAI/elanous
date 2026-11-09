/** Keep the global test preload's static dependency closure small while preserving its debug event contract. */
export async function logPreloadEvent(event: string, data: unknown): Promise<void> {
  const { debug } = await import('../src/debug/log.js');
  debug.log('test.preload', event, data);
}
