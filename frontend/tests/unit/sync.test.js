import { beforeEach, describe, expect, it } from 'vitest'
import * as store from '../../src/offline/db'
import { flushOutbox } from '../../src/offline/sync'

function fakeServer(initialTasks) {
  const tasks = structuredClone(initialTasks)
  const incidents = new Map()
  let offline = false
  const client = {
    setOffline: (v) => { offline = v },
    tasks, incidents,
    async rpc(fn, a) {
      if (offline) throw new TypeError('Failed to fetch')
      const t = tasks[a.p_task_id]
      if (t.version !== a.p_expected_version) return { data: { ok: false, conflict: true, current: { ...t } }, error: null }
      t.status = a.p_status
      if (a.p_notes) t.notes = (t.notes ? t.notes + '\n' : '') + a.p_notes
      t.version += 1
      return { data: { ok: true, task: { ...t } }, error: null }
    },
    from() {
      return {
        upsert: async (payload) => {
          if (offline) return { error: new TypeError('Failed to fetch') }
          if (!incidents.has(payload.client_id)) incidents.set(payload.client_id, payload)
          return { error: null }
        },
      }
    },
  }
  return client
}

beforeEach(async () => {
  const db = await store.getDb()
  await db.clear('outbox'); await db.clear('conflicts'); await db.clear('tasks')
})

const op = (id, status, base, extra = {}) => ({ op_id: id, type: 'task_status', task_id: 't1', task_title: 'Pump', status, base_version: base, created_at: `2026-01-01T00:00:0${id.slice(-1)}Z`, ...extra })

describe('flushOutbox', () => {
  it('replays sequential offline edits chaining versions', async () => {
    const s = fakeServer({ t1: { id: 't1', status: 'assigned', version: 1 } })
    await store.enqueue(op('op1', 'accepted', 1))
    await store.enqueue(op('op2', 'in_progress', 1))
    await store.enqueue(op('op3', 'completed', 1, { notes: 'cleared' }))
    const r = await flushOutbox(s)
    expect(r).toMatchObject({ synced: 3, conflicts: 0 })
    expect(s.tasks.t1).toMatchObject({ status: 'completed', version: 4 })
    expect(await store.getOutbox()).toHaveLength(0)
  })

  it('resolves a conflict where the coordinator cancelled meanwhile (server wins)', async () => {
    const s = fakeServer({ t1: { id: 't1', status: 'cancelled', version: 6 } })
    await store.enqueue(op('op1', 'in_progress', 2))
    const r = await flushOutbox(s)
    expect(r.conflicts).toBe(1)
    expect(s.tasks.t1.status).toBe('cancelled')
    const [c] = await store.getConflicts()
    expect(c.winner).toBe('server')
  })

  it('resolves a conflict where someone else edited notes (client progress wins)', async () => {
    const s = fakeServer({ t1: { id: 't1', status: 'assigned', version: 3, notes: 'office note' } })
    await store.enqueue(op('op1', 'completed', 1, { notes: 'done' }))
    const r = await flushOutbox(s)
    expect(r.conflicts).toBe(1)
    expect(s.tasks.t1.status).toBe('completed')
    expect(s.tasks.t1.notes).toContain('office note')
    expect(s.tasks.t1.notes).toContain('done')
  })

  it('stops on network loss and keeps the remaining queue', async () => {
    const s = fakeServer({ t1: { id: 't1', status: 'assigned', version: 1 } })
    s.setOffline(true)
    await store.enqueue(op('op1', 'accepted', 1))
    const r = await flushOutbox(s)
    expect(r.remaining).toBe(1)
    expect(await store.getOutbox()).toHaveLength(1)
  })

  it('offline reports are idempotent on replay (client_id)', async () => {
    const s = fakeServer({})
    const payload = { client_id: 'c-1', title: 'Water at Mugda' }
    await store.enqueue({ op_id: 'c-1', type: 'incident_report', payload })
    await flushOutbox(s)
    await store.enqueue({ op_id: 'c-1', type: 'incident_report', payload })
    await flushOutbox(s)
    expect(s.incidents.size).toBe(1)
  })
})
