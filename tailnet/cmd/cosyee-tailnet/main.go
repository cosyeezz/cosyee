package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/cosyeezz/cosyee/tailnet/internal/core"
	"github.com/cosyeezz/cosyee/tailnet/internal/version"
)

func main() {
	var (
		stateDir    string
		hostname    string
		logFile     string
		showVersion bool
	)

	flag.StringVar(&stateDir, "state-dir", "", "directory for persistent tsnet state")
	flag.StringVar(&hostname, "hostname", "", "tailnet hostname for this node")
	flag.StringVar(&logFile, "log-file", "", "path to rotating log file")
	flag.BoolVar(&showVersion, "version", false, "print version and exit")
	flag.Parse()

	if showVersion {
		fmt.Println(version.Version)
		return
	}

	inst, ready, err := core.Start(core.Config{
		StateDir: stateDir,
		Hostname: hostname,
		LogFile:  logFile,
	})
	if err != nil {
		fmt.Println(core.FormatErrorJSON(err))
		os.Exit(1)
	}

	// Emit ready JSON once on stdout; all subsequent logs go to --log-file.
	fmt.Println(ready.JSON())

	// Exit gracefully when stdin closes (parent process exited/crashed) or on signal.
	stdinClosed := make(chan struct{})
	go func() {
		defer close(stdinClosed)
		_, _ = io.Copy(io.Discard, os.Stdin)
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	select {
	case <-stdinClosed:
	case <-sigCh:
	}

	_ = inst.Stop()
}
