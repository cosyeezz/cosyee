package core

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"runtime/debug"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/net/socks5"

	"github.com/cosyeezz/cosyee/tailnet/internal/netif"
	"github.com/cosyeezz/cosyee/tailnet/internal/version"
)

const (
	socksUsername              = "cosyee"
	loginTimeout               = 15 * time.Second
	loginStatusFallbackTimeout = 2 * time.Second
	androidNetPollInterval     = 5 * time.Second
)

// networkEventInjector is optionally implemented by backends that can notify netmon of link changes.
type networkEventInjector interface {
	InjectNetworkEvent()
}

// Config holds startup options for a cosyee-tailnet instance.
type Config struct {
	StateDir string
	Hostname string
	LogFile  string
	// Backend optionally injects a custom Backend (used by unit tests).
	Backend Backend
	// Version optionally overrides version.Version (used by unit tests).
	Version string
}

// ReadyMessage is emitted once on stdout (desktop) or returned by CosyeeTailnetStart (Android).
type ReadyMessage struct {
	Type    string `json:"type"`
	Version string `json:"version"`
	Control string `json:"control"`
	Socks   string `json:"socks"`
	Token   string `json:"token"`
}

// ErrorMessage is emitted on startup failure.
type ErrorMessage struct {
	Type  string `json:"type"`
	Error string `json:"error"`
}

// SelfInfo describes this node in GET /status.
type SelfInfo struct {
	Name    string   `json:"name"`
	DNSName string   `json:"dnsName"`
	IPs     []string `json:"ips"`
}

// StatusResponse is the JSON payload returned by GET /status.
type StatusResponse struct {
	Version string    `json:"version"`
	State   string    `json:"state"`
	AuthURL *string   `json:"authURL"`
	Self    *SelfInfo `json:"self"`
	Tailnet *string   `json:"tailnet"`
	Error   *string   `json:"error"`
}

// PeerInfo 描述 GET /peers 返回的单台 tailnet 设备（不含本机）。
type PeerInfo struct {
	Name      string   `json:"name"`
	DNSName   string   `json:"dnsName"`
	ShortName string   `json:"shortName"`
	IPs       []string `json:"ips"`
	OS        string   `json:"os"`
	Online    bool     `json:"online"`
	LastSeen  *string  `json:"lastSeen"`
}

// PeersResponse 是 GET /peers 返回的 JSON 结构。
type PeersResponse struct {
	State string     `json:"state"`
	Peers []PeerInfo `json:"peers"`
	Error *string    `json:"error,omitempty"`
}

// Instance runs the tsnet backend, control HTTP API, and authenticated SOCKS5 proxy.
type Instance struct {
	version     string
	token       string
	controlAddr string
	socksAddr   string

	backend   Backend
	logWriter *RotatingWriter
	controlLn net.Listener
	socksLn   net.Listener
	httpSrv   *http.Server

	fatalMu  sync.RWMutex
	fatalErr error

	stopping   atomic.Bool
	pollCancel context.CancelFunc

	stopOnce sync.Once
	wg       sync.WaitGroup
}

// FormatErrorJSON serializes a startup error in CONTRACT format.
func FormatErrorJSON(err error) string {
	msg := ErrorMessage{
		Type:  "error",
		Error: err.Error(),
	}
	b, _ := json.Marshal(msg)
	return string(b)
}

// FormatReadyJSON serializes a ReadyMessage as a single-line JSON string.
func (r ReadyMessage) JSON() string {
	b, _ := json.Marshal(r)
	return string(b)
}

// Start initializes logging, tsnet, the control HTTP server, and the SOCKS5 proxy.
func Start(cfg Config) (*Instance, ReadyMessage, error) {
	return startWithListen(cfg, net.Listen)
}

