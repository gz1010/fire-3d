// Server rendering in unit tests (react-dom/server, no DOM): zustand's hooks read a store's *initial* state while
// rendering on the server (useSyncExternalStore's server snapshot), so a test that renders markup must set both the
// current and the initial state. `ssrState` does that and returns a function that restores the initial state.
interface StoreLike<T> {
  getState(): T
  getInitialState(): T
  setState(partial: Partial<T>): void
}

const restores: Array<() => void> = []

/** Set `patch` on the store for a server render; undone by `restoreSsrState()` (call it in afterEach). */
export function ssrState<T extends object>(store: StoreLike<T>, patch: Partial<T>): void {
  const init = store.getInitialState() as Record<string, unknown>
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, init[k]]))
  Object.assign(init, patch)
  store.setState(patch)
  restores.push(() => Object.assign(init, saved))
}

/** Undo every `ssrState` call (latest first). */
export function restoreSsrState(): void {
  while (restores.length) restores.pop()?.()
}
