package main

import (
	"context"

	"github.com/egoist/mygo"
)

// Shell gives the console the window's own keys on Windows and Linux, which have no
// menu bar to hold them: Ctrl+W closes the window and Ctrl+Q quits, as macOS's menu
// does with Command (setAppMenu). See DESIGN.md, "键盘".
type Shell struct {
	tray *trayController
}

// CloseWindow closes the console's window as its close button does: Mingle keeps running.
func (*Shell) CloseWindow(ctx context.Context) {
	if w := mygo.CallerWindow(ctx); w != nil {
		w.Close()
	}
}

// Quit quits Mingle, asking first while agents are online, as the tray menu's Quit does.
func (s *Shell) Quit() { s.tray.quit() }
