const CORE_HREFS = ['/term', '/chat', '/intake', '/live', '/editor', '/market', '/setup'] as const;

/** Only input destinations are shown; core follows the onboarding order, more retains menu order. */
export function splitWelcomeRoutes<T extends { href: string }>(items: readonly T[]): { core: T[]; more: T[] } {
  return {
    core: CORE_HREFS.flatMap((href) => items.filter((item) => item.href === href)),
    more: items.filter((item) => !CORE_HREFS.some((href) => href === item.href)),
  };
}
