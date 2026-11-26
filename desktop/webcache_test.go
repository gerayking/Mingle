package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestClearWebCachesKeepsStorage(t *testing.T) {
	dir := t.TempDir()
	kept := []string{"EBWebView/Default/Local Storage/leveldb/CURRENT", "EBWebView/Default/Cookies", "EBWebView/Local State"}
	for _, f := range append(append([]string{}, kept...), "EBWebView/GrShaderCache/data_0", "EBWebView/Default/Cache/Cache_Data/index", "EBWebView/Default/Code Cache/js/index") {
		path := filepath.Join(dir, filepath.FromSlash(f))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := clearWebCaches(dir); err != nil {
		t.Fatal(err)
	}
	for _, cache := range webCaches {
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(cache))); !os.IsNotExist(err) {
			t.Errorf("%s is still there", cache)
		}
	}
	for _, f := range kept {
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(f))); err != nil {
			t.Errorf("%s was removed: %v", f, err)
		}
	}
}
