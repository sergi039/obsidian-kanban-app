/** The browser's localStorage, or undefined where it is unavailable (private/locked-down contexts). */
export function browserStorage(): Storage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}
