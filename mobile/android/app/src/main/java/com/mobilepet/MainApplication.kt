package com.mobilepet

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // 悬浮窗宠物原生模块（手动注册，未被 autolink 覆盖）
          add(OverlayPetPackage())
          // 语音模块（系统 TTS + 语音识别）
          add(PetVoicePackage())
          // 应用内更新（下载进度 + 拉起安装）
          add(PetUpdatePackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
