export default function SetupPage() {
  return (
    <div className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-bold">ResilioMesh — configuration needed</h1>
      <p className="mt-2 text-slate-600">The frontend cannot find its Supabase settings. Create <code className="rounded bg-slate-100 px-1">frontend/.env</code> with:</p>
      <pre className="mt-4 overflow-x-auto rounded-lg bg-slate-900 p-4 text-sm text-slate-100">{`VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon / publishable key>
VITE_API_URL=http://localhost:8000`}</pre>
      <p className="mt-4 text-sm text-slate-500">On Vercel, add the same variables under Project → Settings → Environment Variables and redeploy. See docs/SUPABASE_SETUP.md.</p>
    </div>
  )
}
