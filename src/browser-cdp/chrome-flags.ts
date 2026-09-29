// A Chrome launched with a fresh --user-data-dir tries to create «Chrome Safe Storage» in the macOS
// keychain. Headless or temporary profiles cannot, so Chrome pops «Keychain Not Found» on the human's
// screen (09-28: dozens of popups from headless recorders and CDP clients). These two official flags
// keep secrets in a per-profile mock store instead. Every launch that sets --user-data-dir must pass
// them — including the visible sign-in window for a persistent profile, so later headless launches
// can still decrypt the same profile's cookies (the key must not change between launches).
export const CHROME_NO_KEYCHAIN_FLAGS = ['--use-mock-keychain', '--password-store=basic'] as const;
