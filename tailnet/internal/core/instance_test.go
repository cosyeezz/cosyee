package core

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
)

type mockWatcher struct {
	ch     chan ipn.Notify
	closed chan struct{}
	once   sync.Once
}

func newMockWatcher() *mockWatcher {
	return &mockWatcher{
		ch:     make(chan ipn.Notify, 8),
		closed: make(chan struct{}),
	}
}

func (w *mockWatcher) Next() (ipn.Notify, error) {
	select {
	case n, ok := <-w.ch:
		if !ok {
			return ipn.Notify{}, io.EOF
		}
		return n, nil
	case <-w.closed:
		return ipn.Notify{}, io.EOF
	}
}

func (w *mockWatcher) Close() error {
	w.once.Do(func() { close(w.closed) })
	return nil
}

type mockBackend struct {
	mu                sync.Mutex
	status            *ipnstate.Status
	statusErr         error
	statusFn          func(ctx context.Context) (*ipnstate.Status, error)
	statusWithPeersFn func(ctx context.Context) (*ipnstate.Status, error)
	logoutCalled      bool
	dialedAddrs       []string
	dialFn            func(ctx context.Context, network, address string) (net.Conn, error)
	authURLToHit      string
	watcher           *mockWatcher
	closeWatcher      bool
}

func (m *mockBackend) Start() error { return nil }
func (m *mockBackend) Close() error { return nil }

func (m *mockBackend) Dial(ctx context.Context, network, address string) (net.Conn, error) {
	m.mu.Lock()
	m.dialedAddrs = append(m.dialedAddrs, address)
	fn := m.dialFn
	m.mu.Unlock()
	if fn != nil {
		return fn(ctx, network, address)
	}
	return nil, errors.New("no dialFn configured")
}

func (m *mockBackend) Status(ctx context.Context) (*ipnstate.Status, error) {
	m.mu.Lock()
	fn := m.statusFn
	st := m.status
	err := m.statusErr
	m.mu.Unlock()
	if fn != nil {
		return fn(ctx)
	}
	return st, err
}

func (m *mockBackend) StatusWithPeers(ctx context.Context) (*ipnstate.Status, error) {
	m.mu.Lock()
	fn := m.statusWithPeersFn
	st := m.status
	err := m.statusErr
	m.mu.Unlock()
	if fn != nil {
		return fn(ctx)
	}
	return st, err
}

func (m *mockBackend) StartLoginInteractive(ctx context.Context) error {
	m.mu.Lock()
	w := m.watcher
	u := m.authURLToHit
	closeNow := m.closeWatcher
	m.mu.Unlock()
	if closeNow && w != nil {
		_ = w.Close()
		return nil
	}
	if w != nil && u != "" {
		urlCopy := u
		w.ch <- ipn.Notify{BrowseToURL: &urlCopy}
	}
	return nil
}

func (m *mockBackend) Logout(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.logoutCalled = true
	return nil
}

func (m *mockBackend) WatchIPNBus(ctx context.Context, mask ipn.NotifyWatchOpt) (IPNWatcher, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.watcher = newMockWatcher()
	return m.watcher, nil
}

func TestReadyJSONFormat(t *testing.T) {
	mb := &mockBackend{
		status: &ipnstate.Status{BackendState: "NeedsLogin"},
	}
	inst, ready, err := Start(Config{
		Backend: mb,
		Version: "1.2.3",
	})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer inst.Stop()

	raw := ready.JSON()
	var parsed map[string]any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		t.Fatalf("invalid ready JSON: %v (%s)", err, raw)
	}

	if parsed["type"] != "ready" {
		t.Fatalf("expected type=ready, got %v", parsed["type"])
	}
	if parsed["version"] != "1.2.3" {
		t.Fatalf("expected version=1.2.3, got %v", parsed["version"])
	}
	if !strings.HasPrefix(ready.Control, "127.0.0.1:") {
		t.Fatalf("unexpected control addr: %s", ready.Control)
	}
	if !strings.HasPrefix(ready.Socks, "127.0.0.1:") {
		t.Fatalf("unexpected socks addr: %s", ready.Socks)
	}
	tokBytes, err := hex.DecodeString(ready.Token)
	if err != nil || len(tokBytes) != 32 {
		t.Fatalf("expected 32-byte hex token, got %q (err=%v)", ready.Token, err)
	}

	errJSON := FormatErrorJSON(errors.New("boom"))
	var errParsed map[string]any
	if err := json.Unmarshal([]byte(errJSON), &errParsed); err != nil {
		t.Fatalf("invalid error JSON: %v", err)
	}
	if errParsed["type"] != "error" || errParsed["error"] != "boom" {
		t.Fatalf("unexpected error JSON: %s", errJSON)
	}
}

