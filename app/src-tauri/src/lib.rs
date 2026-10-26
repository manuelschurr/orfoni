mod commands;
mod files;
pub mod known_hosts;
pub mod link;
pub mod settings;
pub mod ssh;
pub mod terminal;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
