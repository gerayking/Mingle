// Mingle's desktop app: a menu bar icon and a window around the same local
// console that `mingle start` serves. The app starts the Mingle process with
// the Node.js runtime it ships, keeps it running, and stops it on quit.
// See docs/spec.md, "桌面应用".
package main

import (
	_ "embed"
	"log"
	"runtime"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/updater"
)

//go:embed resources/tray.png
var trayTemplate []byte

const (
	goos      = runtime.GOOS
	isMac     = goos == "darwin"
	isWindows = goos == "windows"
)

func main() {
	if !mygo.App.RequestSingleInstanceLock() {
		return // the running app shows its window
	}
	// The web console and native controls share the system's supported language.
	mygo.App.SetLanguages("en", "zh-CN")
	clearWebCachesAfterUpdate()
	logs, _ := mygo.App.Path(mygo.PathLogs)
	resources, _ := mygo.App.Path(mygo.PathResources)
	d := newDaemon(resources, logs)
	origin := d.origin()
	t := newTexts()

	// Mingle releases often: check every few hours, and let the console offer the update.
	mygo.Use(updater.New(updater.Options{Interval: 6 * time.Hour}))
	updates := newUpdates()
	// A menu bar app: the Dock icon shows only while the window does.
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)
	mygo.App.OnWindowAllClosed(func() {})

	var win *mygo.Window
	quitting := false
	show := func() {
		if win == nil {
			return
		}
		mygo.App.SetActivationPolicy(mygo.ActivationPolicyRegular)
		win.Show()
		win.Focus()
		mygo.App.Focus()
	}
	tray := newTrayController(t, logs, updates, show)
	mygo.Bind(updates, newOnline(tray), &Appearance{}, &Shell{tray: tray})
	mygo.App.OnSecondInstance(func([]string, string) { show() })
	mygo.App.OnActivate(func(bool) { show() })
	mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) { quitting = true })
	mygo.App.OnWillQuit(func(*mygo.QuitEvent) { d.stop() })

	mygo.App.WhenReady(func() {
		// macOS has an app menu; on Windows and Linux it would be a menu bar in the window.
		if isMac {
			setAppMenu(tray)
		}

		options := mygo.WindowOptions{
			Title:     "Mingle",
			Width:     1180,
			Height:    800,
			MinWidth:  720,
			MinHeight: 520,
			Hidden:    true,
			StateKey:  "main",
			// Trusted, so the page gets the title bar's insets and can move the window.
			Page: mygo.PageOptions{TrustedOrigins: []string{origin}},
		}
		if isMac {
			// The console draws its own title bar: the traffic lights sit in the sidebar's
			// brand row, centred in its 52 points, and the sidebar shows the window's material.
			// Windows and Linux keep their own title bar and its buttons.
			options.TitleBarStyle = mygo.TitleBarHidden
			options.TrafficLightPosition = &mygo.Point{X: 18, Y: 19}
			options.Transparent = true
			options.Vibrancy = mygo.VibrancySidebar
		}
		win = mygo.NewWindow(options)
		page := newPageState(win.Page(), origin)
		page.waiting(t.starting, "")
		// Closing the window keeps Mingle running in the menu bar.
		win.OnClose(func(e *mygo.CloseEvent) {
			if quitting {
				return
			}
			e.PreventDefault()
			win.Hide()
			mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)
			tray.closeHint()
		})
		if !mygo.App.WasOpenedAtLogin() {
			show()
		}

		tray.start()
		updater.OnChange(tray.refresh)

		// Each time Mingle (re)starts, point the window at its console.
		d.onReady = func(url, token string) {
			tray.ready(url, token)
			page.console(url, token)
		}
		d.onDown = func(reason string) {
			tray.down()
			// The reason is in the log; the window says what happens next.
			page.waiting(t.restarting, t.restartHint)
		}
		go d.run()
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

func setAppMenu(tray *trayController) {
	mygo.App.SetMenu(mygo.NewMenu([]*mygo.MenuItem{
		{Label: "Mingle", Submenu: []*mygo.MenuItem{
			{Role: mygo.RoleAbout},
			updater.MenuItem(),
			mygo.Separator(),
			{Label: tray.t.settings, Accelerator: "Cmd+,", Click: tray.pageClick("/settings")},
			mygo.Separator(),
			{Role: mygo.RoleServices},
			mygo.Separator(),
			{Role: mygo.RoleHide},
			{Role: mygo.RoleHideOthers},
			{Role: mygo.RoleUnhide},
			mygo.Separator(),
			// Asks first while agents are online, as the menu bar's Quit does.
			{Label: tray.t.quit, Accelerator: "CmdOrCtrl+Q", Click: func(*mygo.MenuItem, *mygo.Window) { go tray.quit() }},
		}},
		// The console leaves these keys to the menu in the Mac app (web/src/shortcuts.ts).
		{Role: mygo.RoleFileMenu, Submenu: []*mygo.MenuItem{
			{Label: tray.t.newAgent, Accelerator: "Cmd+N", Click: tray.pageClick("/new")},
			mygo.Separator(),
			// Hides the window: Mingle keeps running in the menu bar.
			{Role: mygo.RoleClose},
		}},
		{Role: mygo.RoleEditMenu},
		{Role: mygo.RoleViewMenu, Submenu: []*mygo.MenuItem{
			{Role: mygo.RoleReload},
			mygo.Separator(),
			{Role: mygo.RoleResetZoom},
			{Role: mygo.RoleZoomIn},
			{Role: mygo.RoleZoomOut},
			mygo.Separator(),
			{Role: mygo.RoleToggleFullScreen},
		}},
		{Role: mygo.RoleWindowMenu},
	}))
}
