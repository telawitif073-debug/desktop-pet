package com.mobilepet

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 应用内更新（游戏式）：原生流式下载 APK，进度经事件 PetUpdateProgress { received, total }
 * 回传 JS 渲染进度条；完成后用 FileProvider + ACTION_VIEW 自动拉起系统安装器。
 *
 * Android 8+ 需要「允许安装未知应用」权限：未授予时先跳系统设置页并返回
 * "permission"，用户授权后再次点更新即正常下载安装（或调 installPending 安装已下载包）。
 */
class PetUpdateModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "PetUpdate"

    private var lastEmit = 0L

    private fun apkFile(): File {
        val dir = reactContext.getExternalFilesDir(null) ?: reactContext.filesDir
        return File(dir, "pet-update.apk")
    }

    @ReactMethod
    fun download(url: String, promise: Promise) {
        // 安装权限前置检查（Android 8+）：没有就先引导去系统设置，避免下载完装不上
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !reactContext.packageManager.canRequestPackageInstalls()
        ) {
            val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + reactContext.packageName))
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactContext.startActivity(intent)
            promise.resolve("permission")
            return
        }
        Thread {
            var input: java.io.InputStream? = null
            var output: java.io.FileOutputStream? = null
            try {
                val file = apkFile()
                if (file.exists()) file.delete()
                // 先写临时文件，校验通过后改名，避免半截包被拉起安装（系统报「解析失败」）
                val tmp = File(file.parentFile, file.name + ".part")
                if (tmp.exists()) tmp.delete()
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.connectTimeout = 20000
                conn.readTimeout = 60000
                conn.instanceFollowRedirects = true
                conn.connect()
                if (conn.responseCode !in 200..299) {
                    promise.reject("ERR_HTTP", "下载失败（HTTP ${conn.responseCode}）")
                    return@Thread
                }
                val total = conn.contentLengthLong
                val contentType = conn.contentType ?: ""
                input = conn.inputStream
                output = java.io.FileOutputStream(tmp)
                val buf = ByteArray(128 * 1024)
                var received = 0L
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    output.write(buf, 0, n)
                    received += n
                    val now = SystemClock.elapsedRealtime()
                    if (now - lastEmit > 300) {
                        lastEmit = now
                        emitProgress(received, total)
                    }
                }
                output.flush()
                output.close()
                output = null
                input.close()
                input = null
                // 完整性校验：长度一致 + APK 必须是 ZIP（PK 头），防止代理返回错误页或传输截断
                if (total > 0 && received != total) {
                    tmp.delete()
                    promise.reject("ERR_TRUNCATED", "下载不完整（${received}/${total} 字节），请重试")
                    return@Thread
                }
                val head = ByteArray(2)
                java.io.RandomAccessFile(tmp, "r").use { raf -> raf.readFully(head) }
                if (!(head[0] == 'P'.code.toByte() && head[1] == 'K'.code.toByte())) {
                    tmp.delete()
                    promise.reject("ERR_NOT_APK", "下载的内容不是有效的安装包（服务器返回异常），请稍后重试")
                    return@Thread
                }
                if (!tmp.renameTo(file)) {
                    tmp.delete()
                    promise.reject("ERR_RENAME", "安装包保存失败，请重试")
                    return@Thread
                }
                emitProgress(received, if (total > 0) total else received)
                launchInstaller(file)
                promise.resolve("installing")
            } catch (t: Throwable) {
                promise.reject("ERR_DOWNLOAD", t.message ?: "下载失败")
            } finally {
                try { input?.close() } catch (_: Throwable) {}
                try { output?.close() } catch (_: Throwable) {}
            }
        }.start()
    }

    /** 用户在系统设置授权后回来，安装已下载好的更新包 */
    @ReactMethod
    fun installPending(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                !reactContext.packageManager.canRequestPackageInstalls()
            ) {
                promise.resolve("permission")
                return
            }
            val file = apkFile()
            if (!file.exists() || file.length() == 0L) {
                promise.reject("ERR_NOFILE", "没有待安装的更新包，请重新下载")
                return
            }
            // 校验是有效 APK（PK 头）再拉起安装，坏包直接要求重下
            val head = ByteArray(2)
            java.io.RandomAccessFile(file, "r").use { raf -> raf.readFully(head) }
            if (!(head[0] == 'P'.code.toByte() && head[1] == 'K'.code.toByte())) {
                file.delete()
                promise.reject("ERR_NOT_APK", "本地更新包已损坏，请重新点「立即更新」下载")
                return
            }
            launchInstaller(file)
            promise.resolve("installing")
        } catch (t: Throwable) {
            promise.reject("ERR_INSTALL", t.message)
        }
    }

    private fun launchInstaller(file: File) {
        val context = reactContext
        val uri: Uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            FileProvider.getUriForFile(context, context.packageName + ".updatefileprovider", file)
        } else {
            Uri.fromFile(file)
        }
        val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    private fun emitProgress(received: Long, total: Long) {
        val map = Arguments.createMap()
        map.putDouble("received", received.toDouble())
        map.putDouble("total", total.toDouble())
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("PetUpdateProgress", map)
    }
}
