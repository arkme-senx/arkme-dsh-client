import {it,expect} from 'vitest';
import {pluginHostPolicy} from '../src/plugin-host-policy.js';
it('sends explicit channel and capabilities while preserving website defaults',()=>{
 expect(JSON.parse(pluginHostPolicy(false))).toEqual({schemaVersion:1,distribution:'website',capabilities:{clientSelfUpdate:true,runtimeSelfUpdate:true,executableExtensionInstall:true}});
 expect(JSON.parse(pluginHostPolicy(true))).toEqual({schemaVersion:1,distribution:'mas',capabilities:{clientSelfUpdate:false,runtimeSelfUpdate:false,executableExtensionInstall:false},credentialServicePrefix:'com.senqisi.dsh-arkme.mas'});
});
