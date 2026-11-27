// Android 入口 Activity。CI 在 `tauri android init` 之后用这个文件覆盖生成的 MainActivity.kt
// （见 .github/workflows/release.yml），包名要和 tauri.conf.json 的 identifier 一致。
//
// 1. 系统栏避让：模板默认 edge-to-edge（内容画到状态栏 / 手势条下面），WebView 本身拿不到可靠的
//    env(safe-area-inset-*)。这里把系统栏、刘海、输入法占的区域（CSS 像素）交给页面，
//    由外壳脚本 titlebar.js 写成 html 的 padding —— 状态栏后面露出的是页面自己的底色，跟随深浅主题。
//    输入法弹出时底部避让变高，页面整体缩短，输入框不会被键盘盖住。
// 2. 返回手势 / 返回键：先交给页面（关掉打开的侧栏等），页面不处理就回到服务器列表；
//    已经在服务器列表页时走系统默认（退到后台）。
// 3. 状态栏图标深浅跟随页面主题（titlebar.js 调 CosyeeNative.setDark）。
// 4. 语音通话期间保持亮屏（网页调 CosyeeNative.keepScreenOn）。麦克风授权由 wry 的 WebChromeClient 处理。
// 5. 网页里的下载（文件预览的「下载到本设备」等）：wry 没给 WebView 设 DownloadListener，系统会直接忽略。
//    这里自己下载：带上 WebView 的 cookie（服务端令牌），开着内置 Tailscale 时经同一个本地代理，
//    所以不用系统 DownloadManager（它在别的进程里，访问不到只对本应用生效的 tailnet）。
//    Android 10+ 存进公共「下载」目录（MediaStore，不需要存储权限）；更老的系统存在应用自己的下载目录。
//    进度用外壳脚本的 window.__cosyeeToast 显示在页面上，完成后弹框可直接打开（APK 会拉起安装）。
//
// 暴露给页面（包括服务端网页）的 CosyeeNative 只有读避让值、改状态栏图标颜色、保持亮屏三个方法。
package app.cosyee.client

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Log
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.URLUtil
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL
import java.net.URLDecoder
import java.util.Locale

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  /** 上、右、下、左的避让（CSS 像素）；JS 接口在别的线程上读 */
  @Volatile private var insets = "0,0,0,0"

  /** 内置 Tailscale 的本地代理（http://127.0.0.1:端口），没开时为 null；下载也要经它才能访问 tailnet */
  @Volatile private var proxyUrl: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val wv = webView ?: return systemBack()
        wv.evaluateJavascript(
          "(function(){try{return !!(window.__cosyeeBack&&window.__cosyeeBack())}catch(e){return false}})()"
        ) { handled -> if (handled != "true") systemBack() }
      }

      private fun systemBack() {
        isEnabled = false
        onBackPressedDispatcher.onBackPressed()
        isEnabled = true
      }
    })
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
    webView.addJavascriptInterface(Bridge(), "CosyeeNative")
    webView.setDownloadListener { url, userAgent, disposition, mimeType, _ ->
      download(url, userAgent, disposition, mimeType)
    }
    // 在 WebView 上接管避让：值交给页面处理，并且不再往 WebView 里传（避免它自己再缩一次视口）
    ViewCompat.setOnApplyWindowInsetsListener(webView) { v, wi ->
      val d = v.resources.displayMetrics.density
      val bars = wi.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = wi.getInsets(WindowInsetsCompat.Type.ime())
      val value = String.format(
        Locale.US, "%.2f,%.2f,%.2f,%.2f",
        bars.top / d, bars.right / d, maxOf(bars.bottom, ime.bottom) / d, bars.left / d
      )
      if (value != insets) {
        insets = value
        (v as WebView).evaluateJavascript("window.__cosyeeInsets&&window.__cosyeeInsets($value)", null)
      }
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(webView)
  }

  /** 供 Rust 经 JNI 调用：把 WebView 流量指向本地 HTTP 代理（本地页面与 127.0.0.1 跳过代理）。 */
  fun setTailnetProxy(proxyUrl: String): Boolean {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
      return false
    }
    val config = ProxyConfig.Builder()
      .addProxyRule(proxyUrl)
      .addBypassRule("tauri.localhost")
      .addBypassRule("127.0.0.1")
      .addBypassRule("localhost")
      .build()
    this.proxyUrl = proxyUrl
    onMainThread("setProxyOverride") {
      ProxyController.getInstance().setProxyOverride(
        config,
        ContextCompat.getMainExecutor(this)
      ) {}
    }
    return true
  }

  /**
   * 已在主线程（Rust 经 wry 的 JNI 回调就在主线程）时直接执行，异常同步抛回 JNI 调用方，
   * 由 Rust 记录真正原因；不在主线程时投递过去，并兜住异常，避免未捕获异常让应用闪退。
   */
  private fun onMainThread(what: String, block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      block()
    } else {
      runOnUiThread {
        try {
          block()
        } catch (e: Exception) {
          Log.e("Cosyee", "$what failed", e)
        }
      }
    }
  }

  /** 供 Rust 经 JNI 调用：清除 WebView 代理覆写。 */
  fun clearTailnetProxy() {
    proxyUrl = null
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
      return
    }
    onMainThread("clearProxyOverride") {
      ProxyController.getInstance().clearProxyOverride(
        ContextCompat.getMainExecutor(this)
      ) {}
    }
  }

  /** 供 Rust 经 JNI 调用：重启当前 Android 应用进程（用于内置 Tailscale 代理或 .so 更新生效）。 */
  fun relaunchApp() {
    runOnUiThread {
      val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return@runOnUiThread
      val component = launch.component ?: return@runOnUiThread
      val restart = Intent.makeRestartActivityTask(component)
      startActivity(restart)
      Runtime.getRuntime().exit(0)
    }
  }

  // ───────────── 下载 ─────────────

  private class Saved(val name: String, val uri: Uri, val mime: String, val where: String)

  /** 在页面上显示一句提示（外壳脚本 titlebar.js 的 __cosyeeToast），任意线程可调 */
  private fun pageToast(msg: String) {
    runOnUiThread {
      webView?.evaluateJavascript("window.__cosyeeToast&&window.__cosyeeToast(${JSONObject.quote(msg)})", null)
    }
  }

  private fun download(url: String, userAgent: String?, disposition: String?, mimeType: String?) {
    val scheme = Uri.parse(url).scheme?.lowercase(Locale.ROOT)
    if (scheme != "http" && scheme != "https") {
      pageToast("暂不支持这种下载链接")
      return
    }
    val guess = safeName(dispositionName(disposition) ?: URLUtil.guessFileName(url, disposition, mimeType))
    pageToast("正在下载：$guess")
    Thread {
      try {
        val saved = fetchToDownloads(url, userAgent, guess)
        runOnUiThread { showDownloaded(saved) }
      } catch (e: Exception) {
        Log.e("Cosyee", "download failed: $url", e)
        pageToast("下载失败：$guess（${e.message ?: e.javaClass.simpleName}）")
      }
    }.start()
  }

  private fun fetchToDownloads(url: String, userAgent: String?, fallbackName: String): Saved {
    val target = URL(url)
    val proxy = proxyFor(target)
    val conn = (if (proxy != null) target.openConnection(proxy) else target.openConnection()) as HttpURLConnection
    try {
      conn.connectTimeout = 15_000
      conn.readTimeout = 60_000
      // 服务端令牌在 HttpOnly cookie 里，CookieManager 能读到
      CookieManager.getInstance().getCookie(url)?.let { conn.setRequestProperty("Cookie", it) }
      if (!userAgent.isNullOrBlank()) conn.setRequestProperty("User-Agent", userAgent)
      val code = conn.responseCode
      if (code !in 200..299) throw IOException("HTTP $code")
      val name = safeName(dispositionName(conn.getHeaderField("Content-Disposition")) ?: fallbackName)
      // 服务端统一回 application/octet-stream，按扩展名定类型，打开 APK 才会走安装器
      val ext = name.substringAfterLast('.', "").lowercase(Locale.ROOT)
      val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
        ?: conn.contentType?.substringBefore(';')?.trim()?.takeIf { it.isNotEmpty() }
        ?: "application/octet-stream"
      val total = conn.contentLengthLong
      return conn.inputStream.use { input ->
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) saveToMediaStore(input, name, mime, total)
        else saveToAppDir(input, name, mime, total)
      }
    } finally {
      conn.disconnect()
    }
  }

  /** 和 WebView 走同一个代理：开着内置 Tailscale 时经本地代理（它按地址分流），本机地址直连 */
  private fun proxyFor(target: URL): Proxy? {
    val p = proxyUrl ?: return null
    val host = target.host.lowercase(Locale.ROOT).trim('[', ']')
    if (host == "localhost" || host == "127.0.0.1" || host == "::1") return null
    val u = Uri.parse(p)
    val h = u.host ?: return null
    if (u.port <= 0) return null
    return Proxy(Proxy.Type.HTTP, InetSocketAddress(h, u.port))
  }

  @RequiresApi(Build.VERSION_CODES.Q)
  private fun saveToMediaStore(input: InputStream, name: String, mime: String, total: Long): Saved {
    val resolver = contentResolver
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, name)
      put(MediaStore.MediaColumns.MIME_TYPE, mime)
      put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
      ?: throw IOException("无法在「下载」里创建文件")
    try {
      val out = resolver.openOutputStream(uri) ?: throw IOException("无法写入文件")
      out.use { copyWithProgress(input, it, name, total) }
      resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
    } catch (e: Exception) {
      resolver.delete(uri, null, null)
      throw e
    }
    // 重名时系统会自动改名（「名字 (1).ext」），以实际名字为准
    val actual = resolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use { c ->
      if (c.moveToFirst()) c.getString(0) else null
    } ?: name
    return Saved(actual, uri, mime, "「下载」")
  }

  /** Android 9 及以下：不申请存储权限，存在应用自己的下载目录，经 FileProvider（模板自带）交给别的应用打开 */
  private fun saveToAppDir(input: InputStream, name: String, mime: String, total: Long): Saved {
    val dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: File(cacheDir, "downloads")
    dir.mkdirs()
    val dot = name.lastIndexOf('.')
    val base = if (dot > 0) name.substring(0, dot) else name
    val ext = if (dot > 0) name.substring(dot) else ""
    var file = File(dir, name)
    var i = 1
    while (file.exists()) {
      file = File(dir, "$base ($i)$ext")
      i++
    }
    try {
      FileOutputStream(file).use { copyWithProgress(input, it, name, total) }
    } catch (e: Exception) {
      file.delete()
      throw e
    }
    val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
    return Saved(file.name, uri, mime, "应用的下载目录")
  }

  private fun copyWithProgress(input: InputStream, out: OutputStream, name: String, total: Long) {
    val buf = ByteArray(64 * 1024)
    var done = 0L
    var last = SystemClock.elapsedRealtime()
    while (true) {
      val n = input.read(buf)
      if (n < 0) break
      out.write(buf, 0, n)
      done += n
      val now = SystemClock.elapsedRealtime()
      if (now - last >= 1000) {
        last = now
        pageToast(
          if (total > 0) "正在下载：$name（${done * 100 / total}%）"
          else "正在下载：$name（${done / (1024 * 1024)} MB）"
        )
      }
    }
    if (total > 0 && done != total) throw IOException("连接中断（$done / $total 字节）")
  }

  private fun showDownloaded(s: Saved) {
    if (isFinishing || isDestroyed) return
    MaterialAlertDialogBuilder(this)
      .setTitle("下载完成")
      .setMessage("已保存到${s.where}：${s.name}")
      .setPositiveButton("打开") { _, _ -> openSaved(s) }
      .setNegativeButton("关闭", null)
      .show()
  }

  private fun openSaved(s: Saved) {
    val intent = Intent(Intent.ACTION_VIEW)
      .setDataAndType(s.uri, s.mime)
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    try {
      startActivity(intent)
    } catch (e: ActivityNotFoundException) {
      pageToast("没有能打开这个文件的应用")
    }
  }

  /** 取 Content-Disposition 里的文件名：优先 RFC 5987 的 filename*=UTF-8''…，其次 filename="…" */
  private fun dispositionName(cd: String?): String? {
    if (cd.isNullOrBlank()) return null
    Regex("filename\\*\\s*=\\s*([^']*)'[^']*'([^;]+)", RegexOption.IGNORE_CASE).find(cd)?.let { m ->
      val charset = m.groupValues[1].ifBlank { "UTF-8" }
      val decoded = runCatching { URLDecoder.decode(m.groupValues[2].trim().replace("+", "%2B"), charset) }.getOrNull()
      if (!decoded.isNullOrBlank()) return decoded
    }
    Regex("filename\\s*=\\s*(?:\"([^\"]*)\"|([^;]+))", RegexOption.IGNORE_CASE).find(cd)?.let { m ->
      val v = m.groupValues[1].ifEmpty { m.groupValues[2] }.trim()
      if (v.isNotEmpty()) return v
    }
    return null
  }

  /** 去掉路径分隔符和控制字符，防止写到别的目录 */
  private fun safeName(raw: String): String {
    val n = raw.replace(Regex("[\\\\/\\u0000-\\u001f\\u007f]"), "_").trim().trimStart('.')
    return n.take(200).ifEmpty { "download" }
  }

  inner class Bridge {
    @JavascriptInterface
    fun insets(): String = this@MainActivity.insets

    @JavascriptInterface
    fun setDark(dark: Boolean) {
      runOnUiThread {
        val c = WindowCompat.getInsetsController(window, window.decorView)
        c.isAppearanceLightStatusBars = !dark
        c.isAppearanceLightNavigationBars = !dark
      }
    }

    /** 通话 / 语音录音期间保持亮屏（WebView 不支持 Screen Wake Lock API） */
    @JavascriptInterface
    fun keepScreenOn(on: Boolean) {
      runOnUiThread {
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      }
    }
  }
}
