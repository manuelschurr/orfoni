package com.orfoni.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

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
}
