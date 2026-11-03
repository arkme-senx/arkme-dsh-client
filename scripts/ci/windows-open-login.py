"""Open the vendor Desktop tray menu before requesting any account/token data."""
import time, sys, faulthandler, json
from pathlib import Path
# Bound native accessibility calls before any credential is requested.
faulthandler.dump_traceback_later(75, exit=True)
from pywinauto import Application, Desktop
from pywinauto.timings import Timings
Timings.window_find_timeout = 5
Timings.window_find_retry = .2
desktop = Desktop(backend='win32')
tray = desktop.window(class_name='Shell_TrayWnd').child_window(class_name='TrayNotifyWnd')
from pywinauto.keyboard import send_keys
def login_visible():
    app = Application(backend='win32').connect(path=sys.argv[1])
    return any(len([c for c in w.descendants() if c.class_name().startswith('WindowsForms10.EDIT.') and c.is_visible() and c.is_enabled()]) == 2 for w in app.windows())
for opening_attempt in range(3):
    try:
        opened = False
        for toolbar in tray.descendants(class_name='ToolbarWindow32'):
            if not toolbar.is_visible():
                continue
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
            app.PopupMenu.wait('visible',timeout=5)
            app.PopupMenu.menu_select('Connect to SimplySign')
        except Exception:
            menus = Desktop(backend='uia').windows(control_type='Menu')
            matches = [item for menu in menus for item in menu.descendants(control_type='MenuItem') if item.window_text() in ('Connect to SimplySign','Connect')]
            if len(matches) != 1:
                raise RuntimeError('SimplySign Connect menu unavailable') from None
            matches[0].click_input()
        break
    except Exception:
        if login_visible():
            break
        if opening_attempt == 2:
            raise RuntimeError('SimplySign Connect menu unavailable after bounded retries') from None
        send_keys('{ESC}')
        time.sleep(1)
print('SimplySign tray Connect selected')

app = Application(backend='win32').connect(path=sys.argv[1])
found = None
deadline = time.monotonic() + 10
while time.monotonic() < deadline:
    for window in app.windows():
        children = window.descendants()
        edits = sorted([c for c in children if c.class_name().startswith('WindowsForms10.EDIT.') and c.is_visible() and c.is_enabled()], key=lambda c:c.rectangle().top)
        buttons = [c for c in children if c.class_name().startswith('WindowsForms10.BUTTON.') and c.is_visible() and c.is_enabled() and c.window_text().replace('&','').strip().lower() == 'ok']
        if len(edits) == 2 and len(buttons) == 1 and edits[0].rectangle().top < edits[1].rectangle().top:
            found = {'account':edits[0].handle,'token':edits[1].handle,'submit':buttons[0].handle}
            break
    if found:
        break
    time.sleep(.2)
if not found:
    raise RuntimeError('Native login fields unavailable')
Path(sys.argv[2]).write_text(json.dumps(found), encoding='utf-8')
print('Verified native ID, Token and OK controls; no credentials requested yet')