func startWithListen(cfg Config, listen func(network, address string) (net.Listener, error)) (*Instance, ReadyMessage, error) {
	// Always disable logtail upload before touching any tailscale package.
	_ = os.Setenv("TS_NO_LOGS_NO_SUPPORT", "true")
	// Register bionic getifaddrs on Android 11+ before netmon starts.
	netif.Register()

	ver := cfg.Version
	if ver == "" {
		ver = version.Version
	}

	var (
		started        bool
		logWriter      *RotatingWriter
		backend        Backend
		backendStarted bool
		controlLn      net.Listener
		socksLn        net.Listener
	)
	defer func() {
		if started {
			return
		}
		if socksLn != nil {
			_ = socksLn.Close()
		}
		if controlLn != nil {
			_ = controlLn.Close()
		}
		if backendStarted && backend != nil {
			_ = backend.Close()
		}
		if logWriter != nil {
			log.SetOutput(io.Discard)
			_ = logWriter.Close()
		}
	}()

	var err error
	logWriter, err = NewRotatingWriter(cfg.LogFile, defaultMaxLogBytes)
	if err != nil {
		return nil, ReadyMessage{}, fmt.Errorf("open log file: %w", err)
	}
	// Route Go's default logger to the rotating log file so stdout stays clean.
	log.SetOutput(logWriter)
	log.SetFlags(log.LstdFlags | log.LUTC)

	token, err := generateToken()
	if err != nil {
		return nil, ReadyMessage{}, fmt.Errorf("generate token: %w", err)
	}

	if cfg.StateDir != "" {
		if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
			return nil, ReadyMessage{}, fmt.Errorf("create state dir: %w", err)
		}
	}
	prepareTailscaleDirs(cfg.StateDir, currentGOOS)

	backend = cfg.Backend
	if backend == nil {
		backend = newTSNetBackend(cfg.StateDir, cfg.Hostname, logWriter.Logf)
	}

	if err := backend.Start(); err != nil {
		return nil, ReadyMessage{}, fmt.Errorf("start tsnet: %w", err)
	}
	backendStarted = true

	controlLn, err = listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, ReadyMessage{}, fmt.Errorf("listen control: %w", err)
	}

	socksLn, err = listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, ReadyMessage{}, fmt.Errorf("listen socks5: %w", err)
	}

	inst := &Instance{
		version:     ver,
		token:       token,
		controlAddr: controlLn.Addr().String(),
		socksAddr:   socksLn.Addr().String(),
		backend:     backend,
		logWriter:   logWriter,
		controlLn:   controlLn,
		socksLn:     socksLn,
	}

	inst.httpSrv = &http.Server{
		Handler:           inst.controlHandler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	socksSrv := &socks5.Server{
		Logf:     logWriter.Logf,
		Username: socksUsername,
		Password: token,
		Dialer: func(ctx context.Context, network, addr string) (conn net.Conn, err error) {
			defer func() {
				if r := recover(); r != nil {
					inst.logWriter.Logf("panic in socks5 dialer (%s %s): %v\n%s", network, addr, r, debug.Stack())
					conn = nil
					err = fmt.Errorf("socks5 dialer panic: %v", r)
				}
			}()
			if !strings.HasPrefix(network, "tcp") {
				return nil, fmt.Errorf("unsupported network %q: only TCP CONNECT is allowed", network)
			}
			return inst.backend.Dial(ctx, network, addr)
		},
	}

	// Ownership of listeners, backend, and logWriter now transfers to inst.Stop().
	started = true

	inst.wg.Add(2)
	go func() {
		defer inst.wg.Done()
		defer func() {
			if r := recover(); r != nil {
				err := fmt.Errorf("control server panic: %v", r)
				inst.setFatalError(err)
				inst.logWriter.Logf("%v\n%s", err, debug.Stack())
				_ = controlLn.Close()
				_ = socksLn.Close()
			}
		}()
		if err := inst.httpSrv.Serve(controlLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
			if !inst.stopping.Load() {
				inst.setFatalError(fmt.Errorf("control server stopped: %w", err))
			}
			inst.logWriter.Logf("control server stopped: %v", err)
		}
	}()
	go func() {
		defer inst.wg.Done()
		defer func() {
			if r := recover(); r != nil {
				err := fmt.Errorf("socks5 server panic: %v", r)
				inst.setFatalError(err)
				inst.logWriter.Logf("%v\n%s", err, debug.Stack())
				_ = socksLn.Close()
			}
		}()
		if err := socksSrv.Serve(socksLn); err != nil && !errors.Is(err, net.ErrClosed) {
			if !inst.stopping.Load() {
				inst.setFatalError(fmt.Errorf("socks5 server stopped: %w", err))
			}
			inst.logWriter.Logf("socks5 server stopped: %v", err)
		}
	}()

	// Android uses netmon's 10-minute pollingMon; run a lightweight 5s snapshot poller to speed up
	// Wi-Fi/cellular transitions while keeping desktop platforms untouched.
	if netif.HasChangePoller() {
		if injector, ok := backend.(networkEventInjector); ok {
			pollCtx, pollCancel := context.WithCancel(context.Background())
			inst.pollCancel = pollCancel
			inst.wg.Add(1)
			go func() {
				defer inst.wg.Done()
				defer func() {
					if r := recover(); r != nil {
						inst.logWriter.Logf("panic in android net poller: %v\n%s", r, debug.Stack())
					}
				}()
				netif.PollChanges(pollCtx, androidNetPollInterval, netif.PollSnapshot, func() {
					inst.logWriter.Logf("network interfaces changed, injecting netmon event")
					injector.InjectNetworkEvent()
				}, inst.logWriter.Logf)
			}()
		}
	}

	inst.logWriter.Logf("cosyee-tailnet %s ready: control=%s socks=%s hostname=%s", ver, inst.controlAddr, inst.socksAddr, cfg.Hostname)

	ready := ReadyMessage{
		Type:    "ready",
		Version: ver,
		Control: inst.controlAddr,
		Socks:   inst.socksAddr,
		Token:   token,
	}
	return inst, ready, nil
}

