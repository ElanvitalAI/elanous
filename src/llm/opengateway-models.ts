/** First-slice OpenGateway models observed through a successful streamed chat turn. */
export const OPENGATEWAY_VERIFIED_MODELS = [
  'opengateway/deepseek/deepseek-v4.1-flash-ultrafast',
  'opengateway/z-ai/glm-5.3-flash-ultrafast',
] as const;

export const OPENGATEWAY_DEFAULT_MODEL = OPENGATEWAY_VERIFIED_MODELS[0];

export function isVerifiedOpenGatewayModel(model: string): boolean {
  return (OPENGATEWAY_VERIFIED_MODELS as readonly string[]).includes(model);
}
