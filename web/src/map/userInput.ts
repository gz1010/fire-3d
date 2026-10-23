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
// user's move and ended the 'fire-card' focus hold, and the zoom focus then opened the prepared fire.
// A move is also the user's when it STARTED as theirs (review round 3): MapLibre ends a single wheel notch's zoom about
// 400-450 ms after the wheel event (much later on a slow renderer), at or past USER_INPUT_MS, so the moveend alone did
// not count it and a fire card's hold survived the user's zoom. The controller reports every movestart: one with a
// gesture, or one outside our own commands while the pointer is down, within USER_INPUT_MS of an input, or as the
// first move after a wheel or key input (MapLibre starts the zoom a frame or more later; INPUT_MOVE_START_MS), makes
// that move the user's until its moveend. A movestart inside one of our own camera commands is ours and clears it:
// every camera command of the controller runs in `ours`. Pure (userInput.test.ts).

/** Input on the map within this time before a move ends means the user took the camera. */
export const USER_INPUT_MS = 400
/** A wheel or key input waits this long for the move MapLibre starts for it (a frame or more later; slow renderers). */
export const INPUT_MOVE_START_MS = 3000

export class MapInput {
  private down = false
  private lastMs = -Infinity
  private own = 0
  /** When a wheel or key input not yet followed by a movestart came: the move MapLibre starts for it is the user's. */
  private pendingMs = -Infinity
  /** The move in progress started as the user's (see moveStart). */
  private userMove = false
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
    this.pendingMs = this.lastMs
  }

  /** The click that just ended was handled as a request (a fire's marker or label): it was not a camera gesture. */
  consumeClick(): void {
    if (this.down) return
    this.lastMs = -Infinity
    this.pendingMs = -Infinity
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

  /** A move starts (MapLibre's movestart; `gesture`: it carries an originalEvent). It is the user's until its moveend
   *  when it is a gesture, or starts outside our own commands while the user is touching the map, just gave it an
   *  input, or has a wheel or key input waiting for its move (INPUT_MOVE_START_MS). A movestart inside our own command
   *  is ours. */
  moveStart(gesture: boolean): void {
    const waiting = this.now() - this.pendingMs < INPUT_MOVE_START_MS
    this.userMove = gesture || (this.own === 0 && (this.active || waiting))
    this.pendingMs = -Infinity
  }

  /** Whether a move that just ended was the user's: a gesture (MapLibre's originalEvent), input on the map just
   *  before it, or a move that started as the user's (moveStart), unless one of our own camera commands ended it. */
  endedByUser(gesture: boolean): boolean {
    return gesture || (this.own === 0 && (this.active || this.userMove))
  }

  /** A move ended (MapLibre's moveend): whether it was the user's (endedByUser); the next move starts afresh. */
  moveEnd(gesture: boolean): boolean {
    const user = this.endedByUser(gesture)
    this.userMove = false
    return user
  }
}
