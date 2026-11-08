const issuedCapabilities = new WeakSet<object>();

export type AppCredentialCapability = object & { readonly __appCredentialCapability?: never };

/** Creates an in-memory credential capability that cannot be reconstructed from stored strings. */
export function createAppCredentialCapability(): AppCredentialCapability {
  const capability = Object.freeze({});
  issuedCapabilities.add(capability);
  return capability as AppCredentialCapability;
}

export function isAppCredentialCapability(value: unknown): value is AppCredentialCapability {
  return typeof value === 'object' && value !== null && issuedCapabilities.has(value);
}
