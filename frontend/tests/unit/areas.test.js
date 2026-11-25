import { describe, expect, it } from 'vitest'
import { areaAt, areaLabel, canManageArea, wardCells } from '../../src/lib/areas'

describe('Water Resilience Officer areas', () => {
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

  const WARDS = [
    ['DNCC-05', 'DNCC', 23.759, 90.3926], ['DNCC-09', 'DNCC', 23.7509, 90.3935], ['DNCC-01', 'DNCC', 23.8759, 90.3795],
    ['DSCC-01', 'DSCC', 23.7461, 90.3742], ['DSCC-04', 'DSCC', 23.733, 90.4172], ['DSCC-03', 'DSCC', 23.7487, 90.413],
  ].map(([ward_id, city_corporation, lat, lng]) => ({ ward_id, city_corporation, lat, lng }))

  it('a place belongs to the area of its nearest ward centre', () => {
    expect(areaAt(WARDS, 23.7332, 90.4170)).toBe('DSCC')
    expect(areaAt(WARDS, 23.7512, 90.3933)).toBe('DNCC')
    expect(areaAt(WARDS, 23.88, 90.38)).toBe('DNCC')
    expect(areaAt([], 23.7, 90.4)).toBe(null)
  })

  it('ward regions tile the map and agree with areaAt', () => {
    const cells = wardCells(WARDS, [[23.68, 90.33], [23.905, 90.47]])
    expect(cells).toHaveLength(WARDS.length)
    for (const c of cells) {
      expect(c.ring.length).toBeGreaterThan(2)
      const lat = c.ring.reduce((s, p) => s + p[0], 0) / c.ring.length
      const lng = c.ring.reduce((s, p) => s + p[1], 0) / c.ring.length
      expect(areaAt(WARDS, lat, lng)).toBe(c.city_corporation)
    }
  })
})
