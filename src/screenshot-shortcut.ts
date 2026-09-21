const modifiers = ['Command', 'Control', 'Alt', 'Shift'];
export function normalizeShortcut(value: unknown): string | null {
 if(typeof value !== 'string') return null;
 const parts=value.split('+'), key=parts.pop();
 if(!key || !/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(key) || !parts.length || new Set(parts).size!==parts.length
  || parts.some(p=>!modifiers.includes(p)) || !parts.some(p=>p!=='Shift')) return null;
 return [...modifiers.filter(p=>parts.includes(p)),key].join('+');
}
export class ScreenshotShortcut {
 private accelerator: string; private registered=false; private paused=false;
 constructor(platform:string, private api:{register(key:string,callback:()=>void):boolean;unregister(key:string):void},private save:(key:string)=>void,private trigger:()=>void,saved?:unknown){
  this.accelerator=normalizeShortcut(saved) ?? (platform==='darwin'?'Command+Shift+A':'Control+Shift+A');this.registered=this.api.register(this.accelerator,this.trigger);
 }
 snapshot(){return {accelerator:this.accelerator,available:this.registered || this.paused};}
 pause(value:boolean){if(this.paused===value)return;this.paused=value;if(value){if(this.registered)this.api.unregister(this.accelerator);this.registered=false;}else this.registered=this.api.register(this.accelerator,this.trigger);}
 set(value:unknown){
  const next=normalizeShortcut(value);if(!next)throw Error('请使用 Command、Ctrl 或 Alt 加字母、数字或功能键的组合');
  if(next===this.accelerator && this.registered)return this.snapshot();
  if(!this.api.register(next,this.trigger))throw Error('该快捷键已被占用或不可用，请更换组合');
  try{this.save(next);}catch{this.api.unregister(next);throw Error('快捷键保存失败，请重试');}
  if(this.registered && next!==this.accelerator)this.api.unregister(this.accelerator);
  this.accelerator=next;this.registered=true;
  if(this.paused){this.api.unregister(next);this.registered=false;}
  return this.snapshot();
 }
 dispose(){if(this.registered)this.api.unregister(this.accelerator);}
}
