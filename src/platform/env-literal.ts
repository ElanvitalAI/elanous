/** 부분 환경을 일부러 넘긴다. 런타임은 받은 객체 그대로이며, Next 의 NODE_ENV 필수 선언 때문에 단언이 필요하다. */
export function envLiteral(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return values as unknown as NodeJS.ProcessEnv;
}
