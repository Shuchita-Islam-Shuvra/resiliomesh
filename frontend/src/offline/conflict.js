// Pure conflict-resolution policy for offline task edits (unit tested).
//
// Policy (documented in README):
//  1. Server is terminal (completed / cancelled)  -> SERVER WINS. A cancelled task must
//     not be resurrected by a stale offline device; local notes are preserved in the log.
//  2. Same status on both sides                    -> MERGE NOTES (append, no duplication).
//  3. Local progress is further along the lifecycle -> CLIENT WINS (the field worker is the
//     source of truth for physical progress). Replay along a valid transition path.
//  4. Local 'failed' while server still active     -> CLIENT WINS (failure must surface).
//  5. Otherwise (server further ahead)             -> SERVER WINS.

export const LIFECYCLE = ['pending', 'assigned', 'accepted', 'in_progress', 'completed']
export const TERMINAL = ['completed', 'cancelled']

const ALLOWED = {
  pending: ['assigned', 'cancelled'],
  assigned: ['accepted', 'in_progress', 'cancelled'],
  accepted: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'failed', 'cancelled'],
  failed: ['assigned', 'in_progress'],
  completed: [],
  cancelled: [],
}

export const canTransition = (from, to) => from === to || (ALLOWED[from] || []).includes(to)

/** Shortest valid path of statuses from `from` to `to` (exclusive of from). BFS. */
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
