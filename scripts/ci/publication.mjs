// A publication validates large signed packages behind gateways with short HTTP limits.
// Submit durably, then poll; never treat an accepted/validating batch as published.
export async function publishBatch(api,envelope,{timeout=40*60*1000,now=Date.now,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const identity={batch_id:envelope.batch_id,run_id:envelope.run_id};let status;
 try{status=await api('releases',{...envelope,async:true})}
 catch(error){status=await api('releases/status',identity);if(!['queued','validating','published'].includes(status.status))throw error}
 const deadline=now()+timeout;let backoff=2000;
 for(;;){
  if(status.status==='published')return status;
  if(status.status==='failed')throw new Error('Backend publication validation failed; retry the original batch after resolving the cause');
  if(!['queued','validating'].includes(status.status))throw new Error('Unexpected publication state');
  if(now()>=deadline)throw new Error('Publication still pending; rerun the original workflow to resume this batch');
  await wait(backoff);
  try{status=await api('releases/status',identity);backoff=2000}catch{backoff=Math.min(backoff*2,15000)}
 }
}
