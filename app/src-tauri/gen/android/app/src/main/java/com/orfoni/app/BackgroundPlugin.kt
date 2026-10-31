package com.orfoni.app

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import android.webkit.WebView
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class NoticeArgs {
  lateinit var sessionId: String
  lateinit var title: String
  lateinit var body: String
}

@TauriPlugin
class BackgroundPlugin(private val activity: Activity) : Plugin(activity) {
  // The foreground service keeps the network through Doze on its own, but phone makers' battery managers (OnePlus, Xiaomi and others) still stop background apps that are not exempt, so starting asks once to be let off those limits.
  @Command
  fun start(invoke: Invoke) {
    ContextCompat.startForegroundService(activity, Intent(activity, ConnectionService::class.java))
    val power = activity.getSystemService(PowerManager::class.java)
    val prefs = activity.getSharedPreferences("orfoni", Context.MODE_PRIVATE)
    if (!power.isIgnoringBatteryOptimizations(activity.packageName) && !prefs.getBoolean("askedBatteryLimits", false)) {
      prefs.edit().putBoolean("askedBatteryLimits", true).apply()
      activity.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${activity.packageName}")))
    }
    invoke.resolve()
  }

  @Command
  fun stop(invoke: Invoke) {
    activity.stopService(Intent(activity, ConnectionService::class.java))
    invoke.resolve()
  }

  // The session of the notice tapped since Rust last asked, from the tap that started orfoni or one that brought it back.
  private var opened: String? = null

  // The activity keeps the intent that started it, and Android hands it back when orfoni is reopened from the recent apps, so the session is taken off it once read.
  override fun load(webView: WebView) {
    opened = activity.intent?.getStringExtra(SESSION)
    activity.intent?.removeExtra(SESSION)
  }

  override fun onNewIntent(intent: Intent) {
    intent.getStringExtra(SESSION)?.let { opened = it }
  }

  // The notification plugin loses what a notification carries once it is tapped, so orfoni shows the hub's notices itself. One per session, so a newer notice replaces an older one, and a tap opens orfoni on that session.
  @Command
  fun notify(invoke: Invoke) {
    val args = invoke.parseArgs(NoticeArgs::class.java)
    val manager = activity.getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel(NOTICES, "Approvals and answers", NotificationManager.IMPORTANCE_DEFAULT))
    val id = args.sessionId.hashCode()
    val open = PendingIntent.getActivity(activity, id, Intent(activity, MainActivity::class.java).putExtra(SESSION, args.sessionId), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val notification = NotificationCompat.Builder(activity, NOTICES)
      .setSmallIcon(R.drawable.ic_launcher_foreground)
      .setContentTitle(args.title)
      .setContentText(args.body)
      .setContentIntent(open)
      .setAutoCancel(true)
      .build()
    manager.notify(id, notification)
    invoke.resolve()
  }

  @Command
  fun takeOpened(invoke: Invoke) {
    val result = JSObject()
    opened?.let { result.put("sessionId", it) }
    opened = null
    invoke.resolve(result)
  }

  companion object {
    const val NOTICES = "notices"
    const val SESSION = "orfoniSession"
  }
}
