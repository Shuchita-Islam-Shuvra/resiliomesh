import { describe, expect, it } from 'vitest'
import { attentionQueue, distanceM, filterTasks, fmtDistance, isOverdue, sortCrew, sortTasks, staffing, taskAttention, viewCounts } from '../../src/lib/fieldCrew'

describe('field crews', () => {
  const now = new Date('2026-11-26T10:00:00Z').getTime()

  it('flags only open tasks past their due time as overdue', () => {
    expect(isOverdue({ status: 'in_progress', due_at: '2026-11-26T09:00:00Z' }, now)).toBe(true)
    expect(isOverdue({ status: 'assigned', due_at: '2026-11-26T11:00:00Z' }, now)).toBe(false)
    expect(isOverdue({ status: 'completed', due_at: '2026-11-26T09:00:00Z' }, now)).toBe(false)
    expect(isOverdue({ status: 'assigned' }, now)).toBe(false)
  })

  it('puts the lead first, then sorts by name', () => {
    const crew = sortCrew([
      { is_lead: false, worker: { full_name: 'Sohel' } },
      { is_lead: true, worker: { full_name: 'Rafiq' } },
      { is_lead: false, worker: { full_name: 'Amina' } },
    ])
    expect(crew.map((c) => c.worker.full_name)).toEqual(['Rafiq', 'Amina', 'Sohel'])
  })

  it('reports short staffing against the crew size', () => {
    expect(staffing({ crew: [{}], crew_size: 3 })).toEqual({ have: 1, need: 3, short: true })
    expect(staffing({ crew: [{}, {}], crew_size: 2 })).toEqual({ have: 2, need: 2, short: false })
    expect(staffing({ assigned_to: 'x' })).toEqual({ have: 1, need: 1, short: false })
  })

  it('measures crew GPS distance from the report', () => {
    expect(distanceM(23.7, 90.4, 23.7, 90.4)).toBe(0)
    const d = distanceM(23.7, 90.4, 23.709, 90.4)
    expect(d).toBeGreaterThan(950); expect(d).toBeLessThan(1050)
    expect(distanceM(null, 90.4, 23.7, 90.4)).toBeNull()
    expect(fmtDistance(420)).toBe('420 m'); expect(fmtDistance(1530)).toBe('1.5 km'); expect(fmtDistance(null)).toBe('—')
  })
})

describe('officer attention queue', () => {
  const now = new Date('2026-11-26T10:00:00Z').getTime()
  const past = '2026-11-26T09:00:00Z'
  const later = '2026-11-26T12:00:00Z'

  it('lists every reason an open task needs an officer, worst first', () => {
    expect(taskAttention({ status: 'pending', crew: [], crew_size: 2, due_at: past }, now)).toEqual(['no_crew', 'overdue'])
    expect(taskAttention({ status: 'failed', crew: [{}], crew_size: 1 }, now)).toEqual(['failed'])
    expect(taskAttention({ status: 'assigned', crew: [{}], crew_size: 3, declines: [{}] }, now)).toEqual(['short', 'declined'])
    expect(taskAttention({ status: 'in_progress', crew: [{}, {}], crew_size: 2, due_at: later }, now)).toEqual([])
  })

  it('never flags closed tasks, even if they were short or late', () => {
    expect(taskAttention({ status: 'completed', crew: [], crew_size: 3, due_at: past }, now)).toEqual([])
    expect(taskAttention({ status: 'cancelled', crew: [] }, now)).toEqual([])
  })

  it('orders the queue by worst reason, then by due time', () => {
    const q = attentionQueue([
      { id: 'short', status: 'assigned', crew: [{}], crew_size: 2, due_at: later },
      { id: 'fine', status: 'in_progress', crew: [{}], crew_size: 1, due_at: later },
      { id: 'nobody-late', status: 'pending', crew: [], crew_size: 1, due_at: '2026-11-26T12:30:00Z' },
      { id: 'nobody-soon', status: 'pending', crew: [], crew_size: 1, due_at: '2026-11-26T11:00:00Z' },
      { id: 'failed', status: 'failed', crew: [{}], crew_size: 1 },
    ], now)
    expect(q.map((x) => x.task.id)).toEqual(['failed', 'nobody-soon', 'nobody-late', 'short'])
  })
})

describe('field portal filter and sort', () => {
  const now = new Date('2026-11-26T10:00:00Z').getTime()
  const tasks = [
    { id: 'a', status: 'assigned', title: 'Deploy dewatering pumps', due_at: '2026-11-26T12:00:00Z', updated_at: '2026-11-26T08:00:00Z', incidents: { reference_code: 'RM-0001', wards: { name: 'Mugda' } } },
    { id: 'b', status: 'in_progress', title: 'Clear blocked drainage', due_at: '2026-11-26T09:00:00Z', updated_at: '2026-11-26T09:30:00Z', incidents: { reference_code: 'RM-0002', wards: { name: 'Mirpur' } } },
    { id: 'c', status: 'failed', title: 'Distribute relief supplies', updated_at: '2026-11-26T07:00:00Z', incidents: { reference_code: 'RM-0003', wards: { name: 'Jatrabari' } } },
    { id: 'd', status: 'completed', title: 'Deploy dewatering pumps', due_at: '2026-11-26T08:00:00Z', incidents: { reference_code: 'RM-0004' } },
  ]
  const ids = (xs) => xs.map((t) => t.id)

  it('filters by view and hides closed tasks', () => {
    expect(ids(filterTasks(tasks, { view: 'all' }, now))).toEqual(['a', 'b', 'c'])
    expect(ids(filterTasks(tasks, { view: 'new' }, now))).toEqual(['a'])
    expect(ids(filterTasks(tasks, { view: 'active' }, now))).toEqual(['b'])
    expect(ids(filterTasks(tasks, { view: 'overdue' }, now))).toEqual(['b'])
    expect(ids(filterTasks(tasks, { view: 'failed' }, now))).toEqual(['c'])
    expect(ids(filterTasks(tasks, { view: 'nonsense' }, now))).toEqual(['a', 'b', 'c'])
  })

  it('searches title, report code and ward, ignoring case and spaces', () => {
    expect(ids(filterTasks(tasks, { q: '  mirpur ' }, now))).toEqual(['b'])
    expect(ids(filterTasks(tasks, { q: 'rm-0003' }, now))).toEqual(['c'])
    expect(ids(filterTasks(tasks, { q: 'PUMPS' }, now))).toEqual(['a'])
    expect(ids(filterTasks(tasks, { q: 'zzz' }, now))).toEqual([])
  })

  it('sorts by due time (no due time last) or by newest change', () => {
    expect(ids(sortTasks(tasks.slice(0, 3), 'due'))).toEqual(['b', 'a', 'c'])
    expect(ids(sortTasks([tasks[2], tasks[0], tasks[1]], 'newest'))).toEqual(['b', 'a', 'c'])
    expect(sortTasks([])).toEqual([])
  })

  it('counts open tasks per view for the chips', () => {
    expect(viewCounts(tasks, now)).toEqual({ all: 3, new: 1, active: 1, overdue: 1, failed: 1 })
  })
})
