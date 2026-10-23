import {it,expect} from 'vitest';
import {pluginHostPolicy} from '../src/plugin-host-policy.js';
it('sends explicit channel and capabilities while preserving website defaults',()=>{
 expect(JSON.parse(pluginHostPolicy(false))).toEqual({schemaVersion:1,distribution:'website',capabilities:{clientSelfUpdate:true,runtimeSelfUpdate:true,executableExtensionInstall:true}});
 expect(JSON.parse(pluginHostPolicy(true))).toEqual({schemaVersion:1,distribution:'mas',capabilities:{clientSelfUpdate:false,runtimeSelfUpdate:false,executableExtensionInstall:false},credentialServicePrefix:'com.senqisi.dsh-arkme.mas'});
});

it('isolates development credentials by app data while retaining packaged and MAS identities',()=>{
 const a=JSON.parse(pluginHostPolicy(false,'/isolated space/a')).credentialServicePrefix;
 expect(a).toMatch(/^com\.senqisi\.dsh-arkme\.dev\.[a-f0-9]{24}$/);
 expect(JSON.parse(pluginHostPolicy(false,'/isolated space/a')).credentialServicePrefix).toBe(a);
 expect(JSON.parse(pluginHostPolicy(false,'/isolated space/b')).credentialServicePrefix).not.toBe(a);
 expect(JSON.parse(pluginHostPolicy(true,'/isolated space/a')).credentialServicePrefix).toBe('com.senqisi.dsh-arkme.mas');
 expect(JSON.parse(pluginHostPolicy(false)).credentialServicePrefix).toBeUndefined();
});
