pub mod commands;
mod files;
pub mod known_hosts;
pub mod link;
pub mod settings;
pub mod ssh;
pub mod terminal;

use tauri::{Manager, Url};

fn stays_in_app(url: &Url, dev_url: Option<&Url>) -> bool {
    match (url.scheme(), url.host_str()) {
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost")) => true,
        _ => dev_url.is_some_and(|dev| dev.origin() == url.origin()),
    }
}

// The window has no address bar, so a page it navigated to could pass itself off as the app.
fn navigation_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let dev_url = webview.config().build.dev_url.as_ref();
            let allowed = stays_in_app(url, dev_url.filter(|_| tauri::is_dev()));
            if !allowed {
                log::warn!("refused to navigate the app window to {url}");
            }
            allowed
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(navigation_guard())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let debug = std::env::var_os("ORFONI_DEBUG").is_some();
            app.manage(commands::AppState::new(&app.path().app_data_dir()?, debug));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connect,
            commands::disconnect,
            commands::trust_host,
            commands::hub_send,
            commands::terminal_open,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_close,
            commands::settings_get,
            commands::settings_set,
            commands::debug_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn the_window_stays_on_the_app_origin() {
        for allowed in [
            "tauri://localhost/",
            "tauri://localhost/index.html?x=1",
            "http://tauri.localhost/",
            "https://tauri.localhost/assets/index.js",
        ] {
            assert!(stays_in_app(&url(allowed), None), "{allowed}");
        }
        for refused in [
            "https://attacker.example/",
            "http://localhost:5173/",
            "tauri://localhost.attacker.example/",
            "http://tauri.localhost.attacker.example/",
            "http://ipc.localhost/",
            "file:///etc/passwd",
            "data:text/html,hi",
            "about:blank",
        ] {
            assert!(!stays_in_app(&url(refused), None), "{refused}");
        }
    }

    #[test]
    fn a_development_build_may_also_load_its_dev_server() {
        let dev = url("http://localhost:5173");
        assert!(stays_in_app(&url("http://localhost:5173/?a=1"), Some(&dev)));
        assert!(!stays_in_app(&url("http://localhost:5174/"), Some(&dev)));
        assert!(!stays_in_app(&url("https://attacker.example/"), Some(&dev)));
    }
}