func TestControlAuthHostAndEndpoints(t *testing.T) {
	mb := &mockBackend{
		status:       &ipnstate.Status{BackendState: "NeedsLogin"},
		authURLToHit: "https://login.tailscale.com/a/abc123",
	}
	inst, ready, err := Start(Config{
		Backend: mb,
		Version: "1.0.0",
	})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer inst.Stop()

	client := &http.Client{Timeout: 5 * time.Second}
	baseURL := "http://" + ready.Control

	// 1. Missing token -> 401
	resp, err := client.Get(baseURL + "/status")
	if err != nil {
		t.Fatalf("GET /status: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", resp.StatusCode)
	}

	// 2. Wrong token -> 401
	req, _ := http.NewRequest(http.MethodGet, baseURL+"/status", nil)
	req.Header.Set("Authorization", "Bearer wrong-token")
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("GET /status wrong token: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 with wrong token, got %d", resp.StatusCode)
	}

	// 3. Wrong Host header -> 403 (even with valid token)
	req, _ = http.NewRequest(http.MethodGet, baseURL+"/status", nil)
	req.Host = "evil.example.com:8080"
	req.Header.Set("Authorization", "Bearer "+ready.Token)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("GET /status wrong host: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 with wrong Host, got %d", resp.StatusCode)
	}

	// 4. Valid GET /status in NeedsLogin state
	req, _ = http.NewRequest(http.MethodGet, baseURL+"/status", nil)
	req.Header.Set("Authorization", "Bearer "+ready.Token)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("GET /status valid: %v", err)
	}
	var stNeedsLogin map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&stNeedsLogin); err != nil {
		t.Fatalf("decode /status: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if stNeedsLogin["state"] != "NeedsLogin" || stNeedsLogin["version"] != "1.0.0" {
		t.Fatalf("unexpected /status payload: %#v", stNeedsLogin)
	}
	if stNeedsLogin["authURL"] != nil || stNeedsLogin["self"] != nil || stNeedsLogin["tailnet"] != nil || stNeedsLogin["error"] != nil {
		t.Fatalf("expected null optional fields in NeedsLogin, got %#v", stNeedsLogin)
	}

	// 5. Valid GET /status in Running state (DNSName trailing dot stripped)
	mb.mu.Lock()
	mb.status = &ipnstate.Status{
		BackendState: "Running",
		TailscaleIPs: []netip.Addr{
			netip.MustParseAddr("100.64.0.10"),
			netip.MustParseAddr("fd7a:115c:a1e0::10"),
		},
		Self: &ipnstate.PeerStatus{
			HostName: "cosyee-win",
			DNSName:  "cosyee-win.demo.ts.net.",
		},
		CurrentTailnet: &ipnstate.TailnetStatus{
			Name:           "demo.ts.net",
			MagicDNSSuffix: "demo.ts.net",
		},
	}
	mb.mu.Unlock()

	req, _ = http.NewRequest(http.MethodGet, baseURL+"/status", nil)
	req.Header.Set("Authorization", "Bearer "+ready.Token)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("GET /status running: %v", err)
	}
	var stRunning StatusResponse
	if err := json.NewDecoder(resp.Body).Decode(&stRunning); err != nil {
		t.Fatalf("decode running /status: %v", err)
	}
	resp.Body.Close()
	if stRunning.State != "Running" || stRunning.Self == nil || stRunning.Self.DNSName != "cosyee-win.demo.ts.net" {
		t.Fatalf("unexpected running status: %+v", stRunning)
	}
	if stRunning.Tailnet == nil || *stRunning.Tailnet != "demo.ts.net" || len(stRunning.Self.IPs) != 2 {
		t.Fatalf("unexpected tailnet/ips: %+v", stRunning)
	}

	// 6. POST /login returns authURL
	req, _ = http.NewRequest(http.MethodPost, baseURL+"/login", nil)
	req.Header.Set("Authorization", "Bearer "+ready.Token)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("POST /login: %v", err)
	}
	var loginResp map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&loginResp); err != nil {
		t.Fatalf("decode /login: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || loginResp["authURL"] != "https://login.tailscale.com/a/abc123" {
		t.Fatalf("unexpected /login response: status=%d body=%v", resp.StatusCode, loginResp)
	}

	// 7. POST /logout returns {"ok":true}
	req, _ = http.NewRequest(http.MethodPost, baseURL+"/logout", nil)
	req.Header.Set("Authorization", "Bearer "+ready.Token)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("POST /logout: %v", err)
	}
	var logoutResp map[string]bool
	if err := json.NewDecoder(resp.Body).Decode(&logoutResp); err != nil {
		t.Fatalf("decode /logout: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !logoutResp["ok"] || !mb.logoutCalled {
		t.Fatalf("unexpected /logout response: status=%d body=%v called=%v", resp.StatusCode, logoutResp, mb.logoutCalled)
	}
}

