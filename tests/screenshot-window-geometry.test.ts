import {expect,it} from 'vitest';
import {windowsInFrame} from '../src/screenshot-window-geometry.js';
it('maps negative macOS display coordinates to Retina pixels preserving front-to-back order',()=>{
 expect(windowsInFrame([{x:-700,y:-900,width:400,height:300},{x:-800,y:-1000,width:800,height:600}],{x:-800,y:-1000,width:800,height:600},{width:1600,height:1200})).toEqual([{x:200,y:200,width:800,height:600},{x:0,y:0,width:1600,height:1200}]);
});
it('clips spanning windows independently on physical Windows displays with mixed DPI',()=>{
 const windows=[{x:1800,y:100,width:600,height:500}];
 expect(windowsInFrame(windows,{x:0,y:0,width:1920,height:1080},{width:1920,height:1080})).toEqual([{x:1800,y:100,width:120,height:500}]);
 expect(windowsInFrame(windows,{x:1920,y:0,width:2560,height:1440},{width:2560,height:1440})).toEqual([{x:0,y:100,width:480,height:500}]);
});
it('uses actual frame dimensions and rejects invisible or invalid rectangles',()=>{
 expect(windowsInFrame([{x:10,y:20,width:30,height:40},{x:NaN,y:0,width:5,height:5},{x:0,y:0,width:-10,height:10},{x:300,y:0,width:20,height:20}],{x:0,y:0,width:100,height:100},{width:150,height:150})).toEqual([{x:15,y:30,width:45,height:60}]);
});
