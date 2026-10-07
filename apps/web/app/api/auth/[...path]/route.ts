import { NextRequest } from 'next/server';

const AUTH_BASE_URL=(process.env.NEON_AUTH_BASE_URL??'https://ep-rough-math-ay2jp7y3.neonauth.c-5.us-east-2.aws.neon.tech/neondb/auth').replace(/\/$/,'');
export const dynamic='force-dynamic';

async function proxy(request:NextRequest,path:string[]){
  const headers=new Headers(request.headers);
  headers.delete('host');
  headers.delete('content-length');
  headers.delete('x-forwarded-host');
  headers.delete('x-forwarded-port');
  headers.delete('x-forwarded-proto');
  const response=await fetch(AUTH_BASE_URL+'/'+path.join('/')+request.nextUrl.search,{
    method:request.method,
    headers,
    body:request.method==='GET'||request.method==='HEAD'?undefined:await request.arrayBuffer(),
    redirect:'manual'
  });
  const responseHeaders=new Headers(response.headers);
  const cookies=response.headers.getSetCookie?.()??[];
  responseHeaders.delete('set-cookie');
  for(const cookie of cookies) responseHeaders.append('set-cookie',cookie);
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers:responseHeaders});
}
export async function GET(request:NextRequest,context:{params:Promise<{path:string[]}>}){return proxy(request,(await context.params).path);}
export async function POST(request:NextRequest,context:{params:Promise<{path:string[]}>}){return proxy(request,(await context.params).path);}
export async function PUT(request:NextRequest,context:{params:Promise<{path:string[]}>}){return proxy(request,(await context.params).path);}
export async function DELETE(request:NextRequest,context:{params:Promise<{path:string[]}>}){return proxy(request,(await context.params).path);}
