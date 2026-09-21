import { describe, it, expect } from 'vitest';
import { ScreenshotSession, decodeScreenshotPng } from '../src/desktop-screenshot-session.js';
const frame = { contentBase64: 'png', width: 2000, height: 1000 };
describe('screenshot session', () => {
 it('has one owner, rejects other request IDs and locks the chosen screen', () => {
  const s = new ScreenshotSession(1, 'request', 'account'); s.add(20, frame); s.add(21, frame);
  expect(s.ownedBy(2, 'request')).toBe(false); expect(s.ownedBy(1, 'old')).toBe(false);
  expect(s.ownedBy(1, 'request')).toBe(true); expect(s.context(22, 'account')).toBeNull();
  expect(s.select(20, 'account')).toBe(true); expect(s.select(21, 'account')).toBe(false);
  expect(s.context(21, 'account')).toBeNull(); expect(s.context(20, 'account')).toEqual(frame);
 });
 it('revokes all access after scope change or close and refuses late frames', () => {
  const s = new ScreenshotSession(1, 'request', 'account'); s.add(20, frame);
  expect(s.context(20, 'other')).toBeNull(); s.close();
  expect(s.add(21, frame)).toBe(false); expect(s.context(20, 'account')).toBeNull();
  expect(s.select(20, 'account')).toBe(false);
 });
 it('accepts only bounded PNG data with positive dimensions', () => {
  const png = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
  png.writeUInt32BE(13,8); png.write('IHDR',12); png.writeUInt32BE(100,16); png.writeUInt32BE(50,20);
  expect(decodeScreenshotPng(png.toString('base64'))).toEqual(png);
  expect(() => decodeScreenshotPng('hello')).toThrow();
  png.writeUInt32BE(0,16); expect(() => decodeScreenshotPng(png.toString('base64'))).toThrow();
  png.writeUInt32BE(100000,16); expect(() => decodeScreenshotPng(png.toString('base64'))).toThrow();
 });
});
