import {expect,it} from 'vitest';
import {inflateSync,crc32} from 'node:zlib';
import {encodeOpaqueBgraPng} from '../src/screenshot-fast-png.js';
it('writes valid lossless RGB PNG chunks with distinct channels and row boundaries',()=>{
 const bitmap=Buffer.from([3,2,1,255,30,20,10,255,0,0,255,255,255,0,0,255]);
 const png=encodeOpaqueBgraPng(bitmap,2,2)!;
 expect(png.subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
 const chunks=new Map<string,Buffer>();
 for(let offset=8;offset<png.length;){const size=png.readUInt32BE(offset),type=png.toString('ascii',offset+4,offset+8);chunks.set(type,png.subarray(offset+8,offset+8+size));expect(png.readUInt32BE(offset+8+size)).toBe(crc32(png.subarray(offset+4,offset+8+size)));offset+=size+12;}
 expect(chunks.get('IHDR')!.readUInt32BE(0)).toBe(2);expect(chunks.get('IHDR')!.readUInt32BE(4)).toBe(2);
 expect(inflateSync(chunks.get('IDAT')!)).toEqual(Buffer.from([0,1,2,3,10,20,30,0,255,0,0,0,0,255]));
});
it('leaves translucent and malformed inputs to the native encoder',()=>{
 expect(encodeOpaqueBgraPng(Buffer.from([3,2,1,128]),1,1)).toBeNull();
 expect(encodeOpaqueBgraPng(Buffer.alloc(4),2,1)).toBeNull();
 expect(encodeOpaqueBgraPng(Buffer.alloc(0),0,0)).toBeNull();
});
