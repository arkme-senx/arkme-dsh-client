import {test,expect} from 'vitest';
import {environment,prefix} from '../scripts/ci/api.mjs';
test('release environments are bound to protected source branches',()=>{
 expect(environment('refs/heads/master')).toBe('prod');expect(environment('refs/heads/pre-release')).toBe('test');expect(()=>environment('refs/heads/feature')).toThrow();
});
test('OSS directories preserve environment/platform/version identity',()=>{
 for(const env of ['test','prod'])for(const platform of ['macos','windows'])expect(prefix(env,platform,'3.0.0',277)).toBe(`app/arkme/${env}/${platform}/3.0.0-vc277/`);
 for(const args of [['dev','macos','3.0.0',277],['test','darwin','3.0.0',277],['test','macos','../x',277],['test','macos','3.0.0',0]] as [string,string,string,number][])expect(()=>prefix(...args)).toThrow();
});
