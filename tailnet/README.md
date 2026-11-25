# cosyee-tailnet

Cosyee 客户端内置 Tailscale 组件（基于 `tailscale.com/tsnet`，用户态运行，不建 TUN、不改系统路由/DNS）。桌面端（Windows / macOS）作为可选下载组件分发；Android 端（arm64）直接随客户端 APK 打进 `jniLibs/arm64-v8a/libcosyee_tailnet.so`，默认关闭，用户点登录或手动开启时加载。

## 目录结构

- `VERSION`：组件 semver 版本号，编译时通过 `-ldflags` 注入。
- `cmd/cosyee-tailnet/`：桌面 sidecar 可执行文件入口（Windows / macOS）。
- `cmd/cosyee-tailnet-android/`：Android `c-shared` 动态库入口（`libcosyee_tailnet.so`）。
- `internal/core/`：控制 HTTP 接口、SOCKS5 代理、tsnet 生命周期与日志轮转核心实现。
- `internal/netif/`：Android 11+ 通过 cgo 调用 bionic `getifaddrs` 向 `netmon` 注册接口枚举。
- `scripts/`：构建、manifest 生成与 Ed25519 签名脚本。

## 本地构建与测试

需要 Go（见 `go.mod`）和 Node.js 20+。

```bash
cd tailnet
go vet ./...
go test ./...

# 构建桌面 sidecar（产物默认在 tailnet/dist/）
node scripts/build.mjs --target windows-x64
node scripts/build.mjs --target macos-amd64
node scripts/build.mjs --target macos-arm64
# 在 macOS 上生成通用二进制（含 lipo 与 ad-hoc codesign）
node scripts/build.mjs --target macos-universal

# 构建 Android arm64 .so（需设置 ANDROID_NDK_HOME 或 ANDROID_CC）
node scripts/build.mjs --target android-arm64
```

## 发布与签名配置

1. **仓库 Secret 配置**：
   - 名称：`TAILNET_SIGNING_KEY`
   - 值：32 字节 Ed25519 seed 的 base64 字符串（即本机 `%USERPROFILE%\.cosyee-tailnet-signing.key` 文件中的内容；请勿提交私钥文件到仓库）。
   - 对应公钥已写死在客户端与 `scripts/sign.mjs` 中，签名时会自动校验公私钥匹配。

2. **自动发布流程**（`.github/workflows/tailnet.yml`）：
   - 修改 `tailnet/VERSION` 并推送到 `main`（或手动触发 workflow）。
   - 若 tag `tailnet-v<VERSION>` 尚不存在，CI 会构建三端产物并创建不可变 release `tailnet-v<VERSION>`，然后生成 `manifest.json`、用 `TAILNET_SIGNING_KEY` 签名生成 `manifest.json.sig`，并覆盖上传到 prerelease `tailnet-latest`。
   - 若 tag `tailnet-v<VERSION>` 已存在，CI 只做构建和测试，跳过发布。

3. **手动生成与验签示例**：

```bash
node tailnet/scripts/manifest.mjs --assets-dir tailnet/dist --out tailnet/dist/manifest.json
TAILNET_SIGNING_KEY="<base64-seed>" node tailnet/scripts/sign.mjs tailnet/dist/manifest.json
node tailnet/scripts/sign.mjs --verify tailnet/dist/manifest.json
```
