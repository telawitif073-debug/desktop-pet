package com.mobilepet

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.res.Resources
import android.graphics.PixelFormat
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.app.NotificationCompat

/**
 * 悬浮窗宠物前台服务：
 * - 创建通知渠道并启动为前台服务（Android 14+ 需 foregroundServiceType）
 * - 通过 WindowManager 添加一个透明 WebView 加载本地渲染页
 * - WebView 支持拖动（OnTouchListener）与点击互动（透传给网页）
 *
 * 渲染页位于 app/src/main/assets/overlay.html，由 RN 通过 startOverlay(url) 传入
 * 完整的 file:///android_asset/overlay.html 或者一个 http(s) URL（如 metro dev server）。
 */
class OverlayPetService : Service() {

    companion object {
        const val EXTRA_HTML_URL = "OverlayPetService.extra.htmlUrl"
        private const val CHANNEL_ID = "overlay_pet_channel"
        private const val NOTIFICATION_ID = 0x5D01
    }

    private lateinit var windowManager: WindowManager
    private var petView: WebView? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val htmlUrl = intent?.getStringExtra(EXTRA_HTML_URL)
            ?: "file:///android_asset/overlay.html"
        startForeground(NOTIFICATION_ID, buildNotification())
        if (petView == null) {
            addPetView(htmlUrl)
        } else {
            petView?.loadUrl(htmlUrl)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        petView?.let { view ->
            try {
                windowManager.removeView(view)
            } catch (_: Throwable) {
            }
            view.destroy()
            petView = null
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "悬浮宠物",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "在其他应用上方显示宠物"
                setShowBadge(false)
            }
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("宠物悬浮中")
            .setContentText("点击关闭可移除宠物")
            .setSmallIcon(android.R.drawable.star_on)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
        return builder.build()
    }

    private fun addPetView(htmlUrl: String) {
        val dm = Resources.getSystem().displayMetrics
        val sizePx = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, 180f, dm
        ).toInt()

        val webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            settings.mediaPlaybackRequiresUserGesture = false
            webViewClient = WebViewClient()
            webChromeClient = WebChromeClient()
            setBackgroundColor(android.graphics.Color.TRANSPARENT)
            isClickable = true
            // 不参与输入焦点：TYPE_APPLICATION_OVERLAY 永远置顶，若可获焦点会把 IME 绑在
            // 悬浮窗上，导致宠物应用与其他应用的键盘全部失效（点击互动只走触摸事件，不受影响）
            isFocusable = false
        }
        webView.loadUrl(htmlUrl)

        val params = WindowManager.LayoutParams(
            sizePx,
            sizePx,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else
                @Suppress("DEPRECATION")
                WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.BOTTOM or Gravity.START
            x = dp(16)
            y = dp(120)
        }

        attachDragHandler(webView, params)
        webView.layoutParams = params
        windowManager.addView(webView, params)
        petView = webView
    }

    private fun dp(value: Int): Int {
        val dm = Resources.getSystem().displayMetrics
        return TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), dm
        ).toInt()
    }

    /**
     * 拖动 + 点击双行为 OnTouchListener：
     * - 按下记录起点与时间戳
     * - 移动超过 8dp 视为拖动，移动中实时 setX/setY
     * - 抬起时若未拖动则视为点击，将 MotionEvent 重新分发给 WebView（让网页收到点击）
     */
    private fun attachDragHandler(
        view: View,
        params: WindowManager.LayoutParams,
    ) {
        val touchSlop = dp(8)
        var startX = 0
        var startY = 0
        var rawStartX = 0f
        var rawStartY = 0f
        var dragging = false
        var downTime = 0L

        view.setOnTouchListener { v, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    startX = params.x
                    startY = params.y
                    rawStartX = event.rawX
                    rawStartY = event.rawY
                    dragging = false
                    downTime = event.eventTime
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (event.rawX - rawStartX).toInt()
                    val dy = (event.rawY - rawStartY).toInt()
                    if (!dragging && dx * dx + dy * dy > touchSlop * touchSlop) {
                        dragging = true
                    }
                    if (dragging) {
                        params.x = startX + dx
                        // BOTTOM 重力下 y 为距底边距离（向上为正）：手指上移 rawY 减小，y 应增大
                        params.y = startY - dy
                        windowManager.updateViewLayout(view, params)
                    }
                }
                MotionEvent.ACTION_UP -> {
                    if (!dragging) {
                        // 未拖动：返回 false，让 WebView 按原始事件流正常收到完整点击。
                        // 切勿在这里手动 dispatchTouchEvent 重发：会重入本监听器造成
                        // 无限递归（StackOverflowError 进程崩溃，悬浮窗宠物直接消失）。
                        return@setOnTouchListener false
                    }
                }
            }
            // 拖动时消费事件，避免触发底层页面跳转
            dragging
        }
    }
}
