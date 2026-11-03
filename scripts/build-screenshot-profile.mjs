// Usage: node scripts/build-screenshot-profile.mjs /absolute/path/to/arkme-dsh-plugin
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
if(!process.argv[2])throw new Error('Provide the instrumented plugin checkout path');
const plugin=path.resolve(process.argv[2]),require=createRequire(path.join(plugin,'package.json'));
const {build}=await import(pathToFileURL(require.resolve('vite')).href);
const root=await mkdtemp(path.join(os.tmpdir(),'arkme-screenshot-profile-'));
await writeFile(path.join(root,'index.html'),'<html><head><style>html,body,#root{margin:0;width:100%;height:100%}</style></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
await writeFile(path.join(root,'entry.tsx'),`import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};\nimport {ArkmeScreenshotWindow} from ${JSON.stringify(path.join(plugin,'src/client/ArkmeScreenshotWindow.tsx'))};\ncreateRoot(document.getElementById('root')!).render(<ArkmeScreenshotWindow/>);`);
const outDir=path.join(root,'build');
await build({configFile:false,root,esbuild:{jsx:'automatic'},build:{outDir,emptyOutDir:true},resolve:{alias:{'react/jsx-runtime':require.resolve('react/jsx-runtime')}}});
console.log(outDir);
