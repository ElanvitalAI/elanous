import { createRequire } from 'node:module';

type TypeScriptApi = typeof import('typescript');

const require = createRequire(import.meta.url);
let loaded: TypeScriptApi | undefined;

const typescript = new Proxy({} as TypeScriptApi, {
  get(_target, property) {
    loaded ??= require('typescript') as TypeScriptApi;
    return loaded[property as keyof TypeScriptApi];
  },
});

export default typescript;
