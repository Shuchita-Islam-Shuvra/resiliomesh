import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import AppShell from './components/AppShell'
import ProtectedRoute from './components/ProtectedRoute'
import { Spinner } from './components/ui'
import { isConfigured } from './lib/supabase'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import SetupPage from './pages/SetupPage'

const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const RiskMapPage = lazy(() => import('./pages/RiskMapPage'))
const IncidentsPage = lazy(() => import('./pages/IncidentsPage'))
const IncidentDetailPage = lazy(() => import('./pages/IncidentDetailPage'))
const ReportIncidentPage = lazy(() => import('./pages/ReportIncidentPage'))
const RiskAnalysisPage = lazy(() => import('./pages/RiskAnalysisPage'))
const ResourcesPage = lazy(() => import('./pages/ResourcesPage'))
const NgoCenterPage = lazy(() => import('./pages/NgoCenterPage'))
const FieldPortalPage = lazy(() => import('./pages/FieldPortalPage'))
const WorkflowsPage = lazy(() => import('./pages/WorkflowsPage'))
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage'))
const AdminPage = lazy(() => import('./pages/AdminPage'))

const COORD = ['city_officer', 'ngo_coordinator', 'admin']
const guard = (el, roles) => <ProtectedRoute roles={roles}>{el}</ProtectedRoute>

export default function App() {
  if (!isConfigured) return <SetupPage />
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route element={guard(<AppShell />)}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/map" element={<RiskMapPage />} />
          <Route path="/incidents" element={<IncidentsPage />} />
          <Route path="/incidents/new" element={<ReportIncidentPage />} />
          <Route path="/incidents/:id" element={<IncidentDetailPage />} />
          <Route path="/risk" element={guard(<RiskAnalysisPage />, COORD)} />
          <Route path="/resources" element={guard(<ResourcesPage />, COORD)} />
          <Route path="/ngo" element={guard(<NgoCenterPage />, COORD)} />
          <Route path="/field" element={guard(<FieldPortalPage />, ['field_worker', 'admin'])} />
          <Route path="/workflows" element={guard(<WorkflowsPage />, COORD)} />
          <Route path="/analytics" element={guard(<AnalyticsPage />, COORD)} />
          <Route path="/admin" element={guard(<AdminPage />, ['admin'])} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  )
}
