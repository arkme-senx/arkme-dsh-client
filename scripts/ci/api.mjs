export function required(name){const v=process.env[name]?.trim();if(!v)throw new Error(`Missing ${name}`);return v}
export async function api(route,body,{timeout=30000}={}){
 const base=new URL(required('ARKME_CI_BACKEND'));if(base.protocol!=='https:')throw new Error('HTTPS backend required');
 const r=await fetch(new URL(`/api/public/v1/ci/arkme-client/${route}`,base),{method:'POST',headers:{Authorization:`Bearer ${required('ARKME_CI_SECRET')}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
 if(!r.ok)throw new Error(`CI API HTTP ${r.status}`);const value=await r.json();if(value.code!==200)throw new Error(`CI API rejected: ${value.data?.error??'unknown'}`);return value.data;
}
export function environment(ref){if(ref==='refs/heads/pre-release')return 'test';if(ref==='refs/heads/master')return 'prod';throw new Error('Unsupported release branch')}
export function prefix(env,platform,version,code){if(!['test','prod'].includes(env)||!['windows','macos'].includes(platform)||!/^\d+\.\d+\.\d+$/.test(version)||!Number.isSafeInteger(code)||code<=0||code>2147483647)throw new Error('Invalid artifact identity');return `app/arkme/${env}/${platform}/${version}-vc${code}/`}
