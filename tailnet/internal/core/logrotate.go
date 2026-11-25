package core

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const defaultMaxLogBytes = 2 * 1024 * 1024 // 2 MiB

// RotatingWriter is a thread-safe file writer that rotates to <path>.1 once maxBytes is reached.
type RotatingWriter struct {
	mu       sync.Mutex
	path     string
	maxBytes int64
	file     *os.File
	size     int64
}

// NewRotatingWriter opens (or creates) the log file at path and rotates when exceeding maxBytes.
// If path is empty, writes are discarded.
func NewRotatingWriter(path string, maxBytes int64) (*RotatingWriter, error) {
	if maxBytes <= 0 {
		maxBytes = defaultMaxLogBytes
	}
	w := &RotatingWriter{
		path:     path,
		maxBytes: maxBytes,
	}
	if path == "" {
		return w, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create log dir: %w", err)
	}
	if err := w.openLocked(); err != nil {
		return nil, err
	}
	return w, nil
}

func (w *RotatingWriter) openLocked() error {
	f, err := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return err
	}
	w.file = f
	w.size = info.Size()
	return nil
}

func (w *RotatingWriter) rotateLocked() error {
	if w.file != nil {
		_ = w.file.Close()
		w.file = nil
	}
	backup := w.path + ".1"
	_ = os.Remove(backup)
	if err := os.Rename(w.path, backup); err != nil && !os.IsNotExist(err) {
		// Fall back to truncating if rename fails (e.g. locked on Windows).
		f, openErr := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if openErr != nil {
			return openErr
		}
		w.file = f
		w.size = 0
		return nil
	}
	return w.openLocked()
}

func (w *RotatingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.path == "" {
		return len(p), nil
	}
	if w.file == nil {
		if err := w.openLocked(); err != nil {
			return 0, err
		}
	}
	if w.size+int64(len(p)) > w.maxBytes && w.size > 0 {
		if err := w.rotateLocked(); err != nil {
			return 0, err
		}
	}
	n, err := w.file.Write(p)
	w.size += int64(n)
	return n, err
}

func (w *RotatingWriter) Logf(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	ts := time.Now().UTC().Format(time.RFC3339)
	if len(msg) == 0 || msg[len(msg)-1] != '\n' {
		_, _ = io.WriteString(w, ts+" "+msg+"\n")
	} else {
		_, _ = io.WriteString(w, ts+" "+msg)
	}
}

func (w *RotatingWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}
