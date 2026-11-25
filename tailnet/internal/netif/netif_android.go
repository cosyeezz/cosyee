//go:build android && cgo

package netif

/*
#include <stdlib.h>
#include <string.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <unistd.h>

static int get_if_mtu(const char *name) {
	int fd = socket(AF_INET, SOCK_DGRAM, 0);
	if (fd < 0) {
		return 1500;
	}
	struct ifreq ifr;
	memset(&ifr, 0, sizeof(ifr));
	strncpy(ifr.ifr_name, name, IFNAMSIZ - 1);
	int mtu = 1500;
	if (ioctl(fd, SIOCGIFMTU, &ifr) == 0 && ifr.ifr_mtu > 0) {
		mtu = ifr.ifr_mtu;
	}
	close(fd);
	return mtu;
}
*/
import "C"

import (
	"errors"
	"net"
	"net/netip"
	"sync"
	"time"
	"unsafe"

	"tailscale.com/net/netmon"

	// Fixes DNS resolution on Android where /etc/resolv.conf does not exist.
	_ "tailscale.com/feature/androiddns"
)

var registerOnce sync.Once

// Register installs a bionic getifaddrs-based interface getter into netmon.
// Android 11+ (API 30+) blocks Go's stdlib net.Interfaces() due to NETLINK_ROUTE restrictions,
// while bionic's getifaddrs() (API 24+) remains permitted for app processes.
func Register() {
	registerOnce.Do(func() {
		netmon.RegisterInterfaceGetter(getInterfaces)
	})
}

func getInterfaces() ([]netmon.Interface, error) {
	ifaces, err := getInterfacesBionic()
	if err == nil && len(ifaces) > 0 {
		return ifaces, nil
	}
	// Fallback: probe outbound UDP routes if getifaddrs is blocked or returns nothing.
	return syntheticOutboundInterfaces()
}

func getInterfacesBionic() ([]netmon.Interface, error) {
	var ifap *C.struct_ifaddrs
	if rc := C.getifaddrs(&ifap); rc != 0 {
		return nil, errors.New("bionic getifaddrs failed")
	}
	defer C.freeifaddrs(ifap)

	byName := make(map[string]*netmon.Interface)
	var order []string

	for ifa := ifap; ifa != nil; ifa = ifa.ifa_next {
		if ifa.ifa_name == nil {
			continue
		}
		name := C.GoString(ifa.ifa_name)
		entry, ok := byName[name]
		if !ok {
			idx := int(C.if_nametoindex(ifa.ifa_name))
			mtu := int(C.get_if_mtu(ifa.ifa_name))
			entry = &netmon.Interface{
				Interface: &net.Interface{
					Index: idx,
					MTU:   mtu,
					Name:  name,
					Flags: convertFlags(uint32(ifa.ifa_flags)),
				},
			}
			byName[name] = entry
			order = append(order, name)
		}

		if ifa.ifa_addr == nil {
			continue
		}
		if ipNet := sockaddrToIPNet(ifa.ifa_addr, ifa.ifa_netmask); ipNet != nil {
			entry.AltAddrs = append(entry.AltAddrs, ipNet)
		}
	}

	out := make([]netmon.Interface, 0, len(order))
	for _, name := range order {
		out = append(out, *byName[name])
	}
	return out, nil
}

func convertFlags(raw uint32) net.Flags {
	var f net.Flags
	if raw&C.IFF_UP != 0 {
		f |= net.FlagUp
	}
	if raw&C.IFF_BROADCAST != 0 {
		f |= net.FlagBroadcast
	}
	if raw&C.IFF_LOOPBACK != 0 {
		f |= net.FlagLoopback
	}
	if raw&C.IFF_POINTOPOINT != 0 {
		f |= net.FlagPointToPoint
	}
	if raw&C.IFF_MULTICAST != 0 {
		f |= net.FlagMulticast
	}
	if raw&C.IFF_RUNNING != 0 {
		f |= net.FlagRunning
	}
	return f
}

func sockaddrToIPNet(addr, mask *C.struct_sockaddr) *net.IPNet {
	switch addr.sa_family {
	case C.AF_INET:
		sin := (*C.struct_sockaddr_in)(unsafe.Pointer(addr))
		ip := make(net.IP, net.IPv4len)
		copy(ip, unsafe.Slice((*byte)(unsafe.Pointer(&sin.sin_addr)), net.IPv4len))
		var ipMask net.IPMask
		if mask != nil && mask.sa_family == C.AF_INET {
			msin := (*C.struct_sockaddr_in)(unsafe.Pointer(mask))
			ipMask = make(net.IPMask, net.IPv4len)
			copy(ipMask, unsafe.Slice((*byte)(unsafe.Pointer(&msin.sin_addr)), net.IPv4len))
		} else {
			ipMask = net.CIDRMask(32, 32)
		}
		return &net.IPNet{IP: ip, Mask: ipMask}

	case C.AF_INET6:
		sin6 := (*C.struct_sockaddr_in6)(unsafe.Pointer(addr))
		ip := make(net.IP, net.IPv6len)
		copy(ip, unsafe.Slice((*byte)(unsafe.Pointer(&sin6.sin6_addr)), net.IPv6len))
		var ipMask net.IPMask
		if mask != nil && mask.sa_family == C.AF_INET6 {
			msin6 := (*C.struct_sockaddr_in6)(unsafe.Pointer(mask))
			ipMask = make(net.IPMask, net.IPv6len)
			copy(ipMask, unsafe.Slice((*byte)(unsafe.Pointer(&msin6.sin6_addr)), net.IPv6len))
		} else {
			ipMask = net.CIDRMask(128, 128)
		}
		return &net.IPNet{IP: ip, Mask: ipMask}
	default:
		return nil
	}
}

func syntheticOutboundInterfaces() ([]netmon.Interface, error) {
	var addrs []net.Addr
	if ip, ok := outboundIP("udp4", "8.8.8.8:53"); ok {
		addrs = append(addrs, &net.IPNet{IP: ip.AsSlice(), Mask: net.CIDRMask(32, 32)})
	}
	if ip, ok := outboundIP("udp6", "[2001:4860:4860::8888]:53"); ok {
		addrs = append(addrs, &net.IPNet{IP: ip.AsSlice(), Mask: net.CIDRMask(128, 128)})
	}
	if len(addrs) == 0 {
		return nil, errors.New("android netif: no outbound routes found")
	}
	return []netmon.Interface{{
		Interface: &net.Interface{
			Index: 1,
			MTU:   1500,
			Name:  "android",
			Flags: net.FlagUp | net.FlagRunning,
		},
		AltAddrs: addrs,
	}}, nil
}

func outboundIP(network, addr string) (netip.Addr, bool) {
	d := net.Dialer{Timeout: 2 * time.Second}
	c, err := d.Dial(network, addr)
	if err != nil {
		return netip.Addr{}, false
	}
	defer c.Close()
	ua, ok := c.LocalAddr().(*net.UDPAddr)
	if !ok {
		return netip.Addr{}, false
	}
	ip, ok := netip.AddrFromSlice(ua.IP)
	if !ok {
		return netip.Addr{}, false
	}
	ip = ip.Unmap()
	if ip.IsLoopback() || ip.IsUnspecified() {
		return netip.Addr{}, false
	}
	return ip, true
}
