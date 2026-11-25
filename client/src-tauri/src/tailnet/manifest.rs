// manifest 拉取、Ed25519 签名校验、组件下载（sha256 + size 校验）、原子安装与旧版本清理。
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// 滚动 release 的 manifest 地址与签名地址
pub const MANIFEST_URL: &str =
    "https://github.com/cosyeezz/cosyee/releases/download/tailnet-latest/manifest.json";
pub const MANIFEST_SIG_URL: &str =
    "https://github.com/cosyeezz/cosyee/releases/download/tailnet-latest/manifest.json.sig";

/// 写死在客户端的 Ed25519 原始公钥（32 字节 base64），见 CONTRACT.md
pub const PUBLIC_KEY_B64: &str = "cRew2agsYGnnrphfIwIjmlvFFToCaaidYmpvylSKB64=";

const USER_AGENT: &str = "cosyee-client";

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub tailscale: String,
    #[serde(default)]
    pub released: String,
    pub assets: HashMap<String, ManifestAsset>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ManifestAsset {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

fn build_agent(timeout_secs: u64) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(timeout_secs)))
        .user_agent(USER_AGENT)
        .build()
        .into()
}

/// 校验 manifest.json 原始字节的 Ed25519 签名（base64 一行）。
pub fn verify_manifest_signature(
    manifest_bytes: &[u8],
    sig_b64: &str,
    pubkey_b64: &str,
) -> Result<(), String> {
    let pub_raw = base64::engine::general_purpose::STANDARD
        .decode(pubkey_b64.trim())
        .map_err(|e| format!("内置公钥格式无效：{e}"))?;
    let pub_arr: [u8; 32] = pub_raw
        .try_into()
        .map_err(|_| "内置公钥长度不是 32 字节".to_string())?;
    let vk = VerifyingKey::from_bytes(&pub_arr).map_err(|e| format!("内置公钥无效：{e}"))?;

    let sig_raw = base64::engine::general_purpose::STANDARD
        .decode(sig_b64.trim())
        .map_err(|e| format!("签名文件格式无效：{e}"))?;
    let sig_arr: [u8; 64] = sig_raw
        .try_into()
        .map_err(|_| "签名长度不是 64 字节".to_string())?;
    let sig = Signature::from_bytes(&sig_arr);

    vk.verify(manifest_bytes, &sig)
        .map_err(|_| "manifest 签名校验失败，已拒绝安装".to_string())
}

/// 从 GitHub Releases 拉取 manifest.json 和 manifest.json.sig，验签通过后解析返回。
pub fn fetch_verified_manifest() -> Result<Manifest, String> {
    let agent = build_agent(30);

    let manifest_bytes = agent
        .get(MANIFEST_URL)
        .call()
        .map_err(|e| format!("获取版本信息失败：{e}"))?
        .body_mut()
        .with_config()
        .limit(1024 * 1024)
        .read_to_vec()
        .map_err(|e| format!("读取 manifest 失败：{e}"))?;

    let sig_text = agent
        .get(MANIFEST_SIG_URL)
        .call()
        .map_err(|e| format!("获取签名文件失败：{e}"))?
        .body_mut()
        .with_config()
        .limit(4096)
        .read_to_string()
        .map_err(|e| format!("读取签名文件失败：{e}"))?;

    verify_manifest_signature(&manifest_bytes, &sig_text, PUBLIC_KEY_B64)?;

    serde_json::from_slice::<Manifest>(&manifest_bytes)
        .map_err(|e| format!("解析 manifest.json 失败：{e}"))
}

/// 根据平台键和版本号生成落盘文件名（按版本命名，便于原子替换与清理旧版本）。
pub fn asset_filename(platform_key: &str, version: &str) -> Result<String, String> {
    // 防止路径穿越
    if version.is_empty()
        || !version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))
    {
        return Err("manifest 中的版本号包含非法字符".into());
    }
    let name = match platform_key {
        "windows-x64" => format!("cosyee-tailnet_{version}_windows_x64.exe"),
        "macos-universal" => format!("cosyee-tailnet_{version}_macos_universal"),
        "android-arm64" => format!("libcosyee_tailnet_{version}_android_arm64.so"),
        _ => return Err(format!("不支持的平台：{platform_key}")),
    };
    Ok(name)
}

