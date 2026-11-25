package core

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPrepareTailscaleDirsAndroid(t *testing.T) {
	state := t.TempDir()
	t.Setenv("TS_LOGS_DIR", "")
	t.Setenv("TMPDIR", filepath.Join(state, "does-not-exist"))

	prepareTailscaleDirs(state, "android")

	if got, want := os.Getenv("TS_LOGS_DIR"), filepath.Join(state, "logs"); got != want {
		t.Fatalf("TS_LOGS_DIR = %q, want %q", got, want)
	}
	if got, want := os.Getenv("TMPDIR"), filepath.Join(state, "tmp"); got != want {
		t.Fatalf("TMPDIR = %q, want %q", got, want)
	}
	for _, d := range []string{"logs", "tmp"} {
		if fi, err := os.Stat(filepath.Join(state, d)); err != nil || !fi.IsDir() {
			t.Fatalf("%s dir not created: %v", d, err)
		}
	}
}

func TestPrepareTailscaleDirsKeepsUsableValues(t *testing.T) {
	state := t.TempDir()
	logs := t.TempDir()
	tmp := t.TempDir()
	t.Setenv("TS_LOGS_DIR", logs)
	t.Setenv("TMPDIR", tmp)

	prepareTailscaleDirs(state, "android")

	if got := os.Getenv("TS_LOGS_DIR"); got != logs {
		t.Fatalf("TS_LOGS_DIR overwritten: %q", got)
	}
	if got := os.Getenv("TMPDIR"); got != tmp {
		t.Fatalf("TMPDIR overwritten: %q", got)
	}
}

func TestPrepareTailscaleDirsDesktopLeavesTMPDIR(t *testing.T) {
	state := t.TempDir()
	t.Setenv("TS_LOGS_DIR", "")
	t.Setenv("TMPDIR", "")

	prepareTailscaleDirs(state, "windows")

	if got, want := os.Getenv("TS_LOGS_DIR"), filepath.Join(state, "logs"); got != want {
		t.Fatalf("TS_LOGS_DIR = %q, want %q", got, want)
	}
	if got := os.Getenv("TMPDIR"); got != "" {
		t.Fatalf("TMPDIR should be untouched on desktop, got %q", got)
	}
}
