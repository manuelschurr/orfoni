package com.orfoni.app

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.annotation.RequiresApi
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class SaveArgs {
  // The part file downloads.rs wrote in the app's cache folder.
  lateinit var path: String
  // Already made safe by safe_name in downloads.rs.
  lateinit var name: String
}

@TauriPlugin
class DownloadsPlugin(private val activity: Activity) : Plugin(activity) {
  // Saves the part where the phone's Files app shows downloads, then opens it with the app for its type. The copy runs off the main thread, since a file can be 100 MB. Resolves with { folder, name, how }, which downloads.rs reads as SavedFile.
  @Command
  fun saveAndOpen(invoke: Invoke) {
    val args = invoke.parseArgs(SaveArgs::class.java)
    Thread {
      val saved = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) toSharedDownloads(File(args.path), args.name) else toAppDownloads(File(args.path), args.name)
      } catch (error: Exception) {
        invoke.reject("Saving ${args.name} on the phone failed: ${error.message}")
        return@Thread
      }
      activity.runOnUiThread {
        try {
          val how = try {
            activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(saved.uri, viewType(saved.name)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
            "opened"
          } catch (_: ActivityNotFoundException) {
            "noApp"
          }
          val result = JSObject()
          result.put("folder", saved.folder)
          result.put("name", saved.name)
          result.put("how", how)
          invoke.resolve(result)
        } catch (error: Exception) {
          invoke.reject("Saved ${saved.name} to ${saved.folder}, but opening it failed: ${error.message}")
        }
      }
    }.start()
  }

  private class Saved(val uri: Uri, val folder: String, val name: String)

  // Android 10 and later: MediaStore's Downloads collection under Download/orfoni, which needs no permission for the app's own files and survives an uninstall. Android picks "name (1).ext" itself on a clash, so the name comes back from the row it made.
  @RequiresApi(Build.VERSION_CODES.Q)
  private fun toSharedDownloads(part: File, name: String): Saved {
    val resolver = activity.contentResolver
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, name)
      put(MediaStore.MediaColumns.MIME_TYPE, storeType(name))
      put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/orfoni")
      put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("Android made no entry in Downloads")
    try {
      val out = resolver.openOutputStream(uri) ?: error("Android gave no way to write the entry")
      out.use { part.inputStream().use { input -> input.copyTo(it) } }
      resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
    } catch (error: Exception) {
      resolver.delete(uri, null, null)
      throw error
    }
    val shown = resolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null }
    return Saved(uri, "Download/orfoni", shown ?: name)
  }

  // Android 7 to 9, where MediaStore has no Downloads collection and the shared folder needs a storage permission: the app's own external Download folder, which file_paths.xml's external-path covers, shared through the FileProvider the manifest declares.
  private fun toAppDownloads(part: File, name: String): Saved {
    val dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: error("the phone's storage is not available")
    dir.mkdirs()
    val file = (0 until 1000).asSequence().map { File(dir, numbered(name, it)) }.firstOrNull { it.createNewFile() } ?: error("$name and 999 numbered names after it are taken")
    part.copyTo(file, overwrite = true)
    return Saved(FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file), "Android/data/${activity.packageName}/files/Download", file.name)
  }

  private fun numbered(name: String, n: Int): String {
    if (n == 0) return name
    val dot = name.lastIndexOf('.')
    return if (dot > 0) "${name.substring(0, dot)} ($n)${name.substring(dot)}" else "$name ($n)"
  }

  private fun extension(name: String) = name.substringAfterLast('.', "").lowercase()

  // MediaProvider appends an extension that matches the type it is given, so a type Android does not know is stored as octet-stream, which keeps the name as it is.
  private fun storeType(name: String) = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension(name)) ?: "application/octet-stream"

  // Source files and notes Android does not know open as text, and the rest as anything, so the phone offers every app that takes any file.
  private fun viewType(name: String): String {
    val ext = extension(name)
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: if (ext in TEXT) "text/plain" else "*/*"
  }

  private companion object {
    val TEXT = setOf("md", "txt", "log", "json", "jsonl", "ts", "js", "svelte", "rs", "kt", "py", "sh", "toml", "yaml", "yml", "csv", "tsv")
  }
}
