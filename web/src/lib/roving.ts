/**
 * The one piece of a roving-tabindex widget worth extracting: which index a key moves to.
 *
 * Shared by the market tabs, the bet-side and approval radio groups, and the account menus, so
 * the arrow-key behaviour those roles promise a screen-reader user is one tested function rather
 * than four hand-rolled switch statements.
 *
 * The axis matters: a horizontal tab list must NOT swallow ArrowUp/ArrowDown (that is how a
 * keyboard user scrolls the page), and a vertical menu must not cycle on ArrowLeft/ArrowRight.
 * Radios are the one widget WAI-ARIA gives both axes.
 */
export type RovingAxis = 'horizontal' | 'vertical' | 'both'

export function rovingIndex(key: string, current: number, count: number, axis: RovingAxis): number | undefined {
  if (count <= 0 || current < 0 || current >= count) return undefined
  const forward = (axis !== 'vertical' && key === 'ArrowRight') || (axis !== 'horizontal' && key === 'ArrowDown')
  const backward = (axis !== 'vertical' && key === 'ArrowLeft') || (axis !== 'horizontal' && key === 'ArrowUp')
  if (forward) return (current + 1) % count
  if (backward) return (current - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return undefined
}
