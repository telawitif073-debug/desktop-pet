package com.mobilepet

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.Locale

/**
 * 语音模块（系统自带能力，无需联网模型）：
 * - TTS：android.speech.tts.TextToSpeech，中文朗读，支持音色/语速/音调
 * - STT：android.speech.SpeechRecognizer，按住说话识别中文，结果经事件回传 JS
 *
 * 事件（JS 用 DeviceEventEmitter 监听）：
 * - PetVoiceStart / PetVoicePartial { text } / PetVoiceResult { text } / PetVoiceError { code, message }
 */
class PetVoiceModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "PetVoice"

    private val mainHandler = Handler(Looper.getMainLooper())
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var pendingSpeak: String? = null
    private var pendingVoicesPromise: Promise? = null
    private var recognizer: SpeechRecognizer? = null

    // TTS 当前设置（speak 时传入，init 完成后应用）
    private var currentVoiceName: String? = null
    private var currentRate: Float = 1.0f
    private var currentPitch: Float = 1.0f

    // ---------- TTS ----------

    private fun ensureTts() {
        if (tts != null) return
        mainHandler.post {
            if (tts != null) return@post
            tts = TextToSpeech(reactContext.applicationContext) { status ->
                ttsReady = status == TextToSpeech.SUCCESS &&
                    tts?.setLanguage(Locale.SIMPLIFIED_CHINESE)?.let {
                        it != TextToSpeech.LANG_MISSING_DATA && it != TextToSpeech.LANG_NOT_SUPPORTED
                    } == true
                if (!ttsReady) ttsReady = status == TextToSpeech.SUCCESS
                if (ttsReady) {
                    applySpeechSettings()
                    val text = pendingSpeak
                    if (text != null) {
                        pendingSpeak = null
                        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "pet-utterance")
                    }
                }
                pendingVoicesPromise?.let { p ->
                    pendingVoicesPromise = null
                    resolveVoices(p)
                }
            }
        }
    }

    private fun applySpeechSettings() {
        val t = tts ?: return
        try {
            currentVoiceName?.let { name ->
                t.voices?.firstOrNull { it.name == name }?.let { t.setVoice(it) }
            }
            t.setSpeechRate(currentRate)
            t.setPitch(currentPitch)
        } catch (_: Throwable) {
        }
    }

    @ReactMethod
    fun speak(text: String, options: ReadableMap?, promise: Promise) {
        try {
            if (text.isBlank()) {
                promise.resolve(false)
                return
            }
            options?.let { o ->
                if (o.hasKey("rate") && !o.isNull("rate")) {
                    currentRate = o.getDouble("rate").toFloat().coerceIn(0.5f, 2.0f)
                }
                if (o.hasKey("pitch") && !o.isNull("pitch")) {
                    currentPitch = o.getDouble("pitch").toFloat().coerceIn(0.5f, 2.0f)
                }
                currentVoiceName =
                    if (o.hasKey("voice") && !o.isNull("voice")) o.getString("voice")?.takeIf { it.isNotBlank() }
                    else null
            }
            if (!ttsReady) {
                pendingSpeak = text
                ensureTts()
            } else {
                mainHandler.post {
                    applySpeechSettings()
                    tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "pet-utterance")
                }
            }
            promise.resolve(true)
        } catch (t: Throwable) {
            promise.reject("ERR_TTS", t.message)
        }
    }

    /** 设备可用的中文音色列表 [{ name, label }] */
    @ReactMethod
    fun listVoices(promise: Promise) {
        if (ttsReady) {
            resolveVoices(promise)
        } else {
            pendingVoicesPromise = promise
            ensureTts()
        }
    }

    private fun resolveVoices(promise: Promise) {
        val arr: WritableArray = Arguments.createArray()
        try {
            tts?.voices?.forEach { v ->
                if (v.locale?.language?.startsWith("zh") == true) {
                    val m = Arguments.createMap()
                    m.putString("name", v.name)
                    m.putString("label", v.locale?.displayName ?: v.name)
                    arr.pushMap(m)
                }
            }
        } catch (_: Throwable) {
        }
        promise.resolve(arr)
    }

    @ReactMethod
    fun stopSpeak(promise: Promise) {
        try {
            pendingSpeak = null
            mainHandler.post { tts?.stop() }
            promise.resolve(true)
        } catch (t: Throwable) {
            promise.reject("ERR_TTS_STOP", t.message)
        }
    }

    // ---------- STT ----------

    private fun sendEvent(name: String, params: WritableMap?): Unit {
        reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, params)
    }

    @ReactMethod
    fun isSpeechAvailable(promise: Promise) {
        promise.resolve(SpeechRecognizer.isRecognitionAvailable(reactContext.applicationContext))
    }

    @ReactMethod
    fun startListening(promise: Promise) {
        try {
            if (!SpeechRecognizer.isRecognitionAvailable(reactContext.applicationContext)) {
                promise.reject("ERR_NO_RECOGNIZER", "设备没有可用的语音识别服务")
                return
            }
            mainHandler.post {
                if (recognizer == null) {
                    recognizer = SpeechRecognizer.createSpeechRecognizer(reactContext.applicationContext)
                    recognizer?.setRecognitionListener(listener)
                }
                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
                    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                }
                recognizer?.startListening(intent)
                sendEvent("PetVoiceStart", null)
                promise.resolve(true)
            }
        } catch (t: Throwable) {
            promise.reject("ERR_STT_START", t.message)
        }
    }

    @ReactMethod
    fun stopListening(promise: Promise) {
        try {
            mainHandler.post { recognizer?.stopListening() }
            promise.resolve(true)
        } catch (t: Throwable) {
            promise.reject("ERR_STT_STOP", t.message)
        }
    }

    private fun errorInfo(code: Int): Pair<String, String> = when (code) {
        SpeechRecognizer.ERROR_NO_MATCH -> "no_match" to "没有听清，请再试一次"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "timeout" to "没有检测到说话"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "permission" to "缺少麦克风权限"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "busy" to "识别服务忙，请稍后再试"
        else -> "error" to "识别失败（$code）"
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}

        override fun onBeginningOfSpeech() {}

        override fun onRmsChanged(rmsdB: Float) {}

        override fun onBufferReceived(buffer: ByteArray?) {}

        override fun onEndOfSpeech() {}

        override fun onError(error: Int) {
            val (code, message) = errorInfo(error)
            val map = Arguments.createMap()
            map.putString("code", code)
            map.putString("message", message)
            sendEvent("PetVoiceError", map)
        }

        override fun onResults(results: Bundle?) {
            val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
            val map = Arguments.createMap()
            map.putString("text", text)
            sendEvent("PetVoiceResult", map)
        }

        override fun onPartialResults(partialResults: Bundle?) {
            val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
            if (text.isNotEmpty()) {
                val map = Arguments.createMap()
                map.putString("text", text)
                sendEvent("PetVoicePartial", map)
            }
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    override fun invalidate() {
        mainHandler.post {
            recognizer?.destroy()
            recognizer = null
            tts?.shutdown()
            tts = null
            ttsReady = false
        }
        super.invalidate()
    }
}