func (i *Instance) setFatalError(err error) {
	if err == nil || i.stopping.Load() {
		return
	}
	i.fatalMu.Lock()
	if i.fatalErr == nil {
		i.fatalErr = err
	}
	i.fatalMu.Unlock()
}

func (i *Instance) getFatalError() error {
	i.fatalMu.RLock()
	err := i.fatalErr
	i.fatalMu.RUnlock()
	return err
}

// Stop gracefully shuts down the HTTP server, SOCKS5 proxy, tsnet backend, and log file.
func (i *Instance) Stop() error {
	var firstErr error
	i.stopOnce.Do(func() {
		i.stopping.Store(true)
		if i.pollCancel != nil {
			i.pollCancel()
		}
		if i.logWriter != nil {
			i.logWriter.Logf("stopping cosyee-tailnet")
		}
		if i.httpSrv != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			if err := i.httpSrv.Shutdown(ctx); err != nil && firstErr == nil {
				firstErr = err
			}
			cancel()
		}
		if i.socksLn != nil {
			_ = i.socksLn.Close()
		}
		i.wg.Wait()
		if i.backend != nil {
			if err := i.backend.Close(); err != nil && firstErr == nil {
				firstErr = err
			}
		}
		// Detach Go's default logger before closing the rotating file so late writes do not hit it.
		log.SetOutput(io.Discard)
		if i.logWriter != nil {
			if err := i.logWriter.Close(); err != nil && firstErr == nil {
				firstErr = err
			}
		}
	})
	return firstErr
}

func (i *Instance) controlHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/status", i.handleStatus)
	mux.HandleFunc("/peers", i.handlePeers)
	mux.HandleFunc("/login", i.handleLogin)
	mux.HandleFunc("/logout", i.handleLogout)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Reject unexpected Host headers (DNS rebinding protection).
		if r.Host != i.controlAddr {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "invalid host"})
			return
		}
		// Require Authorization: Bearer <token>.
		if !i.authorize(r.Header.Get("Authorization")) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (i *Instance) authorize(header string) bool {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return false
	}
	got := header[len(prefix):]
	return subtle.ConstantTimeCompare([]byte(got), []byte(i.token)) == 1
}

