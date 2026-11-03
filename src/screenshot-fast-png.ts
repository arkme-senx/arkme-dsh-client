import {crc32,deflateSync} from 'node:zlib';

function chunk(type:string,data:Buffer):Buffer {
 const result=Buffer.allocUnsafe(data.length+12);
 result.writeUInt32BE(data.length,0);result.write(type,4,4,'ascii');data.copy(result,8);
 result.writeUInt32BE(crc32(result.subarray(4,-4)),result.length-4);
 return result;
}
/** Lossless, low-compression PNG for opaque macOS BGRA screen bitmaps.
 * No filters or alpha conversion: unsupported/translucent input uses Electron's encoder.
 * Final user exports still go through the existing editor/export path.
 */
export function encodeOpaqueBgraPng(bitmap:Buffer,width:number,height:number):Buffer|null {
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>16384||height>16384||width*height>64_000_000
  ||bitmap.length!==width*height*4)return null;
 const stride=width*3+1,raw=Buffer.allocUnsafe(stride*height);
 let source=0,target=0;
 for(let y=0;y<height;y++) {
  raw[target++]=0;
  for(let x=0;x<width;x++,source+=4) {
   if(bitmap[source+3]!==255)return null;
   raw[target++]=bitmap[source+2]!;raw[target++]=bitmap[source+1]!;raw[target++]=bitmap[source]!;
  }
 }
 const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw,{level:1})),chunk('IEND',Buffer.alloc(0))]);
}