func TestSOCKS5AuthAndConnect(t *testing.T) {
	// Start a local echo server to serve as our simulated tailnet peer.
	echoLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen echo: %v", err)
	}
	defer echoLn.Close()
	go func() {
		for {
			c, err := echoLn.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}(c)
		}
	}()

	mb := &mockBackend{
		status: &ipnstate.Status{BackendState: "Running"},
		dialFn: func(ctx context.Context, network, address string) (net.Conn, error) {
			return net.Dial("tcp", echoLn.Addr().String())
		},
	}

	inst, ready, err := Start(Config{
		Backend: mb,
		Version: "1.0.0",
	})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer inst.Stop()

	// 1. No-auth greeting should be rejected (0x05, 0xFF).
	conn, err := net.DialTimeout("tcp", ready.Socks, 3*time.Second)
	if err != nil {
		t.Fatalf("dial socks: %v", err)
	}
	_, _ = conn.Write([]byte{0x05, 0x01, 0x00})
	var greetResp [2]byte
	if _, err := io.ReadFull(conn, greetResp[:]); err != nil {
		t.Fatalf("read no-auth greet: %v", err)
	}
	conn.Close()
	if greetResp[0] != 0x05 || greetResp[1] != 0xFF {
		t.Fatalf("expected no-auth rejected (0x05,0xFF), got %x", greetResp)
	}

	// 2. Wrong password should fail user/pass auth (status != 0).
	conn, err = net.DialTimeout("tcp", ready.Socks, 3*time.Second)
	if err != nil {
		t.Fatalf("dial socks: %v", err)
	}
	_, _ = conn.Write([]byte{0x05, 0x01, 0x02})
	if _, err := io.ReadFull(conn, greetResp[:]); err != nil || greetResp[1] != 0x02 {
		t.Fatalf("expected user/pass auth selection, got %x (err=%v)", greetResp, err)
	}
	_, _ = conn.Write(buildSOCKS5Auth("cosyee", "wrong-password"))
	var authResp [2]byte
	if _, err := io.ReadFull(conn, authResp[:]); err != nil {
		t.Fatalf("read bad auth resp: %v", err)
	}
	conn.Close()
	if authResp[1] == 0x00 {
		t.Fatalf("expected auth failure for wrong password, got success")
	}

	// 3. Valid credentials + CONNECT to MagicDNS short name -> forwarded through Backend.Dial.
	conn, err = net.DialTimeout("tcp", ready.Socks, 3*time.Second)
	if err != nil {
		t.Fatalf("dial socks: %v", err)
	}
	defer conn.Close()
	_, _ = conn.Write([]byte{0x05, 0x01, 0x02})
	if _, err := io.ReadFull(conn, greetResp[:]); err != nil || greetResp[1] != 0x02 {
		t.Fatalf("greeting failed: %x (err=%v)", greetResp, err)
	}
	_, _ = conn.Write(buildSOCKS5Auth("cosyee", ready.Token))
	if _, err := io.ReadFull(conn, authResp[:]); err != nil || authResp[1] != 0x00 {
		t.Fatalf("valid auth failed: %x (err=%v)", authResp, err)
	}

	// CONNECT ATYP=DOMAIN "mybox.demo.ts.net:7878"
	host := "mybox.demo.ts.net"
	req := make([]byte, 0, 7+len(host))
	req = append(req, 0x05, 0x01, 0x00, 0x03, byte(len(host)))
	req = append(req, host...)
	var portBuf [2]byte
	binary.BigEndian.PutUint16(portBuf[:], 7878)
	req = append(req, portBuf[:]...)
	_, _ = conn.Write(req)

	// Read SOCKS5 reply header (4 bytes + bind addr).
	var hdr [4]byte
	if _, err := io.ReadFull(conn, hdr[:]); err != nil {
		t.Fatalf("read connect reply: %v", err)
	}
	if hdr[0] != 0x05 || hdr[1] != 0x00 {
		t.Fatalf("expected CONNECT success, got %x", hdr)
	}
	switch hdr[3] {
	case 0x01:
		_, _ = io.CopyN(io.Discard, conn, 4+2)
	case 0x04:
		_, _ = io.CopyN(io.Discard, conn, 16+2)
	case 0x03:
		var l [1]byte
		_, _ = io.ReadFull(conn, l[:])
		_, _ = io.CopyN(io.Discard, conn, int64(l[0])+2)
	}

	// Verify echo traffic flows through the tunnel.
	if _, err := conn.Write([]byte("ping-tailnet")); err != nil {
		t.Fatalf("write through socks: %v", err)
	}
	buf := make([]byte, len("ping-tailnet"))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read echo through socks: %v", err)
	}
	if string(buf) != "ping-tailnet" {
		t.Fatalf("unexpected echo payload: %q", string(buf))
	}

	mb.mu.Lock()
	defer mb.mu.Unlock()
	if len(mb.dialedAddrs) != 1 || mb.dialedAddrs[0] != "mybox.demo.ts.net:7878" {
		t.Fatalf("expected Backend.Dial to receive MagicDNS host, got %v", mb.dialedAddrs)
	}
}

