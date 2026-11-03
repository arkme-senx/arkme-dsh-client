export function required(name){const v=process.env[name]?.trim();if(!v)throw new Error(`Missing ${name}`);return v}
export async function api(route,body,{timeout=30000,attempts=3,fetcher=fetch,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const base=new URL(required('ARKME_CI_BACKEND'));if(base.protocol!=='https:')throw new Error('HTTPS backend required');
 const url=new URL(`/api/public/v1/ci/arkme-client/${route}`,base);const headers={Authorization:`Bearer ${required('ARKME_CI_SECRET')}`,'Content-Type':'application/json'};
 for(let attempt=0;attempt<attempts;attempt++){
  let r;
  try{r=await fetcher(url,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)})}
  catch{if(attempt+1===attempts)throw new Error('CI API connection unavailable');await wait(Math.min(1000*2**attempt,15000));continue}
  if(!r.ok){await r.body?.cancel();if([408,429,502,503,504].includes(r.status)&&attempt+1<attempts){await wait(Math.min(1000*2**attempt,15000));continue}throw new Error(`CI API HTTP ${r.status}`)}
  let value;try{value=await r.json()}catch{if(attempt+1===attempts)throw new Error('CI API response unavailable');await wait(Math.min(1000*2**attempt,15000));continue}
  if(value.code!==200)throw new Error(`CI API rejected: ${value.data?.error??'unknown'}`);return value.data;
 }
 throw new Error('CI API retry limit reached');
}
export function environment(ref){if(ref==='refs/heads/pre-release')return 'test';if(ref==='refs/heads/master')return 'prod';throw new Error('Unsupported release branch')}
export function prefix(env,platform,version,code){if(!['test','prod'].includes(env)||!['windows','macos'].includes(platform)||!/^\d+\.\d+\.\d+$/.test(version)||!Number.isSafeInteger(code)||code<=0||code>2147483647)throw new Error('Invalid artifact identity');return `app/arkme/${env}/${platform}/${version}-vc${code}/`}
