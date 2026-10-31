package com.orfoni.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

// Keeps orfoni's process, and with it the SSH connection to the hub, alive while the app is in the background, so the hub's notices still reach the phone. Android shows a foreground service as a notification for as long as it runs.
class ConnectionService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL, "Connection", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shows while orfoni stays connected in the background"
      }
    )
    val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
    val notification = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_launcher_foreground)
      .setContentTitle("orfoni is connected")
      .setContentText("Approvals and answers reach you while orfoni is in the background")
      .setContentIntent(open)
      .setOngoing(true)
      .build()
    val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
    ServiceCompat.startForeground(this, ID, notification, type)
    // The app's runtime lives in the activity's process, so a service that Android restarts on its own would hold nothing.
    return START_NOT_STICKY
  }

  companion object {
    const val CHANNEL = "connection"
    const val ID = 1
  }
}
