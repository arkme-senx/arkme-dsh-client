export interface ScreenshotWindowRect { x:number; y:number; width:number; height:number }
export function validWindowRect(r:ScreenshotWindowRect):boolean {
 return [r.x,r.y,r.width,r.height].every(Number.isFinite) && r.width>=2 && r.height>=2;
}
/** Input rectangles share one global coordinate space; output is local image pixels, front first. */
export function windowsInFrame(windows:ScreenshotWindowRect[],display:ScreenshotWindowRect,frame:{width:number;height:number}):ScreenshotWindowRect[] {
 if(!validWindowRect(display)) return [];
 const sx=frame.width/display.width,sy=frame.height/display.height;
 return windows.filter(validWindowRect).flatMap(r=>{
  const left=Math.max(display.x,r.x),top=Math.max(display.y,r.y);
  const right=Math.min(display.x+display.width,r.x+r.width),bottom=Math.min(display.y+display.height,r.y+r.height);
  if(right<=left||bottom<=top)return [];
  const x=Math.round((left-display.x)*sx),y=Math.round((top-display.y)*sy);
  const rect={x,y,width:Math.round((right-display.x)*sx)-x,height:Math.round((bottom-display.y)*sy)-y};
  return validWindowRect(rect)?[rect]:[];
 });
}
