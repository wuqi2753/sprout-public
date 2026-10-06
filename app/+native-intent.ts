// REQ-040: share intents always return to the capture screen.
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  if (/^[a-z][a-z0-9+.-]*:\/\/expo-sharing(?:[/?#]|$)/i.test(path)) return '/';
  return path;
}