func buildSOCKS5Auth(user, pass string) []byte {
	b := make([]byte, 0, 3+len(user)+len(pass))
	b = append(b, 0x01, byte(len(user)))
	b = append(b, user...)
	b = append(b, byte(len(pass)))
	b = append(b, pass...)
	return b
}

func TestRotatingWriter(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "tailnet.log")
	w, err := NewRotatingWriter(logPath, 64)
	if err != nil {
		t.Fatalf("NewRotatingWriter: %v", err)
	}
	defer w.Close()

	for i := 0; i < 10; i++ {
		w.Logf("entry %d some padding text", i)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := os.Stat(logPath); err != nil {
		t.Fatalf("expected active log file: %v", err)
	}
	if _, err := os.Stat(logPath + ".1"); err != nil {
		t.Fatalf("expected rotated backup log.1: %v", err)
	}
}

func TestRotatingWriterDoesNotReopenAfterClose(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "tailnet.log")
	w, err := NewRotatingWriter(logPath, 1024)
	if err != nil {
		t.Fatalf("NewRotatingWriter: %v", err)
	}

	w.Logf("before close")
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := os.Remove(logPath); err != nil {
		t.Fatalf("remove log file: %v", err)
	}

	if _, err := w.Write([]byte("after close\n")); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("expected os.ErrClosed on Write after Close, got %v", err)
	}
	w.Logf("logf after close should be ignored without reopening")

	if _, err := os.Stat(logPath); !os.IsNotExist(err) {
		t.Fatalf("expected log file not to be reopened after Close, stat err=%v", err)
	}
}

