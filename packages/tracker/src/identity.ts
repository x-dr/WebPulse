const lifetime = 90 * 86400_000;
export const identityStorageKey = (site: string) => `webpulse:${site}:identity`;
export const optOutKey = (site: string) => `webpulse:${site}:opt-out`;
export function removeIdentity(site: string) {
  try {
    localStorage.removeItem(identityStorageKey(site));
  } catch {
    /* Storage may be disabled. */
  }
}
export function optedOut(site: string) {
  try {
    return localStorage.getItem(optOutKey(site)) === '1';
  } catch {
    return false;
  }
}
export function privacyBlocked() {
  return (
    navigator.doNotTrack === '1' ||
    (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true
  );
}
export async function browserIdentity(
  site: string,
  alive: () => boolean,
): Promise<string | undefined> {
  const load = () => {
    if (!alive()) return;
    const now = Date.now();
    try {
      const stored = JSON.parse(localStorage.getItem(identityStorageKey(site)) ?? 'null') as {
        cid?: string;
        created_at?: number;
        expires_at?: number;
      } | null;
      if (
        stored &&
        typeof stored.cid === 'string' &&
        /^[a-f0-9-]{36}$/.test(stored.cid) &&
        typeof stored.created_at === 'number' &&
        typeof stored.expires_at === 'number' &&
        stored.created_at <= now &&
        stored.expires_at > now &&
        stored.expires_at - stored.created_at === lifetime
      )
        return stored.cid;
    } catch {
      /* Memory identity is the only fallback. */
    }
    const cid = crypto.randomUUID();
    try {
      localStorage.setItem(
        identityStorageKey(site),
        JSON.stringify({ cid, created_at: now, expires_at: now + lifetime }),
      );
    } catch {
      /* No fingerprint fallback. */
    }
    return cid;
  };
  return navigator.locks ? navigator.locks.request(identityStorageKey(site), load) : load();
}
