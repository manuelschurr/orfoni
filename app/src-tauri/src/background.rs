use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Runtime};

#[cfg(target_os = "android")]
use crate::notices::Notice;

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

/// Shows a notice as orfoni's own Android notification, whose tap opens orfoni on that session (BackgroundPlugin.kt).
#[cfg(target_os = "android")]
pub fn notify<R: Runtime>(app: &AppHandle<R>, notice: &Notice) {
    use tauri::Manager;
    if let Some(service) = app.try_state::<Service<R>>()
        && let Err(error) = service.0.run_mobile_plugin::<serde_json::Value>("notify", notice)
    {
        log::warn!("showing a notification failed: {error}");
    }
}

/// The session of the notice tapped since the last call. Only Android shows notices whose tap names their session.
#[cfg_attr(not(target_os = "android"), allow(unused_variables))]
pub fn opened<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Opened {
            session_id: Option<String>,
        }
        let service = app.try_state::<Service<R>>()?;
        return service.0.run_mobile_plugin::<Opened>("takeOpened", ()).ok()?.session_id;
    }
    #[cfg(not(target_os = "android"))]
    None
}
