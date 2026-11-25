package core

import (
	"context"
	"fmt"
	"net"
	"os"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
)

// IPNWatcher abstracts *local.IPNBusWatcher for unit testing.
type IPNWatcher interface {
	Next() (ipn.Notify, error)
	Close() error
}

// Backend abstracts tsnet.Server + local.Client for unit testing.
type Backend interface {
	Start() error
	Close() error
	Dial(ctx context.Context, network, address string) (net.Conn, error)
	Status(ctx context.Context) (*ipnstate.Status, error)
	StartLoginInteractive(ctx context.Context) error
	Logout(ctx context.Context) error
	WatchIPNBus(ctx context.Context, mask ipn.NotifyWatchOpt) (IPNWatcher, error)
}

type tsnetBackend struct {
	srv *tsnet.Server
	lc  *local.Client
}

func newTSNetBackend(stateDir, hostname string, logf func(string, ...any)) Backend {
	// Disable uploading logs to Tailscale logtail servers.
	_ = os.Setenv("TS_NO_LOGS_NO_SUPPORT", "true")

	srv := &tsnet.Server{
		Dir:      stateDir,
		Hostname: hostname,
		Logf:     logf,
		UserLogf: logf,
	}
	return &tsnetBackend{srv: srv}
}

func (b *tsnetBackend) Start() error {
	if err := b.srv.Start(); err != nil {
		return err
	}
	lc, err := b.srv.LocalClient()
	if err != nil {
		_ = b.srv.Close()
		return fmt.Errorf("local client: %w", err)
	}
	b.lc = lc
	return nil
}

func (b *tsnetBackend) Close() error {
	return b.srv.Close()
}

func (b *tsnetBackend) Dial(ctx context.Context, network, address string) (net.Conn, error) {
	return b.srv.Dial(ctx, network, address)
}

func (b *tsnetBackend) Status(ctx context.Context) (*ipnstate.Status, error) {
	if b.lc == nil {
		return nil, fmt.Errorf("backend not started")
	}
	return b.lc.StatusWithoutPeers(ctx)
}

func (b *tsnetBackend) StartLoginInteractive(ctx context.Context) error {
	if b.lc == nil {
		return fmt.Errorf("backend not started")
	}
	return b.lc.StartLoginInteractive(ctx)
}

func (b *tsnetBackend) Logout(ctx context.Context) error {
	if b.lc == nil {
		return fmt.Errorf("backend not started")
	}
	return b.lc.Logout(ctx)
}

func (b *tsnetBackend) WatchIPNBus(ctx context.Context, mask ipn.NotifyWatchOpt) (IPNWatcher, error) {
	if b.lc == nil {
		return nil, fmt.Errorf("backend not started")
	}
	return b.lc.WatchIPNBus(ctx, mask)
}

// InjectNetworkEvent triggers tsnet's underlying netmon.Monitor to re-evaluate network state.
func (b *tsnetBackend) InjectNetworkEvent() {
	if b.srv == nil {
		return
	}
	sys := b.srv.Sys()
	if sys == nil {
		return
	}
	if mon, ok := sys.NetMon.GetOK(); ok && mon != nil {
		mon.InjectEvent()
	}
}
