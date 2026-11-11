/** Solar Pro 4 uses OpenRouter's model id on the app side and the bare id on the wire. */
export function isSolarPro4Model(model: string | undefined): boolean {
  return /^(?:openrouter\/)?upstage\/solar-pro4$/i.test(model ?? '');
}

/** Reproduce the pre-optimization request from the same commit during an A/B run. */
export function solarOptimizationEnabled(): boolean {
  return process.env.ELANOUS_SOLAR_OPTIMIZE !== '0';
}

export const SOLAR_CHAT_VARIANT = `## Provider variant: solar

- Answer in the user's language; keep Korean terms and names exact when the request is Korean.
- Use supplied tools for facts you can verify. Give each tool its declared JSON arguments without prose or code fences.
- When a JSON schema is requested, return only a value that matches it.
- Keep the final answer brief. State missing evidence plainly instead of filling it in.
`;
