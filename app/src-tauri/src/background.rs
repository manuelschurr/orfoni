use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Runtime};

#[cfg(target_os = "android")]
struct Service<R: Runtime>(tauri::plugin::PluginHandle<R>);

/// The Android foreground service that keeps the app connected in the background (BackgroundPlugin.kt). Other platforms keep running without one.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("background")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                _app.manage(Service(_api.register_android_plugin("com.orfoni.app", "BackgroundPlugin")?));
            }
            Ok(())
        })
        .build()
}

#[cfg_attr(not(target_os = "android"), allow(unused_variables))]
pub fn stay_connected<R: Runtime>(app: &AppHandle<R>, on: bool) {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        if let Some(service) = app.try_state::<Service<R>>()
            && let Err(error) = service.0.run_mobile_plugin::<serde_json::Value>(if on { "start" } else { "stop" }, ())
        {
            log::warn!("the background connection did not {}: {error}", if on { "start" } else { "stop" });
        }
    }
}
