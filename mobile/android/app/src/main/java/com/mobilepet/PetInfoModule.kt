package com.mobilepet

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule

/**
 * 系统安装的版本号（versionCode / versionName）。
 * 直接读 BuildConfig 编译期常量，避免 PackageInfo.versionCode 在 API<28/28+ 之间
 * int→long 字段描述符不一致导致 NoSuchFieldError；并全部 try-catch 兜底——
 * 原生模块初始化阶段若抛异常会令 React 桥初始化失败、应用启动即崩。
 */
class PetInfoModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "PetInfo"

    override fun getConstants(): Map<String, Any> = try {
        mapOf(
            "versionCode" to BuildConfig.VERSION_CODE.toDouble(),
            "versionName" to (BuildConfig.VERSION_NAME ?: ""),
        )
    } catch (t: Throwable) {
        mapOf(
            "versionCode" to 0.0,
            "versionName" to "",
        )
    }
}