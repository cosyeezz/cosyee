package core

import (
	"os"
	"path/filepath"
	"runtime"
)

// prepareTailscaleDirs points tailscale's own log-state and temp directories into
// stateDir before tsnet starts.
//
// tsnet's LocalBackend calls logpolicy.LogsDir for its sockstat logger. That walks
// $TS_LOGS_DIR, /var/lib/tailscale, os.UserCacheDir, the working directory and
// os.MkdirTemp("") in turn, and panics when none work. An Android app process has
// no $HOME, a working directory of "/", and os.TempDir() falls back to
// /data/local/tmp, which apps cannot write — so it always panics there
// ("no safe place found to store log state"). os.TempDir is also where tailscale
// puts its socket path on Android.
//
// Desktop sidecars get the same TS_LOGS_DIR so they keep that state next to their
// own instead of writing into the system Tailscale's directory. Values the user
// has already set are left alone.
func prepareTailscaleDirs(stateDir, goos string) {
	if stateDir == "" {
		return
	}
	if !isWritableDir(os.Getenv("TS_LOGS_DIR")) {
		logsDir := filepath.Join(stateDir, "logs")
		if err := os.MkdirAll(logsDir, 0o700); err == nil {
			_ = os.Setenv("TS_LOGS_DIR", logsDir)
		}
	}
	if goos == "android" && !isWritableDir(os.Getenv("TMPDIR")) {
		tmpDir := filepath.Join(stateDir, "tmp")
		if err := os.MkdirAll(tmpDir, 0o700); err == nil {
			_ = os.Setenv("TMPDIR", tmpDir)
		}
	}
}

// isWritableDir reports whether dir is an existing directory we can create files in.
func isWritableDir(dir string) bool {
	if dir == "" {
		return false
	}
	fi, err := os.Stat(dir)
	if err != nil || !fi.IsDir() {
		return false
	}
	f, err := os.CreateTemp(dir, ".probe-*")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}

var currentGOOS = runtime.GOOS
