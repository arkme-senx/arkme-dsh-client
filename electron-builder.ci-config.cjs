const {build,versionCode}=require('./package.json');
const test=process.env.ARKME_CI_ENV==='test';if(!['test','prod'].includes(process.env.ARKME_CI_ENV))throw new Error('CI environment required');
const base=test?require('./electron-builder.test-config.cjs'):build;
const reservation=require('./reservation.json');
const cdn=process.env.ARKME_CDN_BASE;if(!cdn?.startsWith('https://'))throw new Error('HTTPS CDN base required');
const platform=process.platform==='win32'?'windows':'macos';
// Built-in notarization is replaced by the mandatory afterSign hook below;
// it requires Accepted, stapling and validation before an archive can be made.
module.exports={...base,publish:{provider:'generic',url:`${cdn.replace(/\/$/,'')}/app/arkme/${process.env.ARKME_CI_ENV}/${platform}/${reservation.version}-vc${reservation.version_code}/`},extends:'file:./electron-builder.cjs',directories:{...base.directories,output:'release-ci'},artifactName:`\${productName}-\${version}-vc${versionCode}-\${arch}.\${ext}`,mac:{...base.mac,bundleVersion:String(versionCode),forceCodeSigning:true,hardenedRuntime:true,notarize:false},dmg:{...base.dmg,sign:true},win:{...base.win,forceCodeSigning:true,signtoolOptions:{...base.win.signtoolOptions,certificateSha1:process.env.SIMPLYSIGN_CERTIFICATE_SHA1||base.win.signtoolOptions.certificateSha1}},afterSign:require('./scripts/ci/notarize-macos-app.cjs'),artifactBuildCompleted:require('./scripts/notarize-macos-dmg.cjs')};
