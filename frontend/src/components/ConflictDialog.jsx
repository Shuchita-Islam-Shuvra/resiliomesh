import { GitMerge } from 'lucide-react'
import { Button, Modal } from './ui'
import { fmtDateTime, humanize } from '../lib/format'

export default function ConflictDialog({ conflict, onReload, onClose, fields = [] }) {
  if (!conflict) return null
  const { mine = {}, theirs = {} } = conflict
  return (
    <Modal open title="Someone else changed this record" onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Keep editing</Button><Button onClick={onReload}>Load latest version</Button></>}>
      <div className="flex gap-3">
        <GitMerge className="h-6 w-6 shrink-0 text-amber-500" aria-hidden />
        <p className="text-sm text-slate-600">
          Your change was <strong>not saved</strong> because another user updated this record
          (version {theirs.version}) after you opened it (version {mine.version}). Review the latest data and re-apply your change.
        </p>
      </div>
      {fields.length > 0 && (
        <table className="mt-4 w-full text-sm">
          <thead><tr className="text-left text-xs uppercase text-slate-500"><th className="py-1">Field</th><th>Your version</th><th>Latest (server)</th></tr></thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f} className={`border-t border-slate-100 ${String(mine[f]) !== String(theirs[f]) ? 'bg-amber-50' : ''}`}>
                <td className="py-1.5 font-medium text-slate-700">{humanize(f)}</td>
                <td className="text-slate-600">{String(mine[f] ?? '—')}</td>
                <td className="font-medium text-slate-900">{String(theirs[f] ?? '—')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {theirs.updated_at && <p className="mt-3 text-xs text-slate-500">Server updated {fmtDateTime(theirs.updated_at)}</p>}
    </Modal>
  )
}
