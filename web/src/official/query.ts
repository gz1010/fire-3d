// JSON queries of the official sources (owner: official-web): the shared per-URL cache of extras/jsonQuery.ts, so
// re-focusing a fire shows its CAL FIRE record and NWS alerts at once, a request for a fire that is no longer open is
// aborted, and an answer is only ever shown for its own URL (fire, time). Same state shape as the extras hooks.
import type { ExtrasQueryState } from '../extras/hooks'
import { useCachedJsonQuery } from '../extras/jsonQuery'

export type QueryState<T> = ExtrasQueryState<T>

/** `url` null = idle. `refreshMs`: the source's cadence (cached answers younger than it are reused; current answers,
 *  per `isCurrent`, are refetched on it); 0 = never refreshed. */
export function useJsonQuery<T>(url: string | null, opts: { refreshMs: number; timeoutMs?: number; isCurrent?: (data: T) => boolean }): QueryState<T> {
  return useCachedJsonQuery<T>(url, opts)
}
