package core

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
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
	mu           sync.Mutex
	status       *ipnstate.Status
	statusErr    error
	logoutCalled bool
	dialedAddrs  []string
	dialFn       func(ctx context.Context, network, address string) (net.Conn, error)
	authURLToHit string
	watcher      *mockWatcher
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
	defer m.mu.Unlock()
	return m.status, m.statusErr
}

func (m *mockBackend) Peers(ctx context.Context) (*ipnstate.Status, error) {
	return m.Status(ctx)
}

func (m *mockBackend) StartLoginInteractive(ctx context.Context) error {
	m.mu.Lock()
	w := m.watcher
	u := m.authURLToHit
	m.mu.Unlock()
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

func TestBuildPeersResponse(t *testing.T) {
	st := &ipnstate.Status{Peer: map[key.NodePublic]*ipnstate.PeerStatus{
		key.NewNode().Public(): {HostName: "Dane's MacBook", DNSName: "danedemacbook-pro.tail1.ts.net.", TailscaleIPs: []netip.Addr{netip.MustParseAddr("100.108.140.0")}},
		key.NewNode().Public(): {HostName: "box", DNSName: "box.tail1.ts.net.", TailscaleIPs: []netip.Addr{netip.MustParseAddr("100.106.9.14"), netip.MustParseAddr("fd7a:115c:a1e0::1")}},
		key.NewNode().Public(): {HostName: "no-ip"},
	}}
	got := buildPeersResponse(st).Peers
	if len(got) != 2 {
		t.Fatalf("expected 2 peers, got %d: %+v", len(got), got)
	}
	if got[0].DNSName != "box.tail1.ts.net" || len(got[0].IPs) != 2 || got[0].IPs[0] != "100.106.9.14" {
		t.Fatalf("unexpected first peer: %+v", got[0])
	}
	if got[1].Name != "Dane's MacBook" || got[1].DNSName != "danedemacbook-pro.tail1.ts.net" || got[1].IPs[0] != "100.108.140.0" {
		t.Fatalf("unexpected second peer: %+v", got[1])
	}
	if out, _ := json.Marshal(buildPeersResponse(&ipnstate.Status{})); string(out) != `{"peers":[]}` {
		t.Fatalf("empty peers should marshal to [], got %s", out)
	}
}
