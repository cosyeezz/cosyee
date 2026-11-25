//go:build android && !cgo

package netif

import (
	"tailscale.com/net/netmon"

	// Provides netmon fallback + androiddns when compiled with GOOS=android CGO_ENABLED=0.
	_ "tailscale.com/feature/androidbin"
)

// Register is a no-op in non-cgo Android builds; feature/androidbin hooks netmon automatically.
func Register() {}

// HasChangePoller reports whether this platform needs periodic interface polling.
func HasChangePoller() bool {
	return true
}

// PollSnapshot returns a normalized snapshot using netmon's registered interface getter/fallback.
func PollSnapshot() (Snapshot, error) {
	ifaces, err := netmon.GetInterfaceList()
	if err != nil {
		return Snapshot{}, err
	}
	return BuildSnapshot(ifaces), nil
}
