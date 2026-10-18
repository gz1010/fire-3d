// Links to official pages (owner: official-web): https only, shown as React text + link (CONTRACT §4.4). Anything
// else (http, javascript:, relative or malformed) is dropped rather than rendered.
export function httpsUrl(u: string | null | undefined): string | null {
  if (!u || typeof u !== 'string') return null
  try {
    const url = new URL(u.trim())
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}
