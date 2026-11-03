// Parent PowerShell reads the one-time value through a redirected pipe; never invoke in a logging step.
import {generateKeyPairSync,privateDecrypt,constants} from 'node:crypto';import {readFile} from 'node:fs/promises';import {api} from './api.mjs';
const b=JSON.parse(await readFile('reservation.json','utf8'));const attempt=Number(process.argv[2]??1);const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:3072});const identity={batch_id:b.id,run_id:b.run_id};let task;
try{
 task=await api('signing/tasks/create',{...identity,attempt,invocation_run_id:process.env.GITHUB_RUN_ID,build_attempt:Number(process.env.GITHUB_RUN_ATTEMPT),public_key:publicKey.export({type:'spki',format:'pem'})});
 while(Date.now()<task.deadline*1000){const result=await api('signing/tasks/result',{...identity,task_id:task.id});if(['failed','expired','cancelled','consumed'].includes(result.status))throw new Error('Signing task unavailable');if(result.status==='ready'){
  const plain=privateDecrypt({key:privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(result.ciphertext,'base64'));let token;try{token=JSON.parse(plain.toString())}finally{plain.fill(0)}
  if(token.task_id!==task.id||token.attempt!==attempt||token.expires_at<Date.now()/1000+15||token.expires_at!==result.expires_at||!/^\d{6}$/.test(token.token))throw new Error('Invalid signing token');await api('signing/tasks/ack',{...identity,task_id:task.id});process.stdout.write(token.token);token.token='';process.exit(0)
 }await new Promise(r=>setTimeout(r,1000))};throw new Error('Signing task timed out');
}catch{if(task)await api('signing/tasks/cancel',{...identity,task_id:task.id}).catch(()=>{});process.stderr.write('Signing token unavailable\n');process.exitCode=1}
