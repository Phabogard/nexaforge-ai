import { NextRequest } from 'next/server';

const AUTH_BASE_URL=(process.env.NEON_AUTH_BASE_URL??'https://ep-rough-math-ay2jp7y3.neonauth.c-5.us-east-2.aws.neon.tech/neondb/auth').replace(/\/$/,'');
export const dynamic='force-dynamic';

async function proxy(request:NextRequest,path:string[]){
  const response=await fetch(AUTH_BASE_URL+'/'+path.join('/')+request.nextUrl.search,{
    method:request.method,
    headers:new Headers(request.headers),
    body:request.method==='GET'||request.method==='HEAD'?undefined:await request.arrayBuffer(),
    redirect:'manual'
  });
  const headers=new Headers(response.headers);
  const cookies=response.headers.getSetCookie?.()??[];
  headers.delete('set-cookie');
  for(const cookie of cookies) headers.append('set-cookie',cookie);
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
export async function GET(request:NextRequest,context:{params:Promise<{path:string[]}>}){return proxy(request,(await context.params).path);}
export async function POST(request:NextRequest,context:{params:Promise<{path:string[]}>}){return proxy(request,(await context.params).path);}
export async function PUT(request:NextRequest,context:{params:Promise<{path:string[]}>}){return proxy(request,(await context.params).path);}
export async function DELETE(request:NextRequest,context:{params:Promise<{path:string[]}>}){return proxy(request,(await context.params).path);}
