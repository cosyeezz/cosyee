//go:build android && cgo

package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"sync"
	"unsafe"

	"github.com/cosyeezz/cosyee/tailnet/internal/core"
	"github.com/cosyeezz/cosyee/tailnet/internal/version"
)

var (
	mu       sync.Mutex
	instance *core.Instance
)

//export CosyeeTailnetStart
func CosyeeTailnetStart(stateDir *C.char, hostname *C.char, logFile *C.char) *C.char {
	mu.Lock()
	defer mu.Unlock()

	if instance != nil {
		_ = instance.Stop()
		instance = nil
	}

	cfg := core.Config{
		StateDir: goString(stateDir),
		Hostname: goString(hostname),
		LogFile:  goString(logFile),
	}

	inst, ready, err := core.Start(cfg)
	if err != nil {
		return C.CString(core.FormatErrorJSON(err))
	}
	instance = inst
	return C.CString(ready.JSON())
}

//export CosyeeTailnetStop
func CosyeeTailnetStop() {
	mu.Lock()
	defer mu.Unlock()

	if instance != nil {
		_ = instance.Stop()
		instance = nil
	}
}

//export CosyeeTailnetVersion
func CosyeeTailnetVersion() *C.char {
	return C.CString(version.Version)
}

//export CosyeeTailnetFree
func CosyeeTailnetFree(p *C.char) {
	if p != nil {
		C.free(unsafe.Pointer(p))
	}
}

func goString(p *C.char) string {
	if p == nil {
		return ""
	}
	return C.GoString(p)
}

func main() {}