func (i *Instance) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	if fatalErr := i.getFatalError(); fatalErr != nil {
		errStr := fatalErr.Error()
		writeJSON(w, http.StatusOK, StatusResponse{
			Version: i.version,
			State:   "Error",
			Error:   &errStr,
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	st, err := i.backend.Status(ctx)
	if err != nil {
		errStr := err.Error()
		writeJSON(w, http.StatusOK, StatusResponse{
			Version: i.version,
			State:   "Error",
			Error:   &errStr,
		})
		return
	}

	writeJSON(w, http.StatusOK, buildStatusResponse(i.version, st))
}

func buildStatusResponse(ver string, st *ipnstate.Status) StatusResponse {
	if st == nil {
		msg := "empty status from tailscale backend"
		return StatusResponse{
			Version: ver,
			State:   "Error",
			Error:   &msg,
		}
	}
	resp := StatusResponse{
		Version: ver,
		State:   mapBackendState(st.BackendState),
	}
	if st.BackendState == "InUseOtherUser" {
		msg := "tailscale state in use by another user"
		resp.Error = &msg
	}
	if st.AuthURL != "" {
		u := st.AuthURL
		resp.AuthURL = &u
	}

	ips := make([]string, 0, len(st.TailscaleIPs))
	for _, ip := range st.TailscaleIPs {
		ips = append(ips, ip.String())
	}
	if len(ips) == 0 && st.Self != nil {
		for _, ip := range st.Self.TailscaleIPs {
			ips = append(ips, ip.String())
		}
	}

	if st.Self != nil {
		dnsName := strings.TrimSuffix(st.Self.DNSName, ".")
		if st.Self.HostName != "" || dnsName != "" || len(ips) > 0 {
			resp.Self = &SelfInfo{
				Name:    st.Self.HostName,
				DNSName: dnsName,
				IPs:     ips,
			}
		}
	}

	var tailnetName string
	if st.CurrentTailnet != nil {
		if st.CurrentTailnet.MagicDNSSuffix != "" {
			tailnetName = st.CurrentTailnet.MagicDNSSuffix
		} else if st.CurrentTailnet.Name != "" {
			tailnetName = st.CurrentTailnet.Name
		}
	}
	if tailnetName == "" && st.MagicDNSSuffix != "" {
		tailnetName = st.MagicDNSSuffix
	}
	if tailnetName != "" {
		resp.Tailnet = &tailnetName
	}

	return resp
}

func mapBackendState(raw string) string {
	switch raw {
	case "Starting", "NeedsLogin", "NeedsMachineAuth", "Running", "Stopped":
		return raw
	case "", "NoState":
		return "Starting"
	default:
		return "Error"
	}
}

func (i *Instance) handlePeers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	if fatalErr := i.getFatalError(); fatalErr != nil {
		errStr := fatalErr.Error()
		writeJSON(w, http.StatusOK, PeersResponse{
			State: "Error",
			Peers: []PeerInfo{},
			Error: &errStr,
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	st, err := i.backend.StatusWithPeers(ctx)
	if err != nil {
		errStr := err.Error()
		writeJSON(w, http.StatusOK, PeersResponse{
			State: "Error",
			Peers: []PeerInfo{},
			Error: &errStr,
		})
		return
	}

	writeJSON(w, http.StatusOK, buildPeersResponse(st))
}

func buildPeersResponse(st *ipnstate.Status) PeersResponse {
	if st == nil {
		msg := "empty status from tailscale backend"
		return PeersResponse{
			State: "Error",
			Peers: []PeerInfo{},
			Error: &msg,
		}
	}

	state := mapBackendState(st.BackendState)
	if state != "Running" {
		return PeersResponse{
			State: state,
			Peers: []PeerInfo{},
		}
	}

	peers := make([]PeerInfo, 0, len(st.Peer))
	for _, p := range st.Peer {
		if p == nil || isSelfPeer(st.Self, p) {
			continue
		}

		dnsName := strings.TrimSuffix(p.DNSName, ".")
		shortName := ""
		if dnsName != "" {
			if idx := strings.IndexByte(dnsName, '.'); idx >= 0 {
				shortName = dnsName[:idx]
			} else {
				shortName = dnsName
			}
		}

		// IPv4 排在前面，IPv6 排在后面
		ipv4s := make([]string, 0, len(p.TailscaleIPs))
		ipv6s := make([]string, 0, len(p.TailscaleIPs))
		for _, ip := range p.TailscaleIPs {
			u := ip.Unmap()
			if u.Is4() {
				ipv4s = append(ipv4s, u.String())
			} else {
				ipv6s = append(ipv6s, u.String())
			}
		}
		ips := make([]string, 0, len(ipv4s)+len(ipv6s))
		ips = append(ips, ipv4s...)
		ips = append(ips, ipv6s...)

		var lastSeen *string
		if !p.LastSeen.IsZero() {
			ts := p.LastSeen.UTC().Format(time.RFC3339)
			lastSeen = &ts
		}

		peers = append(peers, PeerInfo{
			Name:      p.HostName,
			DNSName:   dnsName,
			ShortName: shortName,
			IPs:       ips,
			OS:        p.OS,
			Online:    p.Online,
			LastSeen:  lastSeen,
		})
	}

	// 排序：在线在前，再按名称升序（不区分大小写）
	sort.Slice(peers, func(i, j int) bool {
		if peers[i].Online != peers[j].Online {
			return peers[i].Online
		}
		ni := peerSortName(peers[i])
		nj := peerSortName(peers[j])
		li := strings.ToLower(ni)
		lj := strings.ToLower(nj)
		if li != lj {
			return li < lj
		}
		if ni != nj {
			return ni < nj
		}
		if peers[i].DNSName != peers[j].DNSName {
			return peers[i].DNSName < peers[j].DNSName
		}
		var ipi, ipj string
		if len(peers[i].IPs) > 0 {
			ipi = peers[i].IPs[0]
		}
		if len(peers[j].IPs) > 0 {
			ipj = peers[j].IPs[0]
		}
		return ipi < ipj
	})

	return PeersResponse{
		State: state,
		Peers: peers,
	}
}

func isSelfPeer(self, peer *ipnstate.PeerStatus) bool {
	if self == nil || peer == nil {
		return false
	}
	if peer == self {
		return true
	}
	if self.ID != "" && peer.ID == self.ID {
		return true
	}
	if !self.PublicKey.IsZero() && peer.PublicKey == self.PublicKey {
		return true
	}
	return false
}

func peerSortName(p PeerInfo) string {
	if p.Name != "" {
		return p.Name
	}
	if p.ShortName != "" {
		return p.ShortName
	}
	return p.DNSName
}

func (i *Instance) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), loginTimeout)
	defer cancel()

	// Subscribe to IPN bus before triggering interactive login so we never miss BrowseToURL.
	watcher, err := i.backend.WatchIPNBus(ctx, ipn.NotifyInitialState)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("watch ipn bus: %v", err)})
		return
	}
	defer watcher.Close()

	if err := i.backend.StartLoginInteractive(ctx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("start login: %v", err)})
		return
	}

	for {
		n, err := watcher.Next()
		if err != nil {
			// Before failing on timeout, check whether Status already has an AuthURL.
			fallbackCtx, fallbackCancel := context.WithTimeout(context.Background(), loginStatusFallbackTimeout)
			st, stErr := i.backend.Status(fallbackCtx)
			fallbackCancel()
			if stErr == nil && st != nil && st.AuthURL != "" {
				writeJSON(w, http.StatusOK, map[string]string{"authURL": st.AuthURL})
				return
			}
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": fmt.Sprintf("waiting for auth URL: %v", err)})
			return
		}
		if n.BrowseToURL != nil && *n.BrowseToURL != "" {
			writeJSON(w, http.StatusOK, map[string]string{"authURL": *n.BrowseToURL})
			return
		}
		if n.State != nil && *n.State == ipn.Running {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "already logged in"})
			return
		}
	}
}

func (i *Instance) handleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if err := i.backend.Logout(ctx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func generateToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
