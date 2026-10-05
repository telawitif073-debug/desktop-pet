package com.mobilepet

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * 悬浮窗宠物原生模块：
 * - checkPermission：返回 Settings.canDrawOverlays(this) 状态
 * - requestPermission：跳转到系统「显示在其他应用上层」授权页
 * - startOverlay：拉起 OverlayPetService 前台服务，传入渲染页 URL
 * - stopOverlay：停止服务并移除悬浮窗
 *
 * 调用方在 RN 侧自行根据 canDrawOverlays 结果引导用户授权。
 */
class OverlayPetModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "OverlayPet"

    @ReactMethod
    fun checkPermission(promise: Promise) {
        try {
            val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Settings.canDrawOverlays(reactContext)
            } else {
                true // Android 6 以下默认允许
            }
            promise.resolve(granted)
        } catch (t: Throwable) {
            promise.reject("ERR_PERMISSION_CHECK", t.message)
        }
    }

    @ReactMethod
    fun requestPermission(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val intent = Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:${reactContext.packageName}")
                ).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                reactContext.startActivity(intent)
                promise.resolve(true)
            } else {
                promise.resolve(true)
            }
        } catch (t: Throwable) {
            promise.reject("ERR_PERMISSION_REQUEST", t.message)
        }
    }

    @ReactMethod
    fun startOverlay(htmlUrl: String?, promise: Promise) {
        try {
            val ctx = reactContext
            val serviceIntent = Intent(ctx, OverlayPetService::class.java).apply {
                putExtra(OverlayPetService.EXTRA_HTML_URL, htmlUrl)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(serviceIntent)
            } else {
                ctx.startService(serviceIntent)
            }
            promise.resolve(true)
        } catch (t: Throwable) {
            promise.reject("ERR_START_OVERLAY", t.message)
        }
    }

    @ReactMethod
    fun stopOverlay(promise: Promise) {
        try {
            val serviceIntent = Intent(reactContext, OverlayPetService::class.java)
            reactContext.stopService(serviceIntent)
            promise.resolve(true)
        } catch (t: Throwable) {
            promise.reject("ERR_STOP_OVERLAY", t.message)
        }
    }
}
