import {describe,it,expect} from 'vitest';
import {acceptsGamePopup,acceptsGameDocument} from '../src/game-window-policy.js';
const origin='http://127.0.0.1:3000',name='arkme-game-12345678-1234-1234-1234-123456789012';
describe('game popup policy',()=>{
 it('allows only the named blank bootstrap from active harness',()=>{expect(acceptsGamePopup('about:blank',name,origin+'/chat',origin)).toBe(true);expect(acceptsGamePopup('https://evil.test',name,origin,origin)).toBe(false);expect(acceptsGamePopup('about:blank','other',origin,origin)).toBe(false);expect(acceptsGamePopup('about:blank',name,'https://evil.test',origin)).toBe(false)});
 it('allows only the exact same-origin game document without credentials in URL',()=>{expect(acceptsGameDocument(origin+'/arkme-self/api/game/index.html',origin)).toBe(true);for(const url of [origin+'/arkme-self/api/call/index.html',origin+'/arkme-self/api/game/index.html?token=secret','https://evil.test/game/index.html',origin+'/game/index.html#key'])expect(acceptsGameDocument(url,origin)).toBe(false)});
});
