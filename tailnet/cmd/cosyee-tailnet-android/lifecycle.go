package main

import (
	"fmt"
	"sync"

	"github.com/cosyeezz/cosyee/tailnet/internal/core"
)

type tailnetInstance interface {
	Stop() error
}

var (
	mu        sync.Mutex
	instance  tailnetInstance
	startImpl = func(cfg core.Config) (tailnetInstance, core.ReadyMessage, error) {
		return core.Start(cfg)
	}
)

// startTailnet starts (or restarts) the singleton instance while recovering from any panic.
// On panic or error, any partially started instance is stopped and global instance remains nil.
func startTailnet(cfg core.Config) (resultJSON string) {
	mu.Lock()
	defer mu.Unlock()

	var pending tailnetInstance
	defer func() {
		if r := recover(); r != nil {
			if pending != nil {
				func() {
					defer func() { _ = recover() }()
					_ = pending.Stop()
				}()
			}
			instance = nil
			resultJSON = core.FormatErrorJSON(fmt.Errorf("panic in CosyeeTailnetStart: %v", r))
		}
	}()

	if old := instance; old != nil {
		instance = nil
		_ = old.Stop()
	}

	inst, ready, err := startImpl(cfg)
	if err != nil {
		return core.FormatErrorJSON(err)
	}
	pending = inst

	readyJSON := ready.JSON()
	instance = inst
	pending = nil
	return readyJSON
}

// stopTailnet stops and clears the singleton instance while recovering from any panic.
func stopTailnet() {
	mu.Lock()
	defer mu.Unlock()

	defer func() {
		_ = recover()
	}()

	if old := instance; old != nil {
		instance = nil
		_ = old.Stop()
	}
}

func main() {}
