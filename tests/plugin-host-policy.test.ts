import {it,expect} from 'vitest';
import {pluginHostEnvironment,pluginHostPolicy} from '../src/plugin-host-policy.js';
it('sends explicit channel and capabilities while preserving website defaults',()=>{
 expect(JSON.parse(pluginHostPolicy(false))).toEqual({schemaVersion:1,distribution:'website',capabilities:{clientSelfUpdate:true,runtimeSelfUpdate:true,executableExtensionInstall:true}});
 expect(JSON.parse(pluginHostPolicy(true))).toEqual({schemaVersion:1,distribution:'mas',capabilities:{clientSelfUpdate:false,runtimeSelfUpdate:false,executableExtensionInstall:false},credentialServicePrefix:'com.senqisi.dsh-arkme.mas'});
});

it('keeps MAS native addons inside the signed bundle without changing website loading',()=>{
 const mas=pluginHostEnvironment(true);
 expect(mas.NARB_DISABLE_NATIVE_CACHE).toBe('1');
 expect(JSON.parse(mas.ARKME_HOST_POLICY!)).toEqual(JSON.parse(pluginHostPolicy(true)));
 const website=pluginHostEnvironment(false,'/isolated space/a');
 expect(website.ARKME_DEVELOPMENT_HOST).toBe("1");
 expect(pluginHostEnvironment(false)).not.toHaveProperty("ARKME_DEVELOPMENT_HOST");
 expect(mas).not.toHaveProperty("ARKME_DEVELOPMENT_HOST");
 expect(website).not.toHaveProperty('NARB_DISABLE_NATIVE_CACHE');
 expect(website.ARKME_HOST_POLICY).toBe(pluginHostPolicy(false,'/isolated space/a'));
});

it('isolates development credentials by app data while retaining packaged and MAS identities',()=>{
 const a=JSON.parse(pluginHostPolicy(false,'/isolated space/a')).credentialServicePrefix;
 expect(a).toMatch(/^com\.senqisi\.dsh-arkme\.dev\.[a-f0-9]{24}$/);
 expect(JSON.parse(pluginHostPolicy(false,'/isolated space/a')).credentialServicePrefix).toBe(a);
 expect(JSON.parse(pluginHostPolicy(false,'/isolated space/b')).credentialServicePrefix).not.toBe(a);
 expect(JSON.parse(pluginHostPolicy(true,'/isolated space/a')).credentialServicePrefix).toBe('com.senqisi.dsh-arkme.mas');
 expect(JSON.parse(pluginHostPolicy(false)).credentialServicePrefix).toBeUndefined();
});
