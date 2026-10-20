import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConversationDraftStorage } from '../src/conversation-draft-storage.js';
import { ConversationWindows } from '../src/conversation-windows.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true}); });
async function root() { const root = await mkdtemp(path.join(tmpdir(), 'arkme drafts ')); roots.push(root); return root; }
const draft = {kind: 'draft' as const, key: 'arkme-composer:7:source:private_chat:a', value: {text: '关闭后保留', attachments: [], mentions: [], emojis: []}};
it('restores opaque drafts, articles, and cleared tombstones after a new process owner is constructed', async () => {
 const directory = await root();
 const store = new ConversationDraftStorage(directory, 'prod:7'); await store.load();
 await store.save(draft); await store.save({kind:'article',key:'article',value:{title:'长文'}});
 expect(await new ConversationDraftStorage(directory,'prod:7').load()).toEqual(expect.arrayContaining([draft]));
 await store.save({...draft,value:null});
 expect(await new ConversationDraftStorage(directory,'prod:7').load()).toEqual(expect.arrayContaining([{...draft,value:null}]));
 expect(await new ConversationDraftStorage(directory,'test:7').load()).toEqual([]);
 expect(await new ConversationDraftStorage(directory,'prod:8').load()).toEqual([]);
 expect(await new ConversationDraftStorage(await root(),'prod:7').load()).toEqual([]);
});
it('writes only the changed key, serializes concurrent edits, and bounds queued work', async () => {
 const directory = await root(); const store = new ConversationDraftStorage(directory,'prod:7'); await store.load();
 await store.save(draft); await store.save({...draft,key:'unrelated',value:{text:'不变'}});
 const accountDirectory = path.join(directory,(await readdir(directory))[0]!);
 const before = await Promise.all((await readdir(accountDirectory)).map(async file => [file,await readFile(path.join(accountDirectory,file),'utf8')]));
 const writes = Array.from({length:64},(_,i)=>store.save({...draft,value:{text:String(i)}}));
 await expect(store.save({...draft,value:{text:'overflow'}})).rejects.toThrow('繁忙'); await Promise.all(writes);
 expect(await new ConversationDraftStorage(directory,'prod:7').load()).toEqual(expect.arrayContaining([{...draft,value:{text:'63'}}]));
 expect((await readdir(accountDirectory)).every(file=>file.endsWith('.json'))).toBe(true);
 for (const [file,raw] of before) if (JSON.parse(raw!).event.key === 'unrelated') expect(await readFile(path.join(accountDirectory,file!),'utf8')).toBe(raw);
 await expect(store.save({...draft,value:'x'.repeat(2*1024*1024)})).rejects.toThrow('大小');
});
it('preserves malformed files rather than returning an empty recoverable snapshot', async () => {
 const directory=await root(); const store=new ConversationDraftStorage(directory,'prod:7'); await store.load(); await store.save(draft);
 const accountDirectory=path.join(directory,(await readdir(directory))[0]!); const file=path.join(accountDirectory,(await readdir(accountDirectory))[0]!);
 await writeFile(file,'broken'); await expect(new ConversationDraftStorage(directory,'prod:7').load()).rejects.toThrow(); expect(await readFile(file,'utf8')).toBe('broken');
});
it('restores through the broker across null boot state, runtime port changes and a completely new main process', async () => {
 const directory=await root(); let scope='http://localhost:1';
 const make=()=>new ConversationWindows({scope:()=>scope,create:()=>{throw new Error('unused')},notify:()=>{},persistence:account=>new ConversationDraftStorage(directory,account)});
 const first=make(); await first.setAccount('prod:7'); await first.publish(0,draft);
 scope='http://localhost:2'; await first.setAccount(null); await first.setAccount('prod:7'); expect(first.snapshot()).toEqual([draft]);
 const second=make(); await second.setAccount(null); await second.setAccount('prod:7'); expect(second.snapshot()).toEqual([draft]);
 await second.publish(0,{...draft,value:null});
 const third=make(); await third.setAccount('prod:7'); expect(third.snapshot()).toEqual([{...draft,value:null}]);
 await third.setAccount('test:7'); expect(third.snapshot()).toEqual([]);
});
it('drains accepted saves across a transient null account before reloading the same account', async () => {
 let complete!: () => void, reads = 0;
 const writing = new Promise<void>(resolve => { complete = resolve; });
 let disk: typeof draft[] = [], tail: Promise<void> = Promise.resolve();
 const manager = new ConversationWindows({scope:()=> 'profile',create:()=>{throw new Error('unused')},notify:()=>{},persistence:()=>({
  load:async()=>{reads++;return disk;},
  save:event=>tail=writing.then(()=>{disk=[event as typeof draft];}),
  flush:async()=>{await tail;},
 })});
 await manager.setAccount('prod:7'); const saving=manager.publish(0,draft);
 const leaving=manager.setAccount(null), returning=manager.setAccount('prod:7');
 await new Promise(resolve=>setTimeout(resolve,10)); expect(reads).toBe(1);
 complete(); await Promise.all([saving,leaving,returning]); expect(manager.snapshot()).toEqual([draft]);
});
