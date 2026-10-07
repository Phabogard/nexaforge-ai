'use client';

import { useEffect, useMemo, useState } from 'react';

const modes=[['🤖','Auto'],['🔎','Recherche'],['🕵️','Fact-check'],['🔬','Deep Research'],['👁️','Vision'],['🖥️','Computer Use'],['🌐','Navigateur'],['📈','Trading'],['📊','Graphique'],['🧮','Probabilités'],['🎯','Simulation'],['📁','Documents'],['🧑‍💻','Code'],['📰','Actualités'],['🔔','Monitoring'],['🧠','Étude']];
const apiUrl=process.env.NEXT_PUBLIC_API_URL??'http://localhost:4000';
type Task={id:string;status:string;result?:{answer?:string;calls?:unknown[];error?:string}};
type Workspace={id:string;name:string};

export default function Home(){
  const[mode,setMode]=useState('Auto'),[prompt,setPrompt]=useState(''),[running,setRunning]=useState(false),[workspace,setWorkspace]=useState<Workspace|null>(null),[task,setTask]=useState<Task|null>(null),[error,setError]=useState<string|null>(null),[email,setEmail]=useState('');
  const apiMode=useMemo(()=>mode.toLowerCase().replaceAll(' ','-'),[mode]);

  useEffect(()=>{void(async()=>{const r=await fetch('/api/auth/get-session',{cache:'no-store'});const d=r.ok?await r.json():null;if(!d?.user){window.location.href='/auth';return;}setEmail(typeof d.user.email==='string'?d.user.email:'');})();},[]);

  async function getToken(){const r=await fetch('/api/auth/token',{cache:'no-store'});const d=await r.json() as{token?:string};if(!r.ok||!d.token)throw new Error('Jeton d’authentification indisponible');return d.token;}

  async function ensureWorkspace(){
    if(workspace)return workspace;
    const token=await getToken();
    const r=await fetch(apiUrl+'/api/v1/workspaces',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:'{}'});
    const d=await r.json();if(!r.ok)throw new Error(d.error??'Impossible de créer le workspace');setWorkspace(d.workspace);return d.workspace as Workspace;
  }

  async function runTask(){
    if(!prompt.trim()||running)return;
    setRunning(true);setError(null);
    try{
      const ws=await ensureWorkspace(),token=await getToken();
      const sr=await fetch(apiUrl+'/api/v1/agent-sessions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({agentId:'personal-assistant',agentType:'PersonalAssistantAgent',workspaceId:ws.id,requiredCapabilities:['ai.execute']})});
      const sd=await sr.json();if(!sr.ok)throw new Error(sd.error??'Impossible de créer la session agent');
      const er=await fetch(apiUrl+'/api/v1/agent-sessions/'+sd.session.id+'/execute',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({prompt,mode:apiMode,requiredCapabilities:['ai.execute'],maxIterations:12})});
      const ed=await er.json();if(!er.ok)throw new Error(ed.error??'Exécution agent échouée');
      setTask({...ed.task,status:'completed',result:ed.result});
    }catch(e){setError(e instanceof Error?e.message:'Erreur inconnue');}finally{setRunning(false);}
  }
  async function signOut(){await fetch('/api/auth/sign-out',{method:'POST'});window.location.href='/auth';}

  return <main className="min-h-screen bg-zinc-950 text-white p-6"><div className="mx-auto max-w-6xl">
    <header className="flex items-center justify-between py-4"><div><h1 className="text-2xl font-bold">NexaForge AI</h1><p className="text-sm text-zinc-400">Agent workspace</p></div><div className="flex items-center gap-3"><span className="text-xs text-zinc-400">{email}</span><button onClick={signOut} className="rounded-lg border border-zinc-700 px-3 py-1 text-xs">Déconnexion</button><span className="rounded-full border border-zinc-700 px-3 py-1 text-xs">{mode}</span></div></header>
    <section className="mt-10 grid gap-6 lg:grid-cols-[220px_1fr]"><aside className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-3"><p className="px-3 pb-3 text-xs uppercase tracking-wider text-zinc-500">Modes</p><div className="space-y-1">{modes.map(([icon,label])=><button key={label} onClick={()=>setMode(label)} className={`w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-zinc-800 ${mode===label?'bg-zinc-800':''}`}><span className="mr-2">{icon}</span>{label}</button>)}</div></aside>
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6"><div className="min-h-[420px] rounded-xl border border-dashed border-zinc-800 p-8 text-center"><div className="text-5xl">{task?'✨':'🤖'}</div><h2 className="mt-4 text-2xl font-semibold">{task?'Mission terminée':'Que veux-tu que je fasse ?'}</h2>{task?.result?.answer?<div className="mt-5 whitespace-pre-wrap rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5 text-left leading-7 text-zinc-200">{task.result.answer}</div>:<p className="mt-2 text-zinc-400">{error??'Connecte-toi puis donne une mission. Chaque exécution passe par une session agent et les contrôles de permission.'}</p>}{task&&<p className="mt-3 text-xs text-zinc-600">Task ID : {task.id}</p>}{error&&<div className="mt-5 rounded-xl border border-red-900/60 bg-red-950/30 p-3 text-left text-sm text-red-300">{error}</div>}</div>
      <div className="mt-4 rounded-2xl border border-zinc-700 bg-zinc-900 p-3"><textarea value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="Écris une mission…" className="min-h-24 w-full resize-none bg-transparent p-2 outline-none placeholder:text-zinc-600"/><div className="flex items-center justify-between"><div className="text-xs text-zinc-500">Mode : {mode}</div><button disabled={running||!prompt.trim()} onClick={runTask} className="rounded-xl bg-white px-5 py-2 text-sm font-semibold text-black disabled:opacity-40">{running?'Exécution…':'Lancer l’agent'}</button></div></div></div>
    </section></div></main>;
}
