# 保留 Rust 经 JNI 调用的 MainActivity 方法，防止 R8 裁剪导致 NoSuchMethodError 闪退
-keep class app.cosyee.client.MainActivity {
  public boolean setTailnetProxy(java.lang.String);
  public void clearTailnetProxy();
  public void relaunchApp();
}
