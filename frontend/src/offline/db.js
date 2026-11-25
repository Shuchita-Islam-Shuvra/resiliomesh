import { openDB } from 'idb'

const DB_NAME = 'resiliomesh-offline'
let dbp

export function getDb() {
  if (!dbp) {
    dbp = openDB(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore('tasks', { keyPath: 'id' })
        const ob = db.createObjectStore('outbox', { keyPath: 'op_id' })
        ob.createIndex('by_created', 'created_at')
        db.createObjectStore('conflicts', { keyPath: 'id' })
        db.createObjectStore('meta')
      },
    })
  }
  return dbp
}

export async function cacheTasks(tasks) {
  const db = await getDb()
  const tx = db.transaction('tasks', 'readwrite')
  await tx.store.clear()
  for (const t of tasks) await tx.store.put(t)
  await tx.done
  await db.put('meta', new Date().toISOString(), 'tasks_cached_at')
}

export async function getCachedTasks() {
  return (await getDb()).getAll('tasks')
}

export async function putCachedTask(task) {
  return (await getDb()).put('tasks', task)
}

export async function getMeta(key) {
  return (await getDb()).get('meta', key)
}

export async function enqueue(op) {
  const db = await getDb()
  await db.put('outbox', { ...op, created_at: op.created_at || new Date().toISOString() })
}

export async function getOutbox() {
  const db = await getDb()
  return db.getAllFromIndex('outbox', 'by_created')
}

export async function removeOp(opId) {
  return (await getDb()).delete('outbox', opId)
}

export async function updateOp(op) {
  return (await getDb()).put('outbox', op)
}

export async function addConflict(entry) {
  return (await getDb()).put('conflicts', entry)
}

export async function getConflicts() {
  const all = await (await getDb()).getAll('conflicts')
  return all.sort((a, b) => b.at.localeCompare(a.at))
}

export async function clearConflicts() {
  return (await getDb()).clear('conflicts')
}
