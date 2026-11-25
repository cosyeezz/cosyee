//go:build android && cgo

package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"fmt"
	"unsafe"

	"github.com/cosyeezz/cosyee/tailnet/internal/core"
	"github.com/cosyeezz/cosyee/tailnet/internal/version"
)

//export CosyeeTailnetStart
func CosyeeTailnetStart(stateDir *C.char, hostname *C.char, logFile *C.char) (ret *C.char) {
	defer func() {
		if r := recover(); r != nil {
			ret = C.CString(core.FormatErrorJSON(fmt.Errorf("panic in CosyeeTailnetStart: %v", r)))
		}
	}()

	cfg := core.Config{
		StateDir: goString(stateDir),
		Hostname: goString(hostname),
		LogFile:  goString(logFile),
	}

	return C.CString(startTailnet(cfg))
}

//export CosyeeTailnetStop
func CosyeeTailnetStop() {
	defer func() {
		_ = recover()
	}()

	stopTailnet()
}

//export CosyeeTailnetVersion
func CosyeeTailnetVersion() (ret *C.char) {
	defer func() {
		if r := recover(); r != nil {
			ret = nil
		}
	}()

	return C.CString(version.Version)
}

//export CosyeeTailnetFree
func CosyeeTailnetFree(p *C.char) {
	defer func() {
		_ = recover()
	}()

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
