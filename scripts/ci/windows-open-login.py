"""Open the vendor Desktop tray menu before requesting any account/token data."""
import time, sys, faulthandler
# Bound native accessibility calls before any credential is requested.
faulthandler.dump_traceback_later(40, exit=True)
from pywinauto import Application, Desktop
from pywinauto.timings import Timings
Timings.window_find_timeout = 5
Timings.window_find_retry = .2
desktop = Desktop(backend='win32')
tray = desktop.window(class_name='Shell_TrayWnd').child_window(class_name='TrayNotifyWnd')
opened = False
for toolbar in tray.descendants(class_name='ToolbarWindow32'):
    try:
        toolbar.button('SimplySign Desktop').click_input(button='right')
        opened = True
        break
    except Exception:
        pass
if not opened:
    buttons = [b for b in tray.children(class_name='Button') if b.control_id() == 1502 and b.is_visible() and b.rectangle().width() > 0 and b.rectangle().height() > 0]
    print('Native notification buttons:', [(b.window_text(), b.control_id(), str(b.rectangle())) for b in buttons])
    if len(buttons) != 1:
        raise RuntimeError('Ambiguous notification chevron')
    buttons[0].click_input()
    overflow = desktop.window(class_name='NotifyIconOverflowWindow')
    overflow.wait('visible',timeout=5)
    toolbar = overflow.child_window(class_name='ToolbarWindow32').wrapper_object()
    print('Pre-login hidden notification labels:', toolbar.texts())
    toolbar.button('SimplySign Desktop').click_input(button='right')
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
