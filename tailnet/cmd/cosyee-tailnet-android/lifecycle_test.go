package main

import (
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/cosyeezz/cosyee/tailnet/internal/core"
)

type fakeInstance struct {
	stopCalls  atomic.Int32
	panicOnEnd bool
}

func (f *fakeInstance) Stop() error {
	f.stopCalls.Add(1)
	if f.panicOnEnd {
		panic("stop boom")
	}
	return nil
}

func resetLifecycleGlobals(t *testing.T) {
	t.Helper()
	origStart := startImpl
	t.Cleanup(func() {
		mu.Lock()
		instance = nil
		startImpl = origStart
		mu.Unlock()
	})
	mu.Lock()
	instance = nil
	mu.Unlock()
}

func TestStartTailnetRecoversPanicAndKeepsConsistentState(t *testing.T) {
	resetLifecycleGlobals(t)

	prev := &fakeInstance{}
	mu.Lock()
	instance = prev
	startImpl = func(cfg core.Config) (tailnetInstance, core.ReadyMessage, error) {
		panic("start boom")
	}
	mu.Unlock()

	raw := startTailnet(core.Config{Hostname: "android-test"})

	var parsed core.ErrorMessage
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		t.Fatalf("expected valid error JSON, got %q: %v", raw, err)
	}
	if parsed.Type != "error" || !strings.Contains(parsed.Error, "start boom") {
		t.Fatalf("unexpected error JSON: %+v", parsed)
	}
	if prev.stopCalls.Load() != 1 {
		t.Fatalf("expected previous instance to be stopped once, got %d", prev.stopCalls.Load())
	}

	mu.Lock()
	gotInst := instance
	mu.Unlock()
	if gotInst != nil {
		t.Fatalf("expected global instance to be nil after start panic, got %#v", gotInst)
	}
}

func TestStartTailnetRecoversOldStopPanic(t *testing.T) {
	resetLifecycleGlobals(t)

	prev := &fakeInstance{panicOnEnd: true}
	mu.Lock()
	instance = prev
	startImpl = func(cfg core.Config) (tailnetInstance, core.ReadyMessage, error) {
		return &fakeInstance{}, core.ReadyMessage{Type: "ready"}, nil
	}
	mu.Unlock()

	raw := startTailnet(core.Config{Hostname: "android-test"})

	var parsed core.ErrorMessage
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		t.Fatalf("expected valid error JSON, got %q: %v", raw, err)
	}
	if parsed.Type != "error" || !strings.Contains(parsed.Error, "stop boom") {
		t.Fatalf("unexpected error JSON: %+v", parsed)
	}

	mu.Lock()
	gotInst := instance
	mu.Unlock()
	if gotInst != nil {
		t.Fatalf("expected global instance to be nil after old.Stop panic, got %#v", gotInst)
	}
}

func TestStopTailnetRecoversPanicAndClearsInstance(t *testing.T) {
	resetLifecycleGlobals(t)

	cur := &fakeInstance{panicOnEnd: true}
	mu.Lock()
	instance = cur
	mu.Unlock()

	// Must not panic.
	stopTailnet()

	if cur.stopCalls.Load() != 1 {
		t.Fatalf("expected Stop to be called once, got %d", cur.stopCalls.Load())
	}

	mu.Lock()
	gotInst := instance
	mu.Unlock()
	if gotInst != nil {
		t.Fatalf("expected global instance to be nil after stop panic, got %#v", gotInst)
	}
}
