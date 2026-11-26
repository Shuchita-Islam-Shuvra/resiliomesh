import { describe, expect, it } from 'vitest'
import { canTransition, resolveTaskConflict, transitionPath } from '../../src/offline/conflict'

describe('transitionPath', () => {
  it('finds a valid multi-step path', () => {
    expect(transitionPath('assigned', 'completed')).toEqual(['in_progress', 'completed'])
    expect(transitionPath('accepted', 'failed')).toEqual(['failed'])
    expect(transitionPath('assigned', 'failed')).toEqual(['accepted', 'failed'])
  })
  it('returns null when impossible (terminal states)', () => {
    expect(transitionPath('completed', 'in_progress')).toBeNull()
    expect(transitionPath('cancelled', 'assigned')).toBeNull()
  })
  it('never routes through cancelled', () => {
    expect(transitionPath('pending', 'in_progress')).toEqual(['assigned', 'in_progress'])
  })
})

describe('resolveTaskConflict', () => {
  it('server wins when coordinator cancelled the task while worker was offline', () => {
    const r = resolveTaskConflict({ status: 'completed' }, { status: 'cancelled', version: 5 })
    expect(r.winner).toBe('server')
  })
  it('client wins when field progress is ahead of server', () => {
    const r = resolveTaskConflict({ status: 'completed' }, { status: 'assigned', version: 3 })
    expect(r.winner).toBe('client')
    expect(r.path).toEqual(['in_progress', 'completed'])
  })
  it('merges notes when both sides have the same status', () => {
    const r = resolveTaskConflict({ status: 'in_progress', notes: 'water receding' }, { status: 'in_progress', version: 7 })
    expect(r.winner).toBe('merge')
  })
  it('server wins when server is further along', () => {
    const r = resolveTaskConflict({ status: 'accepted' }, { status: 'in_progress', version: 4 })
    expect(r.winner).toBe('server')
  })
  it('a field failure report always surfaces', () => {
    const r = resolveTaskConflict({ status: 'failed' }, { status: 'in_progress', version: 4 })
    expect(r.winner).toBe('client')
    expect(r.path).toEqual(['failed'])
  })
  it('canTransition mirrors database rules', () => {
    expect(canTransition('assigned', 'in_progress')).toBe(true)
    expect(canTransition('assigned', 'completed')).toBe(false)
    expect(canTransition('completed', 'completed')).toBe(true)
    expect(canTransition('accepted', 'failed')).toBe(true)
    expect(canTransition('accepted', 'completed')).toBe(false)
  })
})
