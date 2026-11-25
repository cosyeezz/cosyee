//go:build android && !cgo

package netif

import (
	// Provides netmon fallback + androiddns when compiled with GOOS=android CGO_ENABLED=0.
	_ "tailscale.com/feature/androidbin"
)

// Register is a no-op in non-cgo Android builds; feature/androidbin hooks netmon automatically.
func Register() {}