func TestStopResetsLogOutputToDiscard(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "tailnet.log")
	mb := &mockBackend{status: &ipnstate.Status{BackendState: "Running"}}

	inst, _, err := Start(Config{
		Backend: mb,
		LogFile: logPath,
		Version: "1.0.0",
	})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	if err := inst.Stop(); err != nil {
		t.Fatalf("Stop failed: %v", err)
	}

	if log.Writer() != io.Discard {
		t.Fatalf("expected standard log output to be reset to io.Discard after Stop")
	}
	if err := os.Remove(logPath); err != nil {
		t.Fatalf("remove log file: %v", err)
	}
	log.Println("message after Stop must be discarded")
	if _, err := os.Stat(logPath); !os.IsNotExist(err) {
		t.Fatalf("expected log file not to be recreated by standard logger after Stop, stat err=%v", err)
	}
}

func TestBuildStatusResponseNil(t *testing.T) {
	resp := buildStatusResponse("1.0.0", nil)
	if resp.State != "Error" || resp.Error == nil || *resp.Error == "" {
		t.Fatalf("expected Error status for nil ipnstate.Status, got %+v", resp)
	}

	mb := &mockBackend{status: nil}
	inst, ready, err := Start(Config{
		Backend: mb,
		Version: "1.0.0",
	})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer inst.Stop()

	req, _ := http.NewRequest(http.MethodGet, "http://"+ready.Control+"/status", nil)
	req.Header.Set("Authorization", "Bearer "+ready.Token)
	httpResp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("GET /status with nil status: %v", err)
	}
	defer httpResp.Body.Close()

	var got StatusResponse
	if err := json.NewDecoder(httpResp.Body).Decode(&got); err != nil {
		t.Fatalf("decode /status: %v", err)
	}
	if got.State != "Error" || got.Error == nil || *got.Error == "" {
		t.Fatalf("expected Error response for nil backend status, got %+v", got)
	}
}

func TestSOCKS5DialerPanicRecovered(t *testing.T) {
	echoLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen echo: %v", err)
	}
	defer echoLn.Close()
	go func() {
		for {
			c, err := echoLn.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}(c)
		}
	}()

	var attempts atomic.Int32
	mb := &mockBackend{
		status: &ipnstate.Status{BackendState: "Running"},
		dialFn: func(ctx context.Context, network, address string) (net.Conn, error) {
			if attempts.Add(1) == 1 {
				panic("simulated dial panic")
			}
			return net.Dial("tcp", echoLn.Addr().String())
		},
	}

	inst, ready, err := Start(Config{
		Backend: mb,
		Version: "1.0.0",
	})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer inst.Stop()

	doConnect := func() (byte, net.Conn) {
		conn, err := net.DialTimeout("tcp", ready.Socks, 3*time.Second)
		if err != nil {
			t.Fatalf("dial socks: %v", err)
		}
		var greetResp [2]byte
		_, _ = conn.Write([]byte{0x05, 0x01, 0x02})
		if _, err := io.ReadFull(conn, greetResp[:]); err != nil || greetResp[1] != 0x02 {
			t.Fatalf("greeting failed: %x (err=%v)", greetResp, err)
		}
		var authResp [2]byte
		_, _ = conn.Write(buildSOCKS5Auth("cosyee", ready.Token))
		if _, err := io.ReadFull(conn, authResp[:]); err != nil || authResp[1] != 0x00 {
			t.Fatalf("auth failed: %x (err=%v)", authResp, err)
		}
		host := "peer.demo.ts.net"
		req := make([]byte, 0, 7+len(host))
		req = append(req, 0x05, 0x01, 0x00, 0x03, byte(len(host)))
		req = append(req, host...)
		var portBuf [2]byte
		binary.BigEndian.PutUint16(portBuf[:], 8080)
		req = append(req, portBuf[:]...)
		_, _ = conn.Write(req)

		var hdr [4]byte
		if _, err := io.ReadFull(conn, hdr[:]); err != nil {
			t.Fatalf("read connect reply: %v", err)
		}
		return hdr[1], conn
	}

	// First request panics in Backend.Dial -> recovered into SOCKS5 error reply (non-zero).
	replyCode, conn1 := doConnect()
	conn1.Close()
	if replyCode == 0x00 {
		t.Fatalf("expected non-zero SOCKS5 reply code on dialer panic, got 0x00")
	}

	// Second request should still succeed cleanly.
	replyCode, conn2 := doConnect()
	defer conn2.Close()
	if replyCode != 0x00 {
		t.Fatalf("expected SOCKS5 CONNECT success after prior dialer panic, got reply 0x%02x", replyCode)
	}
}

