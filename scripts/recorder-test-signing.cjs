const {createRequire}=require('node:module');
const fs=require('node:fs/promises');
const path=require('node:path');

function signingLibrary(){
  const builderRequire=createRequire(require.resolve('electron-builder'));
  const libraryRequire=createRequire(builderRequire.resolve('app-builder-lib'));
  const entry=libraryRequire.resolve('@electron/osx-sign');
  const version=require(path.join(path.dirname(entry),'../../package.json')).version;
  if(version!=='1.3.3')throw new Error(`Review recorder test signing workaround for @electron/osx-sign ${version}`);
  return {util:require(path.join(path.dirname(entry),'util.js')),isBinaryFile:createRequire(entry)('isbinaryfile').isBinaryFile};
}

// osx-sign 1.3.3 opens every file concurrently before applying its ignore rules.
// Keep its binary/bundle discovery contract while bounding open files to one.
// This hook is installed only by electron-builder.recorder-test.cjs.
async function boundedSigningWalk(directory){
  const {isBinaryFile}=signingLibrary();
  const found=[];
  async function visit(root){
    for(const name of await fs.readdir(root)){
      const file=path.join(root,name),info=await fs.lstat(file);
      if(info.isSymbolicLink())continue;
      if(info.isDirectory()){
        await visit(file);
        if(['.app','.framework'].includes(path.extname(file)))found.push(file);
      }else if(info.isFile()){
        if(path.extname(file)==='.cstemp')await fs.rm(file);
        else if(await isBinaryFile(file))found.push(file);
      }
    }
  }
  await visit(directory);
  return found;
}

function installBoundedSigningWalk(){
  signingLibrary().util.walkAsync=boundedSigningWalk;
}
module.exports={boundedSigningWalk,installBoundedSigningWalk};
