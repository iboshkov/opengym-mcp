import fetch from 'node-fetch'
import ssrfFilter from 'ssrf-req-filter'

const MAX_METADATA_BYTES = 32768
const FETCH_TIMEOUT_MS = 10_000

/** The parsed URL if `value` is a usable client metadata document URL (public-style HTTPS with a path), else null. */
export function clientMetadataUrl(value) {
  try {
    const url = new URL(value)
    const usable = url.protocol === 'https:' && !url.username && !url.password && !url.hash && url.pathname !== '/'
    return usable ? url : null
  } catch {
    return null
  }
}

/**
 * Fetch a client metadata document without following redirects.
 * Uses established HTTP and SSRF-filtering libraries: the filtering agent
 * validates the address the connection actually uses, rather than doing a
 * separate, rebindable DNS check.
 */
export async function fetchClientMetadata(value) {
  const url = clientMetadataUrl(value)
  if (!url) throw new Error('A public HTTPS client metadata URL with a path is required.')
  return fetch(url, {
    agent: ssrfFilter(url.href),
    redirect: 'manual',
    size: MAX_METADATA_BYTES,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json' }
  })
}
