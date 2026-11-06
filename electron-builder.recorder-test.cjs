const {build}=require('./package.json');
const fs=require('node:fs/promises');
const path=require('node:path');
const arch=process.env.ARKME_RUNTIME_ARCH || process.arch;
if(!['arm64','x64'].includes(arch))throw new Error('Unsupported recorder test architecture');
module.exports={
  ...build,
  appId:'cc.jiwo.arkme.local-test',productName:'arkme Local Test',executableName:'arkme Local Test',
  artifactName:'Jiwo-Recorder-Test-${version}-${os}-${arch}.${ext}',
  protocols:[{name:'Arkme Recorder Test',schemes:['arkme-local-test']}],
  directories:{output:'release-recorder-test'},
  mac:{...build.mac,appId:'cc.jiwo.arkme.local-test',executableName:'arkme Local Test',forceCodeSigning:false,identity:'-',
    icon:'build/icon-test.icns',target:['dmg','zip'],
    extendInfo:{...build.mac.extendInfo,CFBundleExecutable:'arkme Local Test'}},
  win:{...build.win,icon:'build/icon-test.png',target:['nsis','zip'],forceCodeSigning:false,
    signtoolOptions:undefined,signAndEditExecutable:false},
  nsis:{guid:'30ad6ae1-0db3-53d2-a93b-e75a460f88a2',oneClick:false,perMachine:false,allowElevation:false,
    allowToChangeInstallationDirectory:true,createDesktopShortcut:true,deleteAppDataOnUninstall:false},
  extraResources:[...(build.extraResources||[]),
    {from:`.runtime/dsh-${arch}/node_modules`,to:'app.asar.unpacked/node_modules'}],
  async afterPack(context){
    await require('./scripts/ensure-app-update-config.cjs')(context);
    const resources=process.platform==='darwin'?path.join(context.appOutDir,'arkme Local Test.app','Contents','Resources'):path.join(context.appOutDir,'resources');
    const plugin=path.join(resources,'app.asar.unpacked','node_modules','@senguoyun','dsh-arkme');
    const manifest=JSON.parse(await fs.readFile(path.join(plugin,'package.json'),'utf8'));
    await fs.writeFile(path.join(resources,'ARKME_TEST_PLUGIN.json'),JSON.stringify({schemaVersion:1,source:'bundled',
      packageName:manifest.name,packageVersion:manifest.version,pluginCommit:process.env.ARKME_RECORDER_PLUGIN_COMMIT},null,2)+'\n');
  },
};
