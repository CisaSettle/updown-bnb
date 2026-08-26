import { describe, expect, it } from 'vitest'
import { faqEntryDomId, faqEntryHash, parseHash } from '../route'

describe('parseHash', () => {
  it('sends an empty or unrelated hash to the trading view', () => {
    expect(parseHash('')).toEqual({ name: 'trade' })
    expect(parseHash('#')).toEqual({ name: 'trade' })
    expect(parseHash('#/')).toEqual({ name: 'trade' })
    expect(parseHash('#/positions')).toEqual({ name: 'trade' })
    // Not a prefix match: a route that merely starts with the letters is not the FAQ.
    expect(parseHash('#/faqsomething')).toEqual({ name: 'trade' })
  })

  it('opens the FAQ', () => {
    expect(parseHash('#/faq')).toEqual({ name: 'faq' })
    expect(parseHash('#/faq/')).toEqual({ name: 'faq' })
  })

  it('opens one question directly', () => {
    expect(parseHash('#/faq/settlement-rule')).toEqual({ name: 'faq', entry: 'settlement-rule' })
    expect(parseHash('#/faq/no-entry-price')).toEqual({ name: 'faq', entry: 'no-entry-price' })
  })

  it('decodes an escaped entry id rather than hunting for a DOM node that cannot exist', () => {
    expect(parseHash('#/faq/one%20two')).toEqual({ name: 'faq', entry: 'one two' })
  })

  it('round-trips the link it hands out', () => {
    expect(parseHash(faqEntryHash('verify'))).toEqual({ name: 'faq', entry: 'verify' })
  })

  it('keeps the DOM anchor out of the hash namespace, so the two cannot collide', () => {
    expect(faqEntryDomId('verify')).toBe('faq-verify')
    expect(faqEntryHash('verify')).toBe('#/faq/verify')
  })
})
