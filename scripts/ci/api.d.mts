export function required(name:string):string;
export function api(route:string,body:unknown,options?:{timeout?:number}):Promise<any>;
export function environment(ref:string):'test'|'prod';
export function prefix(env:string,platform:string,version:string,code:number):string;
