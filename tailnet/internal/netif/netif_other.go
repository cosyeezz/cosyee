//go:build !android

package netif

// Register is a no-op on non-Android platforms where Go's net.Interfaces works natively.
func Register() {}
