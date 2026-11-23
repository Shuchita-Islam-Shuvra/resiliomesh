// Reconnection sync: replays the outbox in order with idempotency + conflict resolution.
import { resolveTaskConflict } from './conflict'
import * as store from './db'

let running = null

const isNetworkError = (e) => /Failed to fetch|NetworkError|network|fetch failed/i.test(String(e?.message || e))

/**
 * @param client  supabase client (injectable for tests)
 * @param deps    optional store override (tests)
 */
export function flushOutbox(client, deps = store) {
  if (running) return running          // single-flight: never two syncs at once
  running = doFlush(client, deps).finally(() => { running = null })
  return running
}

async function callTask(client, taskId, status, version, notes) {
  const { data, error } = await client.rpc('update_task_status', {
    p_task_id: taskId, p_status: status, p_expected_version: version, p_notes: notes || null,
  })
  if (error) throw error
  return data
}

async function doFlush(client, deps) {
  const ops = await deps.getOutbox()
  const versions = {}
  const summary = { synced: 0, conflicts: 0, failed: 0, remaining: 0 }

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    try {
      if (op.type === 'incident_report') {
        // client_id UNIQUE makes replays idempotent (ON CONFLICT DO NOTHING)
        const { error } = await client.from('incidents')
          .upsert(op.payload, { onConflict: 'client_id', ignoreDuplicates: true })
        if (error) throw error
        await deps.removeOp(op.op_id)
        summary.synced++
        continue
      }

      if (op.type === 'task_status') {
        const expected = versions[op.task_id] ?? op.base_version
        let res = await callTask(client, op.task_id, op.status, expected, op.notes)
        if (res.ok) {
          versions[op.task_id] = res.task.version
          await deps.putCachedTask(res.task)
          await deps.removeOp(op.op_id)
          summary.synced++
          continue
        }
        // ---- version conflict: someone changed this task while we were offline
        const server = res.current
        const decision = resolveTaskConflict(op, server)
        let final = server
        if (decision.winner !== 'server') {
          let v = server.version
          for (const step of decision.path) {
            const r = await callTask(client, op.task_id, step, v, step === op.status ? op.notes : null)
            if (!r.ok) throw new Error('Conflict persisted during replay')
            v = r.task.version
            final = r.task
          }
          versions[op.task_id] = v
        }
        await deps.putCachedTask(final)
        await deps.addConflict({
          id: op.op_id, at: new Date().toISOString(), task_id: op.task_id, task_title: op.task_title,
          local_status: op.status, server_status: server.status, winner: decision.winner, reason: decision.reason,
        })
        await deps.removeOp(op.op_id)
        summary.conflicts++
        continue
      }
      await deps.removeOp(op.op_id)        // unknown op type: drop
    } catch (e) {
      if (isNetworkError(e)) {             // still offline: stop, keep the rest queued
        summary.remaining = ops.length - i
        return summary
      }
      // business error (forbidden, invalid transition): park it, keep queue moving
      await deps.addConflict({
        id: op.op_id, at: new Date().toISOString(), task_id: op.task_id, task_title: op.task_title || op.payload?.title,
        local_status: op.status || 'report', server_status: 'rejected', winner: 'server',
        reason: `Server rejected the change: ${e.message || e}`,
      })
      await deps.removeOp(op.op_id)
      summary.failed++
    }
  }
  return summary
}