type panicAcceptListener struct {
	addr net.Addr
}

func (p *panicAcceptListener) Accept() (net.Conn, error) {
	panic("simulated socks listener panic")
}
func (p *panicAcceptListener) Close() error   { return nil }
func (p *panicAcceptListener) Addr() net.Addr { return p.addr }

func TestSOCKS5ServerGoroutinePanicMarksInstanceError(t *testing.T) {
	mb := &mockBackend{
		status: &ipnstate.Status{BackendState: "Running"},
	}

	var listenCalls atomic.Int32
	inst, ready, err := startWithListen(Config{
		Backend: mb,
		Version: "1.0.0",
	}, func(network, address string) (net.Listener, error) {
		if listenCalls.Add(1) == 1 {
			return net.Listen(network, address)
		}
		return &panicAcceptListener{addr: &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 1}}, nil
	})
	if err != nil {
		t.Fatalf("startWithListen failed: %v", err)
	}
	defer inst.Stop()

	client := &http.Client{Timeout: 5 * time.Second}
	deadline := time.Now().Add(2 * time.Second)
	for {
		req, _ := http.NewRequest(http.MethodGet, "http://"+ready.Control+"/status", nil)
		req.Header.Set("Authorization", "Bearer "+ready.Token)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("GET /status: %v", err)
		}
		var st StatusResponse
		if err := json.NewDecoder(resp.Body).Decode(&st); err != nil {
			resp.Body.Close()
			t.Fatalf("decode /status: %v", err)
		}
		resp.Body.Close()

		if st.State == "Error" && st.Error != nil && strings.Contains(*st.Error, "simulated socks listener panic") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("expected /status to report Error after socks5 goroutine panic, got %+v", st)
		}
		time.Sleep(15 * time.Millisecond)
	}
}

func TestHandleLoginFallbackHasTimeoutAndHandlesNilStatus(t *testing.T) {
	var (
		hasDeadline bool
		remaining   time.Duration
	)
	mb := &mockBackend{
		closeWatcher: true,
		statusFn: func(ctx context.Context) (*ipnstate.Status, error) {
			if dl, ok := ctx.Deadline(); ok {
				hasDeadline = true
				remaining = time.Until(dl)
			}
			return nil, nil
		},
	}

	inst, ready, err := Start(Config{
		Backend: mb,
		Version: "1.0.0",
	})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer inst.Stop()

	req, _ := http.NewRequest(http.MethodPost, "http://"+ready.Control+"/login", nil)
	req.Header.Set("Authorization", "Bearer "+ready.Token)
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("POST /login: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusGatewayTimeout {
		t.Fatalf("expected 504 GatewayTimeout, got %d", resp.StatusCode)
	}
	if !hasDeadline {
		t.Fatalf("expected fallback Status call to have a timeout deadline")
	}
	if remaining <= 0 || remaining > 3*time.Second {
		t.Fatalf("expected ~2s fallback timeout, got remaining=%v", remaining)
	}
}

