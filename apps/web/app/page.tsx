'use client';

import { useState } from 'react';

const modes = [
  ['🤖', 'Auto'], ['🔎', 'Recherche'], ['🕵️', 'Fact-check'], ['🔬', 'Deep Research'],
  ['👁️', 'Vision'], ['🖥️', 'Computer Use'], ['🌐', 'Navigateur'], ['📈', 'Trading'],
  ['📊', 'Graphique'], ['🧮', 'Probabilités'], ['🎯', 'Simulation'], ['📁', 'Documents'],
  ['🧑‍💻', 'Code'], ['📰', 'Actualités'], ['🔔', 'Monitoring'], ['🧠', 'Étude']
];

export default function Home() {
  const [mode, setMode] = useState('Auto');
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);

  async function runTask() {
    if (!prompt.trim()) return;
    setRunning(true);
    try {
      const response = await fetch(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1/tasks', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, mode: mode.toLowerCase().replaceAll(' ', '-') })
      });
      if (!response.ok) throw new Error('Task request failed');
    } finally { setRunning(false); }
  }

  return <main className="min-h-screen bg-zinc-950 text-white p-6">
    <div className="mx-auto max-w-6xl">
      <header className="flex items-center justify-between py-4">
        <div><h1 className="text-2xl font-bold">NexaForge AI</h1><p className="text-sm text-zinc-400">Agent workspace</p></div>
        <span className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300">{mode}</span>
      </header>
      <section className="mt-10 grid gap-6 lg:grid-cols-[220px_1fr]">
        <aside className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-3">
          <p className="px-3 pb-3 text-xs uppercase tracking-wider text-zinc-500">Modes</p>
          <div className="space-y-1">{modes.map(([icon, label]) => <button key={label} onClick={() => setMode(label)} className={`w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-zinc-800 ${mode === label ? 'bg-zinc-800' : ''}`}><span className="mr-2">{icon}</span>{label}</button>)}</div>
        </aside>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
          <div className="min-h-[420px] rounded-xl border border-dashed border-zinc-800 p-8 flex items-center justify-center text-center">
            <div><div className="text-5xl">🤖</div><h2 className="mt-4 text-2xl font-semibold">Que veux-tu que je fasse ?</h2><p className="mt-2 text-zinc-400">Donne une mission. L’agent choisira les outils nécessaires et vérifiera les résultats.</p></div>
          </div>
          <div className="mt-4 rounded-2xl border border-zinc-700 bg-zinc-900 p-3">
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Écris une mission..." className="min-h-24 w-full resize-none bg-transparent p-2 outline-none placeholder:text-zinc-600" />
            <div className="flex items-center justify-between"><div className="text-xs text-zinc-500">Mode : {mode}</div><button disabled={running || !prompt.trim()} onClick={runTask} className="rounded-xl bg-white px-5 py-2 text-sm font-semibold text-black disabled:opacity-40">{running ? 'Lancement…' : 'Lancer l’agent'}</button></div>
          </div>
        </div>
      </section>
    </div>
  </main>;
}
