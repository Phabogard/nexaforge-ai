'use client';

import { useEffect, useState } from 'react';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type Workspace = { id: string; name: string };
type Project = { id: string; name: string; description: string; status: string };
type Build = { id: string; status: string; phase: string; result?: unknown; errorCode?: string | null };
type BuildEvent = { id: string; eventType: string; phase: string; payload: unknown };

export default function ApplicationsPage() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [build, setBuild] = useState<Build | null>(null);
  const [events, setEvents] = useState<BuildEvent[]>([]);
  const [name, setName] = useState('Mon application');
  const [prompt, setPrompt] = useState('Crée une application web moderne avec une page d’accueil, une navigation et une interface responsive.');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch(`${apiUrl}/api/v1/workspaces/default`, { method: 'POST' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('Workspace indisponible')))
      .then(data => setWorkspace(data.workspace))
      .catch(e => setError(e instanceof Error ? e.message : 'Erreur workspace'));
  }, []);

  useEffect(() => {
    if (!build || ['completed', 'failed', 'cancelled'].includes(build.status)) return;
    const timer = window.setInterval(() => {
      void fetch(`${apiUrl}/api/v1/application-builds/${build.id}`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error('Build introuvable')))
        .then(data => { setBuild(data.build); setEvents(data.events ?? []); })
        .catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [build?.id, build?.status]);

  async function createAndBuild() {
    if (!workspace || !name.trim() || !prompt.trim() || busy) return;
    setBusy(true); setError(null); setBuild(null); setEvents([]);
    try {
      const projectResponse = await fetch(`${apiUrl}/api/v1/applications`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: prompt.trim(), workspaceId: workspace.id })
      });
      const projectData = await projectResponse.json();
      if (!projectResponse.ok) throw new Error(projectData.error ?? 'Création du projet impossible');
      setProject(projectData.project);

      const buildResponse = await fetch(`${apiUrl}/api/v1/applications/${projectData.project.id}/builds`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim(), maxIterations: 12, maxRepairAttempts: 3 })
      });
      const buildData = await buildResponse.json();
      if (!buildResponse.ok) throw new Error(buildData.error ?? 'Création du build impossible');
      setBuild(buildData.build);
      setEvents([{ id: crypto.randomUUID(), eventType: 'build.queued', phase: 'queued', payload: {} }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    } finally { setBusy(false); }
  }

  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-10 text-white">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-col gap-2 border-b border-zinc-800 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div><p className="text-sm text-zinc-500">NexaForge</p><h1 className="text-3xl font-bold">Application Builder</h1><p className="mt-1 text-zinc-400">Décris une application. NexaForge prépare son build et expose chaque étape.</p></div>
          <span className="rounded-full border border-zinc-800 px-3 py-1 text-xs text-zinc-400">{workspace ? 'Workspace prêt' : 'Connexion…'}</span>
        </header>

        <section className="mt-8 grid gap-6 lg:grid-cols-[1fr_360px]">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
            <label className="text-sm font-medium text-zinc-300">Nom du projet</label>
            <input value={name} onChange={e => setName(e.target.value)} className="mt-2 w-full rounded-xl border border-zinc-700 bg-zinc-950 p-3 outline-none focus:border-zinc-500" />
            <label className="mt-5 block text-sm font-medium text-zinc-300">Description / mission</label>
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)} className="mt-2 min-h-48 w-full rounded-xl border border-zinc-700 bg-zinc-950 p-3 outline-none focus:border-zinc-500" />
            <button onClick={createAndBuild} disabled={busy || !workspace} className="mt-5 rounded-xl bg-white px-5 py-3 font-semibold text-black disabled:opacity-40">{busy ? 'Création…' : 'Créer et lancer le build'}</button>
            {error && <p className="mt-4 rounded-xl border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-300">{error}</p>}
          </div>

          <aside className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
            <p className="text-xs uppercase tracking-wider text-zinc-500">Build</p>
            {build ? <><div className="mt-3 text-2xl font-semibold">{build.status}</div><div className="text-sm text-zinc-400">Phase : {build.phase}</div><div className="mt-6 space-y-2">{events.map(e => <div key={e.id} className="rounded-lg border border-zinc-800 p-3 text-xs"><div className="font-mono text-zinc-300">{e.eventType}</div><div className="mt-1 text-zinc-500">{e.phase}</div></div>)}</div></> : <p className="mt-3 text-sm text-zinc-500">Aucun build lancé.</p>}
            {project && <div className="mt-6 border-t border-zinc-800 pt-4 text-xs text-zinc-500">Projet : {project.name}<br />ID : {project.id}</div>}
          </aside>
        </section>
      </div>
    </main>
  );
}
