package netif

import (
	"context"
	"net"
	"net/netip"
	"slices"
	"sort"
	"strings"
	"time"

	"tailscale.com/net/netmon"
)

// Snapshot is a normalized, order-independent representation of active non-loopback
// network interfaces and their addresses.
type Snapshot struct {
	entries []string
}

// BuildSnapshot constructs a normalized Snapshot from a slice of netmon.Interface.
// It is a pure function: it only reads iface.AltAddrs (never invokes net.Interface.Addrs),
// ignores down interfaces, loopback interfaces/addresses, unspecified/multicast addresses,
// and normalizes ordering and duplicates.
func BuildSnapshot(ifaces []netmon.Interface) Snapshot {
	byName := make(map[string]map[string]struct{})

	for _, iface := range ifaces {
		if iface.Interface == nil {
			continue
		}
		if iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		if iface.Flags&net.FlagUp == 0 {
			continue
		}

		for _, addr := range iface.AltAddrs {
			formatted, ok := normalizeAddr(addr)
			if !ok {
				continue
			}
			set := byName[iface.Name]
			if set == nil {
				set = make(map[string]struct{})
				byName[iface.Name] = set
			}
			set[formatted] = struct{}{}
		}
	}

	if len(byName) == 0 {
		return Snapshot{}
	}

	names := make([]string, 0, len(byName))
	for name := range byName {
		names = append(names, name)
	}
	sort.Strings(names)

	entries := make([]string, 0, len(names))
	for _, name := range names {
		addrSet := byName[name]
		addrs := make([]string, 0, len(addrSet))
		for a := range addrSet {
			addrs = append(addrs, a)
		}
		sort.Strings(addrs)
		entries = append(entries, name+"="+strings.Join(addrs, ","))
	}

	return Snapshot{entries: entries}
}

// Equal reports whether two snapshots contain the exact same normalized interface/address set.
func (s Snapshot) Equal(other Snapshot) bool {
	return slices.Equal(s.entries, other.entries)
}

// SnapshotsEqual compares two interface slices after normalization, ignoring loopback and order.
func SnapshotsEqual(a, b []netmon.Interface) bool {
	return BuildSnapshot(a).Equal(BuildSnapshot(b))
}

func normalizeAddr(addr net.Addr) (string, bool) {
	switch v := addr.(type) {
	case *net.IPNet:
		if v == nil {
			return "", false
		}
		ip, ok := netip.AddrFromSlice(v.IP)
		if !ok {
			return "", false
		}
		ip = ip.Unmap()
		if !isRelevantAddr(ip) {
			return "", false
		}
		ones, bits := v.Mask.Size()
		if bits > 0 {
			// Adjust IPv4-in-IPv6 128-bit masks when ip was unmapped to IPv4.
			if ip.Is4() && bits == 128 && ones >= 96 {
				ones -= 96
				bits = 32
			}
			if (ip.Is4() && bits == 32) || (ip.Is6() && bits == 128) {
				return netip.PrefixFrom(ip, ones).String(), true
			}
		}
		return ip.String(), true

	case *net.IPAddr:
		if v == nil {
			return "", false
		}
		ip, ok := netip.AddrFromSlice(v.IP)
		if !ok {
			return "", false
		}
		ip = ip.Unmap()
		if !isRelevantAddr(ip) {
			return "", false
		}
		return ip.String(), true

	default:
		return "", false
	}
}

func isRelevantAddr(ip netip.Addr) bool {
	if !ip.IsValid() || ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() {
		return false
	}
	return true
}

// PollChanges periodically samples network snapshots until ctx is canceled.
// When the normalized snapshot changes, onChange is invoked.
// Panics inside sample or onChange are recovered and logged without terminating the loop.
func PollChanges(
	ctx context.Context,
	interval time.Duration,
	sample func() (Snapshot, error),
	onChange func(),
	logf func(string, ...any),
) {
	if interval <= 0 || sample == nil || onChange == nil {
		return
	}

	safeLog := func(format string, args ...any) {
		if logf != nil {
			logf(format, args...)
		}
	}

	safeSample := func() (snap Snapshot, err error, panicked bool) {
		defer func() {
			if r := recover(); r != nil {
				panicked = true
				safeLog("panic in network snapshot sampler: %v", r)
			}
		}()
		snap, err = sample()
		return snap, err, false
	}

	safeOnChange := func() {
		defer func() {
			if r := recover(); r != nil {
				safeLog("panic in network change callback: %v", r)
			}
		}()
		onChange()
	}

	var (
		prev    Snapshot
		hasPrev bool
	)
	if initial, err, panicked := safeSample(); err == nil && !panicked {
		prev = initial
		hasPrev = true
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cur, err, panicked := safeSample()
			if err != nil || panicked {
				continue
			}
			if !hasPrev {
				prev = cur
				hasPrev = true
				safeOnChange()
				continue
			}
			if !prev.Equal(cur) {
				prev = cur
				safeOnChange()
			}
		}
	}
}