func TestPeersEndpoint(t *testing.T) {
	mb := &mockBackend{
		status: &ipnstate.Status{BackendState: "NeedsLogin"},
	}
	inst, ready, err := Start(Config{
		Backend: mb,
		Version: "1.1.0",
	})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer inst.Stop()

	client := &http.Client{Timeout: 5 * time.Second}
	baseURL := "http://" + ready.Control

	// 1. 鉴权与 Host 校验：无 token -> 401，错 token -> 401，错 Host -> 403，非 GET -> 405
	resp, err := client.Get(baseURL + "/peers")
	if err != nil {
		t.Fatalf("GET /peers without token: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", resp.StatusCode)
	}

	req, _ := http.NewRequest(http.MethodGet, baseURL+"/peers", nil)
	req.Header.Set("Authorization", "Bearer wrong-token")
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("GET /peers wrong token: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 with wrong token, got %d", resp.StatusCode)
	}

	req, _ = http.NewRequest(http.MethodGet, baseURL+"/peers", nil)
	req.Host = "evil.example.com:8080"
	req.Header.Set("Authorization", "Bearer "+ready.Token)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("GET /peers wrong host: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 with wrong Host, got %d", resp.StatusCode)
	}

	req, _ = http.NewRequest(http.MethodPost, baseURL+"/peers", nil)
	req.Header.Set("Authorization", "Bearer "+ready.Token)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("POST /peers: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 for POST /peers, got %d", resp.StatusCode)
	}

	// 2. 未登录状态返回 200、空列表与 state 字段，不报 500
	req, _ = http.NewRequest(http.MethodGet, baseURL+"/peers", nil)
	req.Header.Set("Authorization", "Bearer "+ready.Token)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("GET /peers NeedsLogin: %v", err)
	}
	var rawNeedsLogin map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&rawNeedsLogin); err != nil {
		resp.Body.Close()
		t.Fatalf("decode NeedsLogin /peers: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 in NeedsLogin, got %d", resp.StatusCode)
	}
	if rawNeedsLogin["state"] != "NeedsLogin" {
		t.Fatalf("expected state=NeedsLogin, got %#v", rawNeedsLogin["state"])
	}
	peersSlice, ok := rawNeedsLogin["peers"].([]any)
	if !ok || len(peersSlice) != 0 {
		t.Fatalf("expected empty JSON array for peers in NeedsLogin, got %#v", rawNeedsLogin["peers"])
	}

	// 3. Running 状态：排除本机、IPv4 在前、lastSeen RFC3339/null、排序（在线在前再按名称）
	selfKey := key.NewNode().Public()
	k1 := key.NewNode().Public()
	k2 := key.NewNode().Public()
	k3 := key.NewNode().Public()
	k4 := key.NewNode().Public()
	seenAt := time.Date(2026, 11, 25, 10, 20, 30, 0, time.UTC)

	mb.mu.Lock()
	mb.status = &ipnstate.Status{
		BackendState: "Running",
		Self: &ipnstate.PeerStatus{
			ID:        tailcfg.StableNodeID("self-id"),
			PublicKey: selfKey,
			HostName:  "cosyee-self",
			DNSName:   "cosyee-self.demo.ts.net.",
			Online:    true,
		},
		Peer: map[key.NodePublic]*ipnstate.PeerStatus{
			// 模拟本机混入 Peer map，必须被排除
			selfKey: {
				ID:        tailcfg.StableNodeID("self-id"),
				PublicKey: selfKey,
				HostName:  "cosyee-self",
				DNSName:   "cosyee-self.demo.ts.net.",
				TailscaleIPs: []netip.Addr{
					netip.MustParseAddr("100.64.0.1"),
				},
				OS:     "windows",
				Online: true,
			},
			k1: {
				ID:        tailcfg.StableNodeID("node-1"),
				PublicKey: k1,
				HostName:  "zeta-box",
				DNSName:   "zeta-box.demo.ts.net.",
				TailscaleIPs: []netip.Addr{
					netip.MustParseAddr("fd7a:115c:a1e0::2"),
					netip.MustParseAddr("100.64.0.2"),
				},
				OS:     "linux",
				Online: true,
			},
			k2: {
				ID:        tailcfg.StableNodeID("node-2"),
				PublicKey: k2,
				HostName:  "Alpha-Mac",
				DNSName:   "alpha-mac.demo.ts.net.",
				TailscaleIPs: []netip.Addr{
					netip.MustParseAddr("100.64.0.3"),
				},
				OS:       "macos",
				Online:   true,
				LastSeen: seenAt,
			},
			k3: {
				ID:        tailcfg.StableNodeID("node-3"),
				PublicKey: k3,
				HostName:  "beta-offline",
				DNSName:   "beta-offline.demo.ts.net.",
				TailscaleIPs: []netip.Addr{
					netip.MustParseAddr("100.64.0.4"),
				},
				OS:       "android",
				Online:   false,
				LastSeen: seenAt,
			},
			k4: {
				ID:        tailcfg.StableNodeID("node-4"),
				PublicKey: k4,
				HostName:  "aardvark-offline",
				DNSName:   "aardvark-offline.demo.ts.net.",
				TailscaleIPs: []netip.Addr{
					netip.MustParseAddr("fd7a:115c:a1e0::5"),
				},
				OS:     "ios",
				Online: false,
			},
		},
	}
	mb.mu.Unlock()

	req, _ = http.NewRequest(http.MethodGet, baseURL+"/peers", nil)
	req.Header.Set("Authorization", "Bearer "+ready.Token)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("GET /peers Running: %v", err)
	}
	var got PeersResponse
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		resp.Body.Close()
		t.Fatalf("decode Running /peers: %v", err)
	}
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK || got.State != "Running" {
		t.Fatalf("unexpected /peers status=%d body=%+v", resp.StatusCode, got)
	}
	if len(got.Peers) != 4 {
		t.Fatalf("expected 4 peers (excluding self), got %d: %+v", len(got.Peers), got.Peers)
	}

	// 验证排序：在线在前（Alpha-Mac, zeta-box），再离线按名称（aardvark-offline, beta-offline）
	wantOrder := []string{"Alpha-Mac", "zeta-box", "aardvark-offline", "beta-offline"}
	for idx, wantName := range wantOrder {
		if got.Peers[idx].Name != wantName {
			t.Fatalf("peer[%d].Name = %q, want %q (all=%+v)", idx, got.Peers[idx].Name, wantName, got.Peers)
		}
	}

	// 验证 Alpha-Mac 字段
	p0 := got.Peers[0]
	if p0.DNSName != "alpha-mac.demo.ts.net" || p0.ShortName != "alpha-mac" || p0.OS != "macos" || !p0.Online {
		t.Fatalf("unexpected Alpha-Mac fields: %+v", p0)
	}
	if p0.LastSeen == nil || *p0.LastSeen != "2026-11-25T10:20:30Z" {
		t.Fatalf("unexpected Alpha-Mac lastSeen: %+v", p0.LastSeen)
	}

	// 验证 zeta-box：IPv4 排在 IPv6 前面，未设置 LastSeen 时为 nil
	p1 := got.Peers[1]
	if len(p1.IPs) != 2 || p1.IPs[0] != "100.64.0.2" || p1.IPs[1] != "fd7a:115c:a1e0::2" {
		t.Fatalf("expected IPv4 before IPv6 for zeta-box, got %v", p1.IPs)
	}
	if p1.LastSeen != nil {
		t.Fatalf("expected nil lastSeen for zeta-box, got %v", *p1.LastSeen)
	}
}
