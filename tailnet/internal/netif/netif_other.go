//go:build !android

package netif

import "errors"

// Register is a no-op on non-Android platforms where Go's net.Interfaces works natively.
func Register() {}

// HasChangePoller returns false on desktop platforms where OS-native link monitors are used.
func HasChangePoller() bool {
	return false
}

// PollSnapshot is unused on non-Android platforms.
func PollSnapshot() (Snapshot, error) {
	return Snapshot{}, errors.New("netif polling disabled on non-android platforms")
}
