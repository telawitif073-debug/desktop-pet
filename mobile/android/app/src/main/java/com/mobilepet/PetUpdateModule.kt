package com.mobilepet

import android.app.DownloadManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
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

/**
 * 应用内更新下载（系统级后台）：
 * - 交给系统 DownloadManager 执行：切到别的应用、进程被杀都会继续下载，通知栏显示进度
 * - 本模块起轮询线程把进度经事件 PetUpdateProgress { received, total } 回传 JS 渲染进度条
 * - 下载成功自动校验（PK 头）并拉起系统安装器，事件 PetUpdateDone { ok, message } 通知 JS
 * - 任意时刻同一 URL 只允许一个下载任务：入队前检查本模块记录与系统队列中的活跃任务，重复请求返回 "busy"
 *
 * Android 8+ 需要「允许安装未知应用」权限：未授予时先跳系统设置页并返回 "permission"。
 */
class PetUpdateModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "PetUpdate"

    companion object {
        /** DownloadManager 任务标题前缀（带版本号，用于跨进程去重与旧版本清理） */
        const val TASK_TITLE_PREFIX = "宠物更新包"
    }

    private var lastEmit = 0L

    /** 本会话当前下载任务 id（0 表示无） */
    private var currentId: Long = 0L

    /** 期望的安装包 versionCode（>0 时安装前校验，防半截包/旧包） */
    private var expectedCode: Long = 0L

    private fun apkFile(): File {
        val dir = reactContext.getExternalFilesDir(null) ?: reactContext.filesDir
        return File(dir, "pet-update.apk")
    }

    private fun downloadManager(): DownloadManager =
        reactContext.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

    /** 查询系统队列中已有的本应用下载任务（带版本号的标题），返回 (id, title) 列表 */
    private fun listOwnTasks(): List<Pair<Long, String>> {
        val out = mutableListOf<Pair<Long, String>>()
        var cursor: Cursor? = null
        return try {
            cursor = downloadManager().query(DownloadManager.Query())
            while (cursor != null && cursor.moveToNext()) {
                val tIdx = cursor.getColumnIndex(DownloadManager.COLUMN_TITLE)
                if (tIdx < 0) continue
                val title = cursor.getString(tIdx) ?: continue
                if (!title.startsWith(TASK_TITLE_PREFIX)) continue
                val idIdx = cursor.getColumnIndex(DownloadManager.COLUMN_ID)
                if (idIdx >= 0) out.add(cursor.getLong(idIdx) to title)
            }
            out
        } catch (_: Throwable) {
            out
        } finally {
            try { cursor?.close() } catch (_: Throwable) {}
        }
    }

    /** 查询任务状态（查不到返回 -1） */
    private fun taskStatus(id: Long): Int {
        var cursor: Cursor? = null
        return try {
            cursor = downloadManager().query(DownloadManager.Query().setFilterById(id))
            if (cursor != null && cursor.moveToFirst()) {
                val sIdx = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS)
                if (sIdx >= 0) cursor.getInt(sIdx) else -1
            } else -1
        } catch (_: Throwable) {
            -1
        } finally {
            try { cursor?.close() } catch (_: Throwable) {}
        }
    }

    @ReactMethod
    fun download(url: String, version: String, expected: Double, promise: Promise) {
        expectedCode = expected.toLong()
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
        val title = "$TASK_TITLE_PREFIX v$version"
        // 1) 同版本任务仍在下载 → 复用其进度（busy）
        for ((id, t) in listOwnTasks()) {
            if (t == title) {
                val st = taskStatus(id)
                if (st == DownloadManager.STATUS_PENDING || st == DownloadManager.STATUS_RUNNING ||
                    st == DownloadManager.STATUS_PAUSED
                ) {
                    currentId = id
                    pollProgress(id)
                    promise.resolve("busy")
                    return
                }
            }
        }
        // 2) 其他版本的任务（进行中/已完成/已暂停）全部取消：删除任务、通知与文件，避免多版本并存
        for ((id, t) in listOwnTasks()) {
            if (t != title) {
                try { downloadManager().remove(id) } catch (_: Throwable) {}
            }
        }
        try {
            // DownloadManager 不允许覆盖已存在的目标文件，入队前清理旧包与残留 .part
            apkFile().delete()
            File(apkFile().parentFile, apkFile().name + ".part").delete()

            val request = DownloadManager.Request(Uri.parse(url)).apply {
                setTitle(title)
                setDescription("宠物桌面更新")
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setMimeType("application/vnd.android.package-archive")
                setAllowedOverMetered(true)
                setAllowedOverRoaming(true)
                setDestinationInExternalFilesDir(reactContext, null, "pet-update.apk")
            }
            currentId = downloadManager().enqueue(request)
            pollProgress(currentId)
            promise.resolve("started")
        } catch (t: Throwable) {
            currentId = 0L
            promise.reject("ERR_ENQUEUE", t.message ?: "无法开始下载")
        }
    }

    /** 轮询任务进度并回传 JS；结束时按结果校验安装或通知失败 */
    private fun pollProgress(id: Long) {
        Thread {
            var announced = false
            while (true) {
                var done = false
                var ok = false
                var received = 0L
                var total = 0L
                var cursor: Cursor? = null
                try {
                    cursor = downloadManager().query(DownloadManager.Query().setFilterById(id))
                    if (cursor == null || !cursor.moveToFirst()) {
                        // 任务记录消失（被用户清除）：结束轮询
                        break
                    }
                    val rIdx = cursor.getColumnIndex(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)
                    val tIdx = cursor.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)
                    val sIdx = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS)
                    if (rIdx >= 0) received = cursor.getLong(rIdx)
                    if (tIdx >= 0) total = cursor.getLong(tIdx)
                    val status = if (sIdx >= 0) cursor.getInt(sIdx) else 0
                    if (status == DownloadManager.STATUS_SUCCESSFUL) {
                        done = true; ok = true
                    } else if (status == DownloadManager.STATUS_FAILED) {
                        done = true
                    } else if (status != DownloadManager.STATUS_PENDING &&
                        status != DownloadManager.STATUS_RUNNING &&
                        status != DownloadManager.STATUS_PAUSED
                    ) {
                        done = true
                    }
                } catch (_: Throwable) {
                    break
                } finally {
                    try { cursor?.close() } catch (_: Throwable) {}
                }
                val now = SystemClock.elapsedRealtime()
                if (now - lastEmit > 300 || done) {
                    lastEmit = now
                    emitProgress(received, total)
                }
                if (done) {
                    if (ok) {
                        finishAndInstall()
                        emitFinished(true, "")
                    } else {
                        currentId = 0L
                        emitFinished(false, "下载失败，请重试")
                    }
                    announced = true
                    break
                }
                SystemClock.sleep(400)
            }
            if (!announced) {
                currentId = 0L
            }
        }.start()
    }

    /** 校验下载文件是有效 APK 且版本号达到期望值（防网络中断产生的半截包/旧包），不合格删除文件并返回错误描述 */
    private fun verifyApk(file: File): String? {
        if (!file.exists() || file.length() == 0L) return "安装包丢失，请重新下载"
        val head = ByteArray(2)
        java.io.RandomAccessFile(file, "r").use { raf -> raf.readFully(head) }
        if (!(head[0] == 'P'.code.toByte() && head[1] == 'K'.code.toByte())) {
            file.delete()
            return "安装包校验失败，请重新下载"
        }
        if (expectedCode > 0) {
            @Suppress("DEPRECATION")
            val info = reactContext.packageManager.getPackageArchiveInfo(file.absolutePath, 0)
            if (info == null) {
                file.delete()
                return "安装包不完整（网络中断），已删除，请重新下载"
            }
            if (info.versionCode < expectedCode) {
                file.delete()
                return "安装包版本异常（${info.versionCode} < $expectedCode），已删除，请重新下载"
            }
        }
        return null
    }

    /** 下载成功：校验文件头后拉起系统安装器（文件在 app 专属目录，无需存储权限） */
    private fun finishAndInstall() {
        try {
            val file = apkFile()
            val err = verifyApk(file)
            if (err != null) {
                emitFinished(false, err)
                return
            }
            currentId = 0L
            launchInstaller(file)
        } catch (t: Throwable) {
            currentId = 0L
            emitFinished(false, t.message ?: "安装失败")
        }
    }

    /** 用户在系统设置授权后回来，安装已下载好的更新包（含 DownloadManager 已完成但未安装的场景） */
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
            val err = verifyApk(file)
            if (err != null) {
                promise.reject("ERR_BAD_APK", err)
                return
            }
            launchInstaller(file)
            promise.resolve("installing")
        } catch (t: Throwable) {
            promise.reject("ERR_INSTALL", t.message)
        }
    }

    /**
     * 用现代 PackageInstaller 会话 API 安装（Android 官方推荐）：
     * commit 后系统弹出确认安装界面，真实安装结果经广播回传——
     * 避免 ACTION_VIEW 在部分 MIUI 版本被静默忽略、点安装直接跳回应用。
     * 任一步骤失败再回退 ACTION_VIEW 方式。
     */
    private fun launchInstaller(file: File) {
        val context = reactContext
        val installer = context.packageManager.packageInstaller
        var sessionId = -1
        try {
            // 清理上次的残留会话
            try {
                installer.mySessions?.forEach { installer.abandonSession(it.sessionId) }
            } catch (_: Throwable) {}

            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                setInstallReason(PackageManager.INSTALL_REASON_USER)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    setInstallScenario(PackageManager.INSTALL_SCENARIO_DEFAULT)
                }
            }
            sessionId = installer.createSession(params)
            val session = installer.openSession(sessionId)
            try {
                session.openWrite("pet-update.apk", 0, file.length()).use { out ->
                    file.inputStream().use { input ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n <= 0) break
                            out.write(buf, 0, n)
                        }
                    }
                    session.fsync(out)
                }
            } catch (t: Throwable) {
                try { installer.abandonSession(sessionId) } catch (_: Throwable) {}
                throw t
            }

            val action = "${context.packageName}.PKG_INSTALL_RESULT"
            val mainHandler = Handler(Looper.getMainLooper())
            var terminal = false
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(ctx: Context, intent: Intent) {
                    val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
                    // 旧版系统需应用自行拉起系统确认界面
                    if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                        val confirm: Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
                            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                        else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
                        if (confirm != null) {
                            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            ctx.startActivity(confirm)
                        }
                        return
                    }
                    if (terminal) return
                    terminal = true
                    mainHandler.removeCallbacksAndMessages(null)
                    try { ctx.unregisterReceiver(this) } catch (_: Throwable) {}
                    try { installer.abandonSession(sessionId) } catch (_: Throwable) {}
                    if (status == PackageInstaller.STATUS_SUCCESS) {
                        emitFinished(true, "")
                    } else {
                        val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: installErrorText(status)
                        emitFinished(false, msg)
                    }
                }
            }
            val regFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
                Context.RECEIVER_EXPORTED else 0
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.registerReceiver(receiver, IntentFilter(action), regFlags)
            } else {
                context.registerReceiver(receiver, IntentFilter(action))
            }
            // 5 分钟无操作兜底注销，避免接收器泄漏
            mainHandler.postDelayed({
                if (!terminal) {
                    terminal = true
                    try { context.unregisterReceiver(receiver) } catch (_: Throwable) {}
                }
            }, 5 * 60_000L)

            val piFlags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
            val statusSender = PendingIntent
                .getBroadcast(context, 2201, Intent(action), piFlags).intentSender
            session.commit(statusSender)
        } catch (t: Throwable) {
            if (sessionId >= 0) {
                try { installer.abandonSession(sessionId) } catch (_: Throwable) {}
            }
            // 回退老式 ACTION_VIEW 安装
            launchInstallerViewAction(context, file)
        }
    }

    private fun installErrorText(status: Int): String = when (status) {
        PackageInstaller.STATUS_FAILURE_BLOCKED -> "安装被系统安全策略拦截，请在系统设置中允许安装"
        PackageInstaller.STATUS_FAILURE_ABORTED -> "安装已取消"
        PackageInstaller.STATUS_FAILURE_INVALID -> "安装包无效"
        PackageInstaller.STATUS_FAILURE_CONFLICT -> "安装冲突，请先完全关闭本应用再试"
        PackageInstaller.STATUS_FAILURE_STORAGE -> "存储空间不足"
        PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "与当前设备不兼容"
        else -> "安装失败（$status）"
    }

    /** 老式 ACTION_VIEW 拉起系统安装器（PackageInstaller 失败时的兜底） */
    private fun launchInstallerViewAction(context: Context, file: File) {
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

    private fun emitFinished(ok: Boolean, message: String) {
        val map = Arguments.createMap()
        map.putBoolean("ok", ok)
        map.putString("message", message)
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("PetUpdateFinished", map)
    }
}