/// 简单的字节转小写十六进制。
pub fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// 下载资产到临时文件 → 校验 size 和 sha256 → 设置权限 → 原子改名到目标路径。
pub fn download_and_install_asset(
    install_dir: &Path,
    platform_key: &str,
    version: &str,
    asset: &ManifestAsset,
    mut log_fn: impl FnMut(String),
) -> Result<String, String> {
    if !asset.url.starts_with("https://") {
        return Err("下载地址不是 https，已拒绝".into());
    }
    if asset.size == 0 || asset.size > 256 * 1024 * 1024 {
        return Err(format!("组件体积异常（{} 字节），已拒绝", asset.size));
    }

    fs::create_dir_all(install_dir)
        .map_err(|e| format!("无法创建安装目录 {}：{e}", install_dir.display()))?;

    let target_name = asset_filename(platform_key, version)?;
    let target_path = install_dir.join(&target_name);
    let tmp_path = install_dir.join(format!(".{target_name}.part"));

    // 清理残留临时文件
    let _ = fs::remove_file(&tmp_path);

    log_fn(format!("开始下载 cosyee-tailnet {version}（{:.1} MB）...", asset.size as f64 / (1024.0 * 1024.0)));

    let agent = build_agent(600);
    let mut resp = agent
        .get(&asset.url)
        .call()
        .map_err(|e| format!("下载组件失败：{e}"))?;

    let mut reader = resp.body_mut().as_reader();
    let mut file = File::create(&tmp_path)
        .map_err(|e| format!("无法创建临时文件 {}：{e}", tmp_path.display()))?;

    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut total: u64 = 0;
    let mut last_pct: u64 = 0;

    let download_res: Result<(), String> = (|| {
        loop {
            let n = reader
                .read(&mut buf)
                .map_err(|e| format!("下载读取中断：{e}"))?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > asset.size {
                return Err("下载文件大小超出 manifest 声明，已中止".into());
            }
            file.write_all(&buf[..n])
                .map_err(|e| format!("写入临时文件失败：{e}"))?;
            hasher.update(&buf[..n]);

            let pct = total * 100 / asset.size;
            if (pct >= last_pct + 20 || pct == 100) && pct != last_pct {
                last_pct = pct;
                log_fn(format!("下载进度：{pct}%"));
            }
        }
        file.sync_all().map_err(|e| format!("落盘同步失败：{e}"))?;
        Ok(())
    })();

    drop(file);
    if let Err(e) = download_res {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }

    if total != asset.size {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!(
            "文件大小不匹配：期望 {} 字节，实际 {} 字节",
            asset.size, total
        ));
    }

    let actual_sha = hex_lower(&hasher.finalize());
    let expected_sha = asset.sha256.trim().to_ascii_lowercase();
    if actual_sha != expected_sha {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!(
            "SHA-256 校验失败：期望 {expected_sha}，实际 {actual_sha}"
        ));
    }
    log_fn("SHA-256 校验通过".into());

    // 设置目标权限（macOS/Unix 可执行；Android 14 动态加载要求只读）
    set_installed_permissions(&tmp_path)?;

    // 若目标已存在且只读（如重装同版本），先尝试恢复可写再替换
    if target_path.exists() {
        make_writable_if_needed(&target_path);
        let _ = fs::remove_file(&target_path);
    }

    fs::rename(&tmp_path, &target_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("原子安装失败：{e}")
    })?;

    Ok(target_name)
}

#[cfg(unix)]
fn set_installed_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    #[cfg(target_os = "android")]
    let mode = 0o444;
    #[cfg(not(target_os = "android"))]
    let mode = 0o755;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|e| format!("设置文件权限失败：{e}"))
}

#[cfg(not(unix))]
fn set_installed_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
pub fn make_writable_if_needed(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o644));
}

#[cfg(not(unix))]
pub fn make_writable_if_needed(_path: &Path) {}

