"""Open the vendor Desktop tray menu before requesting any account/token data."""
import time, sys, faulthandler
# Bound native accessibility calls before any credential is requested.
faulthandler.dump_traceback_later(40, exit=True)
from pywinauto import Application, Desktop, taskbar
from pywinauto.timings import Timings
Timings.window_find_timeout = 5
Timings.window_find_retry = .2
try:
    taskbar.RightClickSystemTrayIcon('SimplySign Desktop')
except Exception:
    taskbar.RightClickHiddenSystemTrayIcon('SimplySign Desktop')
time.sleep(.5)
# The menu belongs to SimplySign, not Explorer. Prefer its native popup menu.
try:
    app = Application(backend='win32').connect(path=sys.argv[1])
    app.PopupMenu.menu_select('Connect to SimplySign')
except Exception:
    menus = Desktop(backend='uia').windows(control_type='Menu')
    matches = [item for menu in menus for item in menu.descendants(control_type='MenuItem') if item.window_text() in ('Connect to SimplySign','Connect')]
    if len(matches) != 1:
        raise RuntimeError('SimplySign Connect menu unavailable') from None
    matches[0].click_input()
print('SimplySign tray Connect selected')
