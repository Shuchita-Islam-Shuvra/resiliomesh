export const LIFECYCLE = ['pending', 'assigned', 'accepted', 'in_progress', 'completed']
export const TERMINAL = ['completed', 'cancelled']

const ALLOWED = {
  pending: ['assigned', 'cancelled'],
  assigned: ['accepted', 'in_progress', 'cancelled'],
  accepted: ['in_progress', 'failed', 'cancelled'],
  in_progress: ['completed', 'failed', 'cancelled'],
  failed: ['assigned', 'in_progress'],
  completed: [],
  cancelled: [],
}

export const canTransition = (from, to) => from === to || (ALLOWED[from] || []).includes(to)

export function transitionPath(from, to) {
  if (from === to) return []
  const queue = [[from, []]]
  const seen = new Set([from])
  while (queue.length) {
    const [s, path] = queue.shift()
    for (const n of ALLOWED[s] || []) {
      if (seen.has(n) || n === 'cancelled') continue
      const p = [...path, n]
      if (n === to) return p
      seen.add(n)
      queue.push([n, p])
    }
  }
  return null
}

const rank = (s) => LIFECYCLE.indexOf(s)

export function resolveTaskConflict(local, server) {
  if (TERMINAL.includes(server.status)) {
    return { winner: 'server', reason: `Task is already ${server.status} on the server; offline change discarded.`, path: [] }
  }
  if (local.status === server.status) {
    return { winner: 'merge', reason: 'Same status on both sides; notes merged.', path: [local.status] }
  }
  if (local.status === 'failed' || rank(local.status) > rank(server.status)) {
    const path = transitionPath(server.status, local.status)
    if (path) return { winner: 'client', reason: `Field progress (${local.status}) is newer than server (${server.status}); replayed.`, path }
  }
  return { winner: 'server', reason: `Server state (${server.status}) is ahead of the offline edit (${local.status}).`, path: [] }
}
