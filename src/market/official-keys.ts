/** Public keys that sign the official Elanous marketplace index (signed-index SPEC §3). The private key stays offline
 *  on the owner's machine. Clients trust these by default; `market.trustedKeys` in config may add keys (rotation overlap). */
export const OFFICIAL_INDEX_KEYS: ReadonlyArray<{ keyId: string; publicKey: string }> = [
  { keyId: '4d809b69', publicKey: 'iNHq4yuuJNuB6BSDyAZhcYvaGTImtOGfbIPGUg4EbNQ=' },
];
