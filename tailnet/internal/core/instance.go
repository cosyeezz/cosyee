package core

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/net/socks5"

	"github.com/cosyeezz/cosyee/tailnet/internal/netif"
	"github.com/cosyeezz/cosyee/tailnet/internal/version"
)

const (
	socksUsername = "cosyee"
	loginTimeout  = 15 * time.Second
)

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
	// Always disable logtail upload before touching any tailscale package.
	_ = os.Setenv("TS_NO_LOGS_NO_SUPPORT", "true")
	// Register bionic getifaddrs on Android 11+ before netmon starts.
	netif.Register()

	ver := cfg.Version
	if ver == "" {
		ver = version.Version
	}

	logWriter, err := NewRotatingWriter(cfg.LogFile, defaultMaxLogBytes)
	if err != nil {
		return nil, ReadyMessage{}, fmt.Errorf("open log file: %w", err)
	}
	// Route Go's default logger to the rotating log file so stdout stays clean.
	log.SetOutput(logWriter)
	log.SetFlags(log.LstdFlags | log.LUTC)

	token, err := generateToken()
	if err != nil {
		_ = logWriter.Close()
		return nil, ReadyMessage{}, fmt.Errorf("generate token: %w", err)
	}

	if cfg.StateDir != "" {
		if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
			_ = logWriter.Close()
			return nil, ReadyMessage{}, fmt.Errorf("create state dir: %w", err)
		}
	}

	backend := cfg.Backend
	if backend == nil {
		backend = newTSNetBackend(cfg.StateDir, cfg.Hostname, logWriter.Logf)
	}

	if err := backend.Start(); err != nil {
		_ = logWriter.Close()
		return nil, ReadyMessage{}, fmt.Errorf("start tsnet: %w", err)
	}

	controlLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = backend.Close()
		_ = logWriter.Close()
		return nil, ReadyMessage{}, fmt.Errorf("listen control: %w", err)
	}

	socksLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = controlLn.Close()
		_ = backend.Close()
		_ = logWriter.Close()
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
		Dialer: func(ctx context.Context, network, addr string) (net.Conn, error) {
			if !strings.HasPrefix(network, "tcp") {
				return nil, fmt.Errorf("unsupported network %q: only TCP CONNECT is allowed", network)
			}
			return inst.backend.Dial(ctx, network, addr)
		},
	}

	inst.wg.Add(2)
	go func() {
		defer inst.wg.Done()
		if err := inst.httpSrv.Serve(controlLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
			inst.logWriter.Logf("control server stopped: %v", err)
		}
	}()
	go func() {
		defer inst.wg.Done()
		if err := socksSrv.Serve(socksLn); err != nil && !errors.Is(err, net.ErrClosed) {
			inst.logWriter.Logf("socks5 server stopped: %v", err)
		}
	}()

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

// Stop gracefully shuts down the HTTP server, SOCKS5 proxy, tsnet backend, and log file.
func (i *Instance) Stop() error {
	var firstErr error
	i.stopOnce.Do(func() {
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
			if st, stErr := i.backend.Status(context.Background()); stErr == nil && st.AuthURL != "" {
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
