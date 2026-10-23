// Telling the user's camera moves from Fire-3d's own (owner: map; brief-3 integration review round 2, R1). MapLibre
// ends a wheel zoom, and any move that a programmatic call stops, without an originalEvent, so MapController also
// looks at input on the map itself: a move that ends while the pointer is down, or within USER_INPUT_MS of an input on
// the map, counts as the user's (it ends the opening framing, an official area's or a fire card's focus hold, and on
// the overview it is the user's view rather than a flight to a fire). Two exceptions:
//  * a click the map handled as a request (a fire's marker or label opens its card and flies there) is not a camera
//    gesture: the input before it no longer counts;
//  * a move that one of our own camera commands ends is ours (restarting an explicit flight with the new safe-area
//    padding stops it first, inside the call; so does an instant flight with reduced motion).
// Without them a click on Little Giant's marker (WA) opened the prepared Lower Sugarloaf Fire nearby instead: the
// card's own layout change restarted the flight within 400 ms of the click, that restart's moveend counted as the
// user's move and ended the 'fire-card' focus hold, and the zoom focus then opened the prepared fire. Pure
// (userInput.test.ts).

/** Input on the map within this time before a move ends means the user took the camera. */
export const USER_INPUT_MS = 400

export class MapInput {
  private down = false
  private lastMs = -Infinity
  private own = 0
  private readonly now: () => number

  constructor(now: () => number = () => performance.now()) {
    this.now = now
  }

  /** A pointer or touch went down on the map. */
  pointerDown(): void {
    this.down = true
    this.lastMs = this.now()
  }

  /** The pointer or touch was released (anywhere), or the window lost focus. */
  pointerUp(): void {
    this.down = false
  }

  /** A wheel or key input on the map. */
  input(): void {
    this.lastMs = this.now()
  }

  /** The click that just ended was handled as a request (a fire's marker or label): it was not a camera gesture. */
  consumeClick(): void {
    if (!this.down) this.lastMs = -Infinity
  }

  /** Run one of our own camera commands: a move that ends inside it is ours, never the user's. */
  ours<T>(fn: () => T): T {
    this.own++
    try {
      return fn()
    } finally {
      this.own--
    }
  }

  /** The user is touching the map, or just gave it an input. */
  get active(): boolean {
    return this.down || this.now() - this.lastMs < USER_INPUT_MS
  }

  /** Whether a move that just ended was the user's: a gesture (MapLibre's originalEvent), or input on the map just
   *  before it, unless one of our own camera commands ended it. */
  endedByUser(gesture: boolean): boolean {
    return gesture || (this.own === 0 && this.active)
  }
}
