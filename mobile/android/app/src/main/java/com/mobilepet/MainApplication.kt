package com.mobilepet

import android.app.Application
import android.os.Handler
import android.os.Looper
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactNativeHost
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost

class MainApplication : Application(), ReactApplication {

  /**
   * 热更新 ReactNativeHost：filesDir/hotupdate/current.json 登记的热更 bundle 存在时优先加载，
   * 不存在（或已被崩溃自愈清除）返回 null 回退 APK 内置 bundle。
   */
  private val hotUpdateHost: ReactNativeHost by lazy {
    object : DefaultReactNativeHost(this@MainApplication) {
      override fun getJSBundleFile(): String? =
          HotUpdateStore.applied(applicationContext)?.second?.absolutePath

      override fun getJSMainModuleName(): String = "index"

      override fun getBundleAssetName(): String = "index.android.bundle"

      override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

      override val isHermesEnabled: Boolean = true

      override fun getPackages() =
          PackageList(this@MainApplication).packages.apply {
            // 悬浮窗宠物原生模块（手动注册，未被 autolink 覆盖）
            add(OverlayPetPackage())
            // 语音模块（系统 TTS + 语音识别）
            add(PetVoicePackage())
            // 应用内更新（下载进度 + 拉起安装）
            add(PetUpdatePackage())
            // JS Bundle 热更新
            add(HotUpdatePackage())
          }
    }
  }

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(applicationContext, hotUpdateHost)
  }

  override fun onCreate() {
    super.onCreate()
    // 崩溃自愈：本次用热更 bundle 启动即计数，连崩两次自动回滚内置 bundle；
    // 启动 8 秒后仍存活则视为启动成功、清零计数
    HotUpdateStore.onLaunch(this)
    Handler(Looper.getMainLooper()).postDelayed({ HotUpdateStore.markLaunchOk(this) }, 8000)
    loadReactNative(this)
  }
}
