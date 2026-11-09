export function createAppHostScopedResolver<Value>(create: (appHost?: object) => Value | null): (appHost?: object) => Value | null {
  const unboundKey = {};
  const values = new WeakMap<object, Value | null>();
  return appHost => {
    const key = appHost ?? unboundKey;
    if (values.has(key)) return values.get(key) ?? null;
    const value = create(appHost);
    values.set(key, value);
    return value;
  };
}
