import { describe, expect, it } from 'vitest'
import { areaLabel, canManageArea } from '../../src/lib/areas'

describe('Drainage Officer areas', () => {
  it('labels the two city corporations', () => {
    expect(areaLabel('DNCC')).toBe('Dhaka North')
    expect(areaLabel('DSCC')).toBe('Dhaka South')
    expect(areaLabel(null)).toBe('No area')
  })

  it('officers manage only their own area', () => {
    expect(canManageArea('city_officer', 'DSCC', 'DSCC')).toBe(true)
    expect(canManageArea('city_officer', 'DSCC', 'DNCC')).toBe(false)
  })

  it('an officer without an area manages nothing', () => {
    expect(canManageArea('city_officer', null, 'DSCC')).toBe(false)
    expect(canManageArea('city_officer', undefined, undefined)).toBe(false)
  })

  it('admins are city-wide, other roles manage nothing', () => {
    expect(canManageArea('admin', null, 'DNCC')).toBe(true)
    for (const role of ['citizen', 'ngo_coordinator', 'field_worker', undefined]) {
      expect(canManageArea(role, 'DSCC', 'DSCC')).toBe(false)
    }
  })
})
