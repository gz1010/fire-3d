// Telling the user's camera moves from ours (brief-3 integration review round 2, R1): a click on Little Giant's marker
// (WA) must keep its card and the 'fire-card' focus hold while the card's own layout change restarts the flight,
// instead of the zoom focus opening the prepared Lower Sugarloaf Fire nearby.
import { describe, expect, it } from 'vitest'
import mapControllerSource from './mapController.ts?raw'
import { FocusHold } from './focus'
import { INPUT_MOVE_START_MS, MapInput, USER_INPUT_MS } from './userInput'

function clock() {
  let t = 1000
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('MapInput: whose move ended', () => {
  it('a gesture (MapLibre originalEvent) is always the user’s, even inside our own command', () => {
    const c = clock()
    const input = new MapInput(c.now)
    expect(input.endedByUser(true)).toBe(true)
    expect(input.ours(() => input.endedByUser(true))).toBe(true)
  })

  it('a move that ends while the pointer is down, or just after an input on the map, is the user’s (a wheel zoom)', () => {
    const c = clock()
    const input = new MapInput(c.now)
    expect(input.endedByUser(false)).toBe(false)
    input.pointerDown()
    expect(input.endedByUser(false)).toBe(true)
    input.pointerUp()
    c.advance(USER_INPUT_MS - 1)
    expect(input.endedByUser(false)).toBe(true)
    c.advance(1)
    expect(input.endedByUser(false)).toBe(false)
    input.input() // wheel or key
    expect(input.active).toBe(true)
    expect(input.endedByUser(false)).toBe(true)
  })

  it('a move that one of our own camera commands ends is ours, however recent the input (nested commands too)', () => {
    const c = clock()
    const input = new MapInput(c.now)
    input.input()
    expect(input.ours(() => input.endedByUser(false))).toBe(false)
    expect(input.ours(() => input.ours(() => input.endedByUser(false)) || input.endedByUser(false))).toBe(false)
    // back outside: the recent input counts again
    expect(input.endedByUser(false)).toBe(true)
    // an exception inside the command does not leave it marked as ours
    expect(() =>
      input.ours(() => {
        throw new Error('x')
      }),
    ).toThrow('x')
    expect(input.endedByUser(false)).toBe(true)
  })

  it('a click handled as a request (a fire marker) is not a camera gesture; a press still held is', () => {
    const c = clock()
    const input = new MapInput(c.now)
    input.pointerDown()
    input.pointerUp()
    c.advance(5)
    expect(input.active).toBe(true)
    input.consumeClick()
    expect(input.active).toBe(false)
    expect(input.endedByUser(false)).toBe(false)
    // the pointer still down (a drag that started on a marker): it stays the user's
    input.pointerDown()
    input.consumeClick()
    expect(input.endedByUser(false)).toBe(true)
  })
})

describe('a marker click keeps the fire card’s focus hold (Little Giant, WA)', () => {
  // the controller's moveend handler, reduced to the hold: a move the user made ends it
  const moveEnd = (input: MapInput, hold: FocusHold, gesture = false) => {
    if (input.endedByUser(gesture)) hold.release()
  }

  it('the card’s layout change restarts the flight 120 ms after the click: the hold stays, so the focus keeps Little Giant', () => {
    const c = clock()
    const input = new MapInput(c.now)
    const hold = new FocusHold()
    // real click on the marker: down, up, the map's click handler
    input.pointerDown()
    c.advance(80)
    input.pointerUp()
    input.consumeClick()
    hold.flight('fire-card')
    c.advance(120)
    // applySafeInsets: setPadding stops the flight (moveend inside our command), then flies again
    input.ours(() => moveEnd(input, hold))
    expect(hold.active).toBe(true)
    // the restarted flight ends 1.1 s later
    c.advance(1100)
    moveEnd(input, hold)
    expect(hold.active).toBe(true)
  })

  it('before the fix: the restart’s moveend counted as the user’s move and ended the hold', () => {
    const c = clock()
    const input = new MapInput(c.now)
    const hold = new FocusHold()
    input.pointerDown()
    c.advance(80)
    input.pointerUp()
    hold.flight('fire-card')
    c.advance(120)
    moveEnd(input, hold) // neither consumed nor marked as ours
    expect(hold.active).toBe(false)
  })

  it('reduced motion: the instant flight ends inside our own command, the hold stays', () => {
    const c = clock()
    const input = new MapInput(c.now)
    const hold = new FocusHold()
    input.pointerDown()
    c.advance(60)
    input.pointerUp()
    hold.flight('fire-card')
    input.ours(() => moveEnd(input, hold))
    expect(hold.active).toBe(true)
  })

  it('the user’s next wheel zoom or drag still ends the hold', () => {
    const c = clock()
    const input = new MapInput(c.now)
    const hold = new FocusHold()
    hold.flight('fire-card')
    c.advance(3000)
    input.input()
    moveEnd(input, hold)
    expect(hold.active).toBe(false)
    hold.flight('fire-card')
    moveEnd(input, hold, true)
    expect(hold.active).toBe(false)
  })

  it('the controller wires it: the marker click consumes the input; the flight and the padding restart are our own commands', () => {
    const src = mapControllerSource.replace(/\s+/g, ' ')
    expect(src).toMatch(/if \(fireId\) \{ \/\/[^}]*this\.input\.consumeClick\(\) this\.openFireFromOverview\(fireId\)/)
    expect(src).toMatch(/this\.input\.ours\(\(\) => \{ this\.map\.setPadding\(padding\) this\.fly\(f\.req, f\.animate\) \}\)/)
    expect(src).toMatch(/private fly\([^)]*\)[^{]*\{[^]*?this\.input\.ours\(\(\) => \{ if \(!paddingEquals/)
    expect(src).toMatch(/const user = this\.input\.moveEnd\(byUser\)/)
    expect(src).not.toMatch(/userInputActive|lastInputMs/)
  })
})

// Review round 3: a wheel zoom's moveend comes 400-450 ms after the wheel (much later on a slow renderer), at or past
// USER_INPUT_MS, without an originalEvent, so the hold of Little Giant's card (WA) survived one real wheel notch over
// Lower Sugarloaf. A move that STARTS as the user's is theirs at its moveend; our own commands never are.
describe('MapInput: a move that started as the user’s', () => {
  // the controller's movestart / moveend handlers, reduced to the hold
  const moveStart = (input: MapInput, gesture = false) => input.moveStart(gesture)
  const moveEnd = (input: MapInput, hold: FocusHold, gesture = false) => {
    if (input.moveEnd(gesture)) hold.release()
  }

  it('one wheel notch: MapLibre starts the zoom 40 ms after the wheel and ends it 450 ms after: the user’s', () => {
    const c = clock()
    const input = new MapInput(c.now)
    input.input() // the wheel event on the map
    c.advance(40)
    moveStart(input)
    c.advance(410) // moveend 450 ms after the wheel: past USER_INPUT_MS
    expect(input.active).toBe(false)
    expect(input.endedByUser(false)).toBe(true)
    expect(input.moveEnd(false)).toBe(true)
    // the move is over: the next one starts afresh
    expect(input.endedByUser(false)).toBe(false)
  })

  it('a slow renderer: the zoom starts 600 ms after the wheel and ends 2 s later, still the user’s', () => {
    const c = clock()
    const input = new MapInput(c.now)
    input.input()
    c.advance(600)
    moveStart(input)
    c.advance(2000)
    expect(input.moveEnd(false)).toBe(true)
  })

  it('a wheel or key input waits INPUT_MOVE_START_MS for its move, and only for the first one', () => {
    const c = clock()
    const input = new MapInput(c.now)
    input.input() // a wheel MapLibre ignored (at the zoom limit): no move
    c.advance(INPUT_MOVE_START_MS)
    moveStart(input)
    c.advance(1000)
    expect(input.moveEnd(false)).toBe(false)
    input.input()
    c.advance(500)
    moveStart(input)
    expect(input.moveEnd(false)).toBe(true)
    c.advance(500)
    moveStart(input) // a later move with no input of its own
    c.advance(1000)
    expect(input.moveEnd(false)).toBe(false)
  })

  it('a drag or touch that starts a move makes it the user’s, however long its inertia runs', () => {
    const c = clock()
    const input = new MapInput(c.now)
    input.pointerDown()
    c.advance(30)
    moveStart(input, true) // a drag: with an originalEvent
    input.pointerUp()
    c.advance(1500)
    expect(input.moveEnd(false)).toBe(true)
    // a touch held down when a move without an originalEvent starts
    input.pointerDown()
    moveStart(input)
    input.pointerUp()
    c.advance(1500)
    expect(input.moveEnd(false)).toBe(true)
  })

  it('a move that starts inside our own command is ours, whatever input came just before, and clears a waiting one', () => {
    const c = clock()
    const input = new MapInput(c.now)
    input.input()
    c.advance(10)
    input.ours(() => moveStart(input)) // e.g. a framing flight
    c.advance(1100)
    expect(input.moveEnd(false)).toBe(false)
    // the wheel input no longer waits for a move
    c.advance(10)
    moveStart(input)
    c.advance(1000)
    expect(input.moveEnd(false)).toBe(false)
    // a gesture is the user's even then (as at moveend)
    input.ours(() => moveStart(input, true))
    expect(input.moveEnd(false)).toBe(true)
  })

  it('a user’s move that one of our own commands ends is ours (as before)', () => {
    const c = clock()
    const input = new MapInput(c.now)
    input.input()
    moveStart(input)
    c.advance(100)
    expect(input.ours(() => input.moveEnd(false))).toBe(false)
  })

  it('a click handled as a request clears a waiting wheel input', () => {
    const c = clock()
    const input = new MapInput(c.now)
    input.input()
    input.pointerDown()
    input.pointerUp()
    input.consumeClick()
    c.advance(500)
    moveStart(input)
    c.advance(1000)
    expect(input.moveEnd(false)).toBe(false)
  })

  it('Little Giant: the marker click’s flight keeps the hold; one wheel notch over Lower Sugarloaf then ends it', () => {
    const c = clock()
    const input = new MapInput(c.now)
    const hold = new FocusHold()
    // the click on the marker: a request, then our flight (restarted once by the card's layout change)
    input.pointerDown()
    c.advance(80)
    input.pointerUp()
    input.consumeClick()
    hold.flight('fire-card')
    input.ours(() => moveStart(input))
    c.advance(120)
    input.ours(() => {
      moveEnd(input, hold)
      moveStart(input)
    })
    c.advance(1100)
    moveEnd(input, hold)
    expect(hold.active).toBe(true)
    // the camera put over Lower Sugarloaf at z8.4 without input on the map (a script's jumpTo): the hold stays
    c.advance(3000)
    moveStart(input)
    moveEnd(input, hold)
    expect(hold.active).toBe(true)
    // one real wheel notch: its zoom ends 450 ms later, and ends the hold
    input.input()
    c.advance(40)
    moveStart(input)
    c.advance(410)
    moveEnd(input, hold)
    expect(hold.active).toBe(false)
  })

  it('before the fix: the same notch, judged at its moveend alone, kept the hold', () => {
    const c = clock()
    const input = new MapInput(c.now)
    const hold = new FocusHold()
    hold.flight('fire-card')
    input.input()
    c.advance(450) // no moveStart reported
    if (input.endedByUser(false)) hold.release()
    expect(hold.active).toBe(true)
  })

  it('the controller wires it: every movestart and moveend is reported, and every camera command runs in ours', () => {
    const src = mapControllerSource.replace(/\s+/g, ' ')
    expect(src).toMatch(/map\.on\('movestart', \(e: \{ originalEvent\?: unknown \}\) => \{ (\/\/[^\n]*?)?this\.input\.moveStart\(e\.originalEvent != null\)/)
    // every moveend closes its move, also those issueFit handles
    expect(src).toMatch(/private onMoveEnd\(byUser: boolean\): void \{ (\/\/ [^]*?)?const user = this\.input\.moveEnd\(byUser\) (\/\/ [^]*?)?if \(this\.issuing\) return/)
    // each camera call of the controller lies inside a this.input.ours(…) call
    const raw = mapControllerSource
    const spans: [number, number][] = []
    for (let i = raw.indexOf('this.input.ours('); i >= 0; i = raw.indexOf('this.input.ours(', i + 1)) {
      let depth = 0
      let j = i + 'this.input.ours'.length
      for (; j < raw.length; j++) {
        if (raw[j] === '(') depth++
        else if (raw[j] === ')' && --depth === 0) break
      }
      spans.push([i, j])
    }
    const calls = [...raw.matchAll(/\bmap\.(easeTo|flyTo|jumpTo|fitBounds|setPadding|panTo|panBy|zoomTo|zoomIn|zoomOut|rotateTo|resetNorth|setZoom|setCenter|setBearing|setPitch)\(/g)]
    expect(calls.length).toBeGreaterThanOrEqual(10)
    const outside = calls.filter((m) => !spans.some(([a, b]) => m.index! > a && m.index! < b)).map((m) => raw.slice(0, m.index).split('\n').length)
    expect(outside).toEqual([])
  })
})
