package netif

import (
	"context"
	"errors"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"tailscale.com/net/netmon"
)

func makeTestIface(name string, flags net.Flags, cidrs ...string) netmon.Interface {
	addrs := make([]net.Addr, 0, len(cidrs))
	for _, c := range cidrs {
		ip, ipNet, err := net.ParseCIDR(c)
		if err != nil {
			panic(err)
		}
		ipNet.IP = ip
		addrs = append(addrs, ipNet)
	}
	return netmon.Interface{
		Interface: &net.Interface{
			Name:  name,
			Flags: flags,
		},
		AltAddrs: addrs,
	}
}

func TestSnapshotsEqualIgnoresOrderAndLoopback(t *testing.T) {
	up := net.FlagUp | net.FlagRunning

	a := []netmon.Interface{
		makeTestIface("lo", up|net.FlagLoopback, "127.0.0.1/8", "::1/128"),
		makeTestIface("wlan0", up, "192.168.1.10/24", "fd00::10/64"),
		makeTestIface("rmnet_data0", up, "10.0.0.2/32"),
		makeTestIface("dummy0", up), // no IPs
	}
	b := []netmon.Interface{
		makeTestIface("rmnet_data0", up, "10.0.0.2/32"),
		makeTestIface("wlan0", up, "fd00::10/64", "192.168.1.10/24", "127.0.0.1/8"),
		makeTestIface("lo", up|net.FlagLoopback, "127.0.0.2/8"),
		makeTestIface("p2p0", net.FlagBroadcast, "192.168.49.1/24"), // down interface ignored
	}

	if !SnapshotsEqual(a, b) {
		t.Fatalf("expected snapshots to be equal when only order/loopback/down/empty differ")
	}
}

func TestSnapshotsEqualDetectsChanges(t *testing.T) {
	up := net.FlagUp | net.FlagRunning

	wifi := []netmon.Interface{
		makeTestIface("wlan0", up, "192.168.1.10/24"),
	}
	cellular := []netmon.Interface{
		makeTestIface("rmnet_data0", up, "10.12.34.56/32"),
	}
	wifiNewIP := []netmon.Interface{
		makeTestIface("wlan0", up, "192.168.1.11/24"),
	}
	wifiNewMask := []netmon.Interface{
		makeTestIface("wlan0", up, "192.168.1.10/16"),
	}
	wifiDown := []netmon.Interface{
		makeTestIface("wlan0", net.FlagRunning, "192.168.1.10/24"),
	}

	if SnapshotsEqual(wifi, cellular) {
		t.Fatalf("expected Wi-Fi -> cellular switch to differ")
	}
	if SnapshotsEqual(wifi, wifiNewIP) {
		t.Fatalf("expected IP change to differ")
	}
	if SnapshotsEqual(wifi, wifiNewMask) {
		t.Fatalf("expected subnet mask change to differ")
	}
	if SnapshotsEqual(wifi, wifiDown) {
		t.Fatalf("expected interface up -> down transition to differ")
	}
}

func TestPollChangesTriggersOnDeltaAndExitsOnCancel(t *testing.T) {
	up := net.FlagUp | net.FlagRunning
	snap1 := BuildSnapshot([]netmon.Interface{makeTestIface("wlan0", up, "192.168.1.10/24")})
	snap2 := BuildSnapshot([]netmon.Interface{makeTestIface("rmnet_data0", up, "10.0.0.2/32")})

	var step atomic.Int32
	var changes atomic.Int32
	changedCh := make(chan struct{}, 4)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})

	go func() {
		defer close(done)
		PollChanges(ctx, 15*time.Millisecond, func() (Snapshot, error) {
			switch step.Add(1) {
			case 1, 2:
				return snap1, nil
			case 3:
				return Snapshot{}, errors.New("transient error")
			case 4:
				panic("sampler panic")
			default:
				return snap2, nil
			}
		}, func() {
			changes.Add(1)
			select {
			case changedCh <- struct{}{}:
			default:
			}
		}, nil)
	}()

	select {
	case <-changedCh:
	case <-time.After(2 * time.Second):
		cancel()
		t.Fatalf("timed out waiting for network change callback")
	}

	// Wait a couple ticks to ensure identical snap2 does not re-trigger.
	time.Sleep(60 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatalf("PollChanges did not exit after context cancel")
	}

	if got := changes.Load(); got != 1 {
		t.Fatalf("expected exactly 1 change event, got %d", got)
	}
}
