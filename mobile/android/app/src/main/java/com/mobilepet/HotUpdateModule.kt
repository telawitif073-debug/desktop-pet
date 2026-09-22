package com.mobilepet

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Process
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

/**
 * JS Bundle 热更新（无需重装 APK）：
 * - JS 侧用 RNFS 下载 bundle zip 并解压到 filesDir/hotupdate/bundles/<version>/，
 *   然后调 setCurrent：原生在校验目录内存在 index.android.bundle 后原子写 current.json
 * - MainApplication 的自定义 ReactNativeHost 通过 HotUpdateStore 读 current.json，
 *   存在热更 bundle 则 getJSBundleFile 指向它，否则回退 APK 内置 bundle
 * - 崩溃自愈：HotUpdateStore 记录连续启动失败次数，连崩两次自动清除热更回滚内置
 */
class HotUpdateModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "PetHotUpdate"

    @ReactMethod
    fun getApplied(promise: Promise) {
        val applied = HotUpdateStore.applied(reactContext)
        if (applied == null) {
            promise.resolve(null)
        } else {
            val map = Arguments.createMap()
            map.putDouble("version", applied.first.toDouble())
            map.putString("file", applied.second.absolutePath)
            promise.resolve(map)
        }
    }

    /** 校验解压目录内有 bundle 文件后，把 version + 目录登记为当前热更（原子写） */
    @ReactMethod
    fun setCurrent(version: Double, dir: String, promise: Promise) {
        try {
            val bundle = HotUpdateStore.validateBundleDir(File(dir))
                ?: run {
                    promise.reject("ERR_NO_BUNDLE", "解压目录中没有找到 index.android.bundle")
                    return
                }
            HotUpdateStore.setCurrent(reactContext, version.toInt(), bundle)
            promise.resolve(bundle.absolutePath)
        } catch (t: Throwable) {
            promise.reject("ERR_SET", t.message)
        }
    }

    /** 清除热更记录（保留已下载的 bundle 目录，回滚到 APK 内置 bundle） */
    @ReactMethod
    fun reset(promise: Promise) {
        try {
            HotUpdateStore.clearCurrent(reactContext)
            promise.resolve(true)
        } catch (t: Throwable) {
            promise.reject("ERR_RESET", t.message)
        }
    }

    /** 重启应用使热更 bundle 生效（200ms 后由 AlarmManager 重新拉起，随后杀进程） */
    @ReactMethod
    fun restartApp(promise: Promise) {
        try {
            val ctx = reactContext.applicationContext
            val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
            if (launch == null) {
                promise.reject("ERR_RESTART", "无法获取应用启动入口")
                return
            }
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
            val pi = PendingIntent.getActivity(
                ctx, 1001, launch,
                PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0),
            )
            val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            // 注意：setExact 在 Android 12+（targetSdk 31+）需要 SCHEDULE_EXACT_ALARM 权限，
            // 未声明时会抛 SecurityException。重启只需约 200ms 的近似延迟，
            // 用 inexact set() 无需权限，前台应用场景下准时送达（CodePush 同款做法）。
            am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, android.os.SystemClock.elapsedRealtime() + 200, pi)
            promise.resolve(true)
            // 给 promise 事件队列一点时间送达 JS，再杀进程
            Thread {
                try { Thread.sleep(300) } catch (_: Throwable) {}
                Process.killProcess(Process.myPid())
            }.start()
        } catch (t: Throwable) {
            promise.reject("ERR_RESTART", t.message)
        }
    }
}

/** 热更 bundle 落盘与崩溃自愈记录（全部在 filesDir/hotupdate/ 下） */
object HotUpdateStore {

    private fun root(ctx: Context): File = File(ctx.filesDir, "hotupdate")

    fun currentFile(ctx: Context): File = File(root(ctx), "current.json")

    /** 读取当前生效的热更：Pair(version, bundleFile)；无或文件缺失返回 null */
    fun applied(ctx: Context): Pair<Int, File>? {
        val f = currentFile(ctx)
        if (!f.exists()) return null
        return try {
            val raw = f.readText().trim()
            // 简单解析 {"version":N,"file":"..."}，避免引入 JSON 依赖
            val ver = Regex("\"version\"\\s*:\\s*(\\d+)").find(raw)?.groupValues?.get(1)?.toIntOrNull() ?: return null
            val file = Regex("\"file\"\\s*:\\s*\"([^\"]+)\"").find(raw)?.groupValues?.get(1) ?: return null
            val bf = File(file)
            if (ver > 0 && bf.isFile && bf.length() > 0L) ver to bf else null
        } catch (_: Throwable) {
            null
        }
    }

    /** 找到 dir 下的 index.android.bundle（含子目录一层），找不到返回 null */
    fun validateBundleDir(dir: File): File? {
        val direct = File(dir, "index.android.bundle")
        if (direct.isFile) return direct
        val found = dir.walkTopDown().firstOrNull { it.isFile && it.name == "index.android.bundle" }
        return found
    }

    /** 原子写 current.json（tmp + rename） */
    fun setCurrent(ctx: Context, version: Int, bundleFile: File) {
        root(ctx).mkdirs()
        val tmp = File(root(ctx), "current.json.tmp")
        tmp.writeText("""{"version":$version,"file":"${bundleFile.absolutePath.replace("\\", "\\\\")}"}""")
        if (!tmp.renameTo(currentFile(ctx))) {
            currentFile(ctx).delete()
            if (!tmp.renameTo(currentFile(ctx))) throw IllegalStateException("无法写入 current.json")
        }
        // 生效即清零崩溃计数（上次启动成功活到了用户主动更新这一步）
        setCrashStreak(ctx, 0)
    }

    fun clearCurrent(ctx: Context) {
        currentFile(ctx).delete()
    }

    // ---- 崩溃自愈 ----

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("hotupdate", Context.MODE_PRIVATE)

    fun crashStreak(ctx: Context): Int = prefs(ctx).getInt("crash_streak", 0)

    fun setCrashStreak(ctx: Context, value: Int) {
        prefs(ctx).edit().putInt("crash_streak", value).apply()
    }

    /**
     * 启动自检：热更 bundle 生效时崩溃计数 +1；
     * 连续 >= 2 次启动即崩溃 → 回滚内置 bundle 并清计数。
     * 由 MainApplication.onCreate 调用；启动成功 8s 后由 markLaunchOk 清零。
     */
    fun onLaunch(ctx: Context) {
        if (applied(ctx) == null) return
        val streak = crashStreak(ctx) + 1
        if (streak >= 2) {
            clearCurrent(ctx)
            setCrashStreak(ctx, 0)
            android.util.Log.w("HotUpdate", "热更 bundle 连续启动崩溃，已回滚内置 bundle")
        } else {
            setCrashStreak(ctx, streak)
        }
    }

    /** 启动成功标记：8s 未崩即认为热更 bundle 可用，清零计数 */
    fun markLaunchOk(ctx: Context) {
        if (applied(ctx) == null) return
        setCrashStreak(ctx, 0)
    }
}
