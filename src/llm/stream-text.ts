/** Filter a streamChat generator down to text deltas — lets providers
 *  keep streamChat as the single source of truth and derive chat(). */
export async function* textOnly<T extends { type: string; delta?: string }>(events: AsyncGenerator<T, void, unknown>): AsyncGenerator<string, void, unknown> {
  for await (const ev of events) {
    if (ev.type === 'text' && ev.delta) yield ev.delta;
  }
}

