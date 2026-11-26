import { Navigate, useLocation } from 'react-router-dom'
import { ShieldAlert } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import SessionGate from './SessionGate'
import { EmptyState, Spinner } from './ui'

export default function ProtectedRoute({ roles, children }) {
  const { session, profile, loading, security } = useAuth()
  const loc = useLocation()
  if (loading) return <Spinner label="Checking session…" />
  if (!session) return <Navigate to="/login" replace state={{ from: loc.pathname }} />
  if (!profile) return <Spinner label="Loading profile…" />
  if (security?.gate) return <SessionGate />
  if (roles && !roles.includes(profile.role)) {
    return (
      <EmptyState icon={ShieldAlert} title="Access restricted">
        Your role does not have access to this page. If you need access, ask a system administrator.
      </EmptyState>
    )
  }
  return children
}