/// 删除安装目录里的旧版本二进制文件（保留 keep_files 中指定的文件）。
pub fn cleanup_old_versions(install_dir: &Path, keep_files: &[&str]) {
    let Ok(entries) = fs::read_dir(install_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path: PathBuf = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        let is_component_bin = name.starts_with("cosyee-tailnet_")
            || name.starts_with("libcosyee_tailnet_")
            || name.ends_with(".part");
        if !is_component_bin {
            continue;
        }
        if keep_files.contains(&name) {
            continue;
        }
        make_writable_if_needed(&path);
        let _ = fs::remove_file(&path);
    }
}

/// 比较 semver 版本字符串：返回 `latest` 是否比 `current` 更新（无法解析时按字符串不等判定）。
pub fn is_newer_version(latest: &str, current: &str) -> bool {
    let parse = |s: &str| -> Option<(u64, u64, u64, String)> {
        let s = s.trim().strip_prefix('v').unwrap_or(s.trim());
        let (core, pre) = match s.split_once('-') {
            Some((c, p)) => (c, p.to_string()),
            None => (s, String::new()),
        };
        let mut parts = core.split('.');
        let maj = parts.next()?.parse().ok()?;
        let min = parts.next()?.parse().ok()?;
        let pat = parts.next()?.parse().ok()?;
        if parts.next().is_some() {
            return None;
        }
        Some((maj, min, pat, pre))
    };
    match (parse(latest), parse(current)) {
        (Some((l1, l2, l3, lp)), Some((c1, c2, c3, cp))) => {
            if (l1, l2, l3) != (c1, c2, c3) {
                return (l1, l2, l3) > (c1, c2, c3);
            }
            // 同主次修订号：正式版（无 prerelease）高于预发布版
            match (lp.is_empty(), cp.is_empty()) {
                (true, false) => true,
                (false, true) => false,
                _ => lp > cp,
            }
        }
        _ => latest.trim() != current.trim(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn verify_signature_valid_and_tampered() {
        let seed = [42u8; 32];
        let sk = SigningKey::from_bytes(&seed);
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(sk.verifying_key().as_bytes());
        let body = br#"{"version":"1.0.0","assets":{}}"#;
        let sig = sk.sign(body);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

        assert!(verify_manifest_signature(body, &format!("{sig_b64}\n"), &pk_b64).is_ok());

        // 篡改一个字节必须失败
        let tampered = br#"{"version":"1.0.1","assets":{}}"#;
        assert!(verify_manifest_signature(tampered, &sig_b64, &pk_b64).is_err());

        // 签名格式错误必须失败
        assert!(verify_manifest_signature(body, "not-base64!!!", &pk_b64).is_err());
    }

    #[test]
    fn hardcoded_public_key_is_valid_ed25519() {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(PUBLIC_KEY_B64)
            .expect("公钥 base64 应可解码");
        let arr: [u8; 32] = raw.try_into().expect("公钥应为 32 字节");
        VerifyingKey::from_bytes(&arr).expect("公钥应为合法的 Ed25519 点");
    }

    #[test]
    fn version_comparison_rules() {
        assert!(is_newer_version("1.0.1", "1.0.0"));
        assert!(is_newer_version("1.1.0", "1.0.9"));
        assert!(is_newer_version("2.0.0", "1.9.9"));
        assert!(!is_newer_version("1.0.0", "1.0.0"));
        assert!(!is_newer_version("1.0.0", "1.0.1"));
        assert!(is_newer_version("1.0.0", "1.0.0-rc.1"));
    }

    #[test]
    fn asset_filename_rejects_traversal() {
        assert_eq!(
            asset_filename("windows-x64", "1.2.3").unwrap(),
            "cosyee-tailnet_1.2.3_windows_x64.exe"
        );
        assert_eq!(
            asset_filename("macos-universal", "1.2.3").unwrap(),
            "cosyee-tailnet_1.2.3_macos_universal"
        );
        assert_eq!(
            asset_filename("android-arm64", "1.2.3").unwrap(),
            "libcosyee_tailnet_1.2.3_android_arm64.so"
        );
        assert!(asset_filename("windows-x64", "../evil").is_err());
        assert!(asset_filename("linux-x64", "1.0.0").is_err());
    }
}
