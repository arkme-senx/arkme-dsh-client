import { describe, expect, test, vi } from "vitest";
import { MacPointerWindowDrag } from "../src/mac-pointer-window-drag.js";

function fixture(platform: NodeJS.Platform = "darwin") {
  const window = { isDestroyed: () => false, isFocused: () => true, isVisible: () => true,
    isFullScreen: () => false, isMaximized: () => false,
    getPosition: (): [number, number] => [100, 200], setPosition: vi.fn() };
  return { window, drag: new MacPointerWindowDrag(platform, window) };
}
const point = (kind: string, id = 'one', x = 500, y = 400) => ({ kind, id, x, y });
describe('macOS pointer window drag', () => {
  test('normalizes rounded negative zero on both axes at screen-origin crossings', () => {
    const { drag, window } = fixture();
    drag.accept(point('begin'));
    // Window origin [100, 200] + pointer delta produces [-0.25, -0.25].
    drag.accept(point('move', 'one', 399.75, 199.75));
    const [x, y] = window.setPosition.mock.lastCall!;
    expect(Object.is(x, 0)).toBe(true);
    expect(Object.is(y, 0)).toBe(true);
    drag.accept(point('move', 'one', 398.75, 198.75));
    expect(window.setPosition).toHaveBeenLastCalledWith(-1, -1, false);
    drag.accept(point('move', 'one', 400.75, 200.75));
    expect(window.setPosition).toHaveBeenLastCalledWith(1, 1, false);
  });
  test('uses absolute gesture origin, supports negative screen coordinates and ends by token', () => {
    const { drag, window } = fixture();
    drag.accept(point('begin'));
    drag.accept(point('move', 'one', 540, 460));
    expect(window.setPosition).toHaveBeenLastCalledWith(140, 260, false);
    drag.accept(point('move', 'one', -200, -100));
    expect(window.setPosition).toHaveBeenLastCalledWith(-600, -300, false);
    drag.accept({ kind: 'end', id: 'one' });
    drag.accept(point('move'));
    expect(window.setPosition).toHaveBeenCalledTimes(2);
  });
  test('rejects malformed payloads, stale tokens and movement without a gesture', () => {
    const { drag, window } = fixture();
    drag.accept(point('move'));
    drag.accept(point('begin'));
    drag.accept(point('begin', 'two'));
    drag.accept({ kind: 'end', id: 'one' });
    for (const value of [null, {}, point('move', 'one'), point('move', 'two', NaN), point('move', 'two', Infinity), point('move', 'two', 1e9)]) drag.accept(value);
    expect(window.setPosition).not.toHaveBeenCalled();
    drag.accept(point('move', 'two', 550));
    expect(window.setPosition).toHaveBeenCalledOnce();
  });
  test('cancels on loss of focus and refuses non-macOS, maximized and full-screen windows', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const { drag, window } = fixture(platform);
      drag.accept(point('begin')); drag.accept(point('move'));
      expect(window.setPosition).not.toHaveBeenCalled();
    }
    for (const flag of ['isFullScreen', 'isMaximized'] as const) {
      const { drag, window } = fixture(); window[flag] = () => true;
      drag.accept(point('begin')); drag.accept(point('move'));
      expect(window.setPosition).not.toHaveBeenCalled();
    }
    const { drag, window } = fixture();
    drag.accept(point('begin')); window.isFocused = () => false;
    drag.accept(point('move')); window.isFocused = () => true;
    drag.accept(point('move'));
    expect(window.setPosition).not.toHaveBeenCalled();
    drag.accept(point('begin')); drag.cancel(); drag.accept(point('move'));
    expect(window.setPosition).not.toHaveBeenCalled();
  });
});
