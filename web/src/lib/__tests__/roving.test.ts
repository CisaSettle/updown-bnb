import { describe, expect, it } from 'vitest'
import { rovingIndex } from '../roving'

describe('rovingIndex — the keyboard the roles promise', () => {
  it('moves forward and back with wrap-around', () => {
    expect(rovingIndex('ArrowRight', 0, 3, 'horizontal')).toBe(1)
    expect(rovingIndex('ArrowDown', 0, 3, 'vertical')).toBe(1)
    expect(rovingIndex('ArrowRight', 2, 3, 'horizontal')).toBe(0)
    expect(rovingIndex('ArrowLeft', 0, 3, 'horizontal')).toBe(2)
    expect(rovingIndex('ArrowUp', 1, 3, 'vertical')).toBe(0)
  })

  it('keeps each widget on its own axis, so tabs never swallow page scrolling', () => {
    // A horizontal tablist must let ArrowUp/ArrowDown through to the page…
    expect(rovingIndex('ArrowUp', 1, 3, 'horizontal')).toBeUndefined()
    expect(rovingIndex('ArrowDown', 1, 3, 'horizontal')).toBeUndefined()
    // …and a vertical menu must not cycle on the horizontal arrows.
    expect(rovingIndex('ArrowLeft', 1, 3, 'vertical')).toBeUndefined()
    expect(rovingIndex('ArrowRight', 1, 3, 'vertical')).toBeUndefined()
    // Radios are the one widget WAI-ARIA gives both axes.
    expect(rovingIndex('ArrowDown', 0, 2, 'both')).toBe(1)
    expect(rovingIndex('ArrowRight', 0, 2, 'both')).toBe(1)
  })

  it('jumps to the ends with Home and End on every axis', () => {
    expect(rovingIndex('Home', 2, 3, 'horizontal')).toBe(0)
    expect(rovingIndex('End', 0, 3, 'vertical')).toBe(2)
  })

  it('answers nothing for keys that are not its business, so Tab and typing pass through', () => {
    expect(rovingIndex('Tab', 0, 3, 'both')).toBeUndefined()
    expect(rovingIndex('Enter', 0, 3, 'both')).toBeUndefined()
    expect(rovingIndex('a', 0, 3, 'both')).toBeUndefined()
  })

  it('refuses degenerate widgets rather than computing into them', () => {
    expect(rovingIndex('ArrowRight', 0, 0, 'both')).toBeUndefined()
    expect(rovingIndex('ArrowRight', -1, 3, 'both')).toBeUndefined()
    expect(rovingIndex('ArrowRight', 3, 3, 'both')).toBeUndefined()
  })
})
