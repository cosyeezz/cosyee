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
//
// 暴露给页面（包括服务端网页）的 CosyeeNative 只有读避让值和改状态栏图标颜色两个方法。
package app.cosyee.client

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.util.Locale

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  /** 上、右、下、左的避让（CSS 像素）；JS 接口在别的线程上读 */
  @Volatile private var insets = "0,0,0,0"

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
  }
}
