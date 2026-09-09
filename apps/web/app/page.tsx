'use client';

import { useEffect, useMemo, useState } from 'react';

const modes = [
  ['🤖', 'Auto'], ['🔎', 'Recherche'], ['🕵️', 'Fact-check'], ['🔬', 'Deep Research'],
  ['👁️', 'Vision'], ['🖥️', 'Computer Use'], ['🌐', 'Navigateur'], ['📈', 'Trading'],
  ['📊', 'Graphique'], ['🧮', 'Probabilités'], ['🎯', 'Simulation'], ['📁', 'Documents'],
  ['🧑‍💻', 'Code'], ['📰', 'Actualités'], ['🔔', 'Monitoring'], ['🧠', 'Étude']
];

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type Task = { id: string; status: string; result?: { answer?: string; calls?: unknown[]; error?: string }; errorCode?: string | null };

type Workspace = { id: string; name: string };

export default function Home() {
  const [mode, setMode] = useState('Auto');
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apiMode = useMemo(() => mode.toLowerCase().replaceAll(' ', '-'), [mode]);

  useEffect(() => {
    const saved = window.localStorage.getItem('nexaforge.workspace');
    if (saved) {
      try { setWorkspace(JSON.parse(saved)); } catch { window.localStorage.removeItem('nexaforge.workspace'); }
    }
  }, []);

  useEffect(() => {
    if (!task || ['completed', 'failed', 'cancelled'].includes(task.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${apiUrl}/api/v1/tasks/${task.id}`);
        if (!response.ok) return;
        const data = await response.json();
        setTask(data.task);
        if (['completed', 'failed', 'cancelled'].includes(data.task.status)) setRunning(false);
      } catch {
        // Keep polling; transient network failures should not kill the task UI.
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [task]);

  async function ensureWorkspace() {
    if (workspace) return workspace;
    const response = await fetch(`${apiUrl}/api/v1/dev/bootstrap`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dev@nexaforge.local', displayName: 'NexaForge Developer', workspaceName: 'NexaForge Dev' })
    });
    if (!response.ok) throw new Error('Impossible de créer le workspace de développement');
    const data = await response.json();
    window.localStorage.setItem('nexaforge.workspace', JSON.stringify(data.workspace));
    setWorkspace(data.workspace);
    return data.workspace;
  }

  async function runTask() {
    if (!prompt.trim() || running) return;
    setRunning(true); setError(null);
    try {
      const currentWorkspace = await ensureWorkspace();
      const response = await fetch(`${apiUrl}/api/v1/tasks`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, mode: apiMode, workspaceId: currentWorkspace.id, maxIterations: 12 })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Task request failed');
      setTask(data);
    } catch (err) {
      setRunning(false);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    }
  }

  return <main className="min-h-screen bg-zinc-950 text-white p-6">
    <div className="mx-auto max-w-6xl">
      <header className="flex items-center justify-between py-4">
        <div><h1 className="text-2xl font-bold">NexaForge AI</h1><p className="text-sm text-zinc-400">Agent workspace</p></div>
        <div className="flex items-center gap-3"><span className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300">{mode}</span><span className="text-xs text-zinc-500">{workspace ? 'Workspace connecté' : 'Initialisation…'}</span></div>
      </header>
      <section className="mt-10 grid gap-6 lg:grid-cols-[220px_1fr]">
        <aside className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-3">
          <p className="px-3 pb-3 text-xs uppercase tracking-wider text-zinc-500">Modes</p>
          <div className="space-y-1">{modes.map(([icon, label]) => <button key={label} onClick={() => setMode(label)} className={`w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-zinc-800 ${mode === label ? 'bg-zinc-800' : ''}`}><span className="mr-2">{icon}</span>{label}</button>)}</div>
        </aside>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
          <div className="min-h-[420px] rounded-xl border border-dashed border-zinc-800 p-8 flex items-center justify-center text-center">
            <div className="max-w-2xl w-full">
              <div className="text-5xl">{task?.status === 'completed' ? '✨' : '🤖'}</div>
              <h2 className="mt-4 text-2xl font-semibold">{task ? `Mission ${task.status}` : 'Que veux-tu que je fasse ?'}</h2>
              {task?.result?.answer ? <div className="mt-5 whitespace-pre-wrap rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5 text-left leading-7 text-zinc-200">{task.result.answer}</div> : <p className="mt-2 text-zinc-400">{task?.result?.error ?? 'Donne une mission. L’agent choisira les outils nécessaires et vérifiera les résultats.'}</p>}
              {task && <p className="mt-3 text-xs text-zinc-600">Task ID : {task.id}</p>}
            </div>
          </div>
          {error && <div className="mt-3 rounded-xl border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-300">{error}</div>}
          <div className="mt-4 rounded-2xl border border-zinc-700 bg-zinc-900 p-3">
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Écris une mission…" className="min-h-24 w-full resize-none bg-transparent p-2 outline-none placeholder:text-zinc-600" />
            <div className="flex items-center justify-between"><div className="text-xs text-zinc-500">Mode : {mode}</div><button disabled={running || !prompt.trim()} onClick={runTask} className="rounded-xl bg-white px-5 py-2 text-sm font-semibold text-black disabled:opacity-40">{running ? `Exécution… ${task?.status ?? ''}` : 'Lancer l’agent'}</button></div>
          </div>
        </div>
      </section>
    </div>
  </main>;
}
