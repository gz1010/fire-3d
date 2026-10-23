// Telling the user's camera moves from ours (brief-3 integration review round 2, R1): a click on Little Giant's marker
// (WA) must keep its card and the 'fire-card' focus hold while the card's own layout change restarts the flight,
// instead of the zoom focus opening the prepared Lower Sugarloaf Fire nearby.
import { describe, expect, it } from 'vitest'
import mapControllerSource from './mapController.ts?raw'
import { FocusHold } from './focus'
import { MapInput, USER_INPUT_MS } from './userInput'

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
    expect(src).toMatch(/const user = this\.input\.endedByUser\(byUser\)/)
    expect(src).not.toMatch(/userInputActive|lastInputMs/)
  })
})
