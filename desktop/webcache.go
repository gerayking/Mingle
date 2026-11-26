package main

import (
	"log"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"
)

// webCaches are the folders of a WebView2 user data folder that only hold
// caches: compiled shaders, compiled scripts and HTTP responses. The browser
// rebuilds them as it needs them. Local storage, cookies and preferences sit
// beside them and are kept.
var webCaches = []string{
	"EBWebView/GrShaderCache",
	"EBWebView/ShaderCache",
	"EBWebView/GraphiteDawnCache",
	"EBWebView/Default/Cache",
	"EBWebView/Default/Code Cache",
	"EBWebView/Default/GPUCache",
	"EBWebView/Default/DawnGraphiteCache",
	"EBWebView/Default/DawnWebGPUCache",
}

// clearWebCachesAfterUpdate empties the window's web caches on the first run
// of a new version of the app. Caches left by an earlier version, or by the
// WebView2 runtime before it updated itself, can leave the window blank
// though the console answers (#159). Windows only: the app names WebView2's
// folder itself there. It runs before the window is made, so the browser
// holds none of these files yet.
func clearWebCachesAfterUpdate() {
	if !isWindows || os.Getenv("WEBVIEW2_USER_DATA_FOLDER") != "" {
		return
	}
	version := mygo.App.Version()
	if version == "" || loadPrefs().WebCachesVersion == version {
		return
	}
	dir := os.Getenv("LOCALAPPDATA")
	if dir == "" {
		dir = os.TempDir()
	}
	if err := clearWebCaches(filepath.Join(dir, "Mingle", "WebView2")); err != nil {
		// Tried again on the next run.
		log.Println("window: clearing web caches:", err)
		return
	}
	updatePrefs(func(p *prefs) { p.WebCachesVersion = version })
}

// clearWebCaches removes webCaches from the WebView2 user data folder dir.
func clearWebCaches(dir string) error {
	var first error
	for _, cache := range webCaches {
		if err := os.RemoveAll(filepath.Join(dir, filepath.FromSlash(cache))); err != nil && first == nil {
			first = err
		}
	}
	return first
}
