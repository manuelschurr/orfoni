use std::collections::HashMap;
use std::fmt::Display;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};

use crate::known_hosts::KnownHosts;
use crate::link::{HubLink, LinkEvent};
use crate::settings::Settings;
use crate::ssh::SshError;
use crate::terminal::TerminalInput;

pub struct AppState {
    settings_path: PathBuf,
    known_hosts_path: PathBuf,
    debug: bool,
    link: Mutex<Option<HubLink>>,
    terminals: Arc<Mutex<HashMap<u32, TerminalInput>>>,
    next_terminal: AtomicU32,
}

impl AppState {
    pub fn new(data_dir: &Path, debug: bool) -> AppState {
        AppState {
            settings_path: data_dir.join("settings.json"),
            known_hosts_path: data_dir.join("known-hosts.json"),
            debug,
            link: Mutex::new(None),
            terminals: Arc::default(),
            next_terminal: AtomicU32::new(1),
        }
    }

    fn disconnect(&self) {
        let link = self.link.lock().unwrap().take();
        drop(link);
        for terminal in self.terminals.lock().unwrap().values() {
            terminal.close();
        }
    }

    fn terminal(&self, id: u32) -> Option<TerminalInput> {
        self.terminals.lock().unwrap().get(&id).cloned()
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConnectOutcome {
    Connected,
    Failed {
        error: String,
    },
    HostKeyUnknown {
        fingerprint: String,
    },
    #[serde(rename_all = "camelCase")]
    HostKeyChanged {
        expected: String,
        found: String,
        known_hosts_file: String,
    },
    PassphraseNeeded,
}

impl ConnectOutcome {
    fn from_error(error: SshError, known_hosts: &Path) -> ConnectOutcome {
        match error {
            SshError::HostKeyUnknown { fingerprint } => {
                ConnectOutcome::HostKeyUnknown { fingerprint }
            }
            SshError::HostKeyChanged { expected, found } => ConnectOutcome::HostKeyChanged {
                expected,
                found,
                known_hosts_file: known_hosts.display().to_string(),
            },
            SshError::PassphraseNeeded => ConnectOutcome::PassphraseNeeded,
            other => ConnectOutcome::Failed {
                error: other.to_string(),
            },
        }
    }
}

fn describe(error: impl Display) -> String {
    error.to_string()
}

#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    passphrase: Option<String>,
    events: Channel<LinkEvent>,
) -> Result<ConnectOutcome, String> {
    state.disconnect();
    let settings = Settings::load(&state.settings_path).map_err(describe)?;
    let known_hosts = KnownHosts::load(&state.known_hosts_path).map_err(describe)?;
    let started = HubLink::start(settings, passphrase, known_hosts, move |event| {
        let _ = events.send(event);
    })
    .await;
    match started {
        Ok(link) => {
            *state.link.lock().unwrap() = Some(link);
            Ok(ConnectOutcome::Connected)
        }
        Err(error) => Ok(ConnectOutcome::from_error(error, &state.known_hosts_path)),
    }
}

#[tauri::command]
pub fn disconnect(state: State<'_, AppState>) {
    state.disconnect();
}

#[tauri::command]
pub fn trust_host(state: State<'_, AppState>, fingerprint: String) -> Result<(), String> {
    let settings = Settings::load(&state.settings_path).map_err(describe)?;
    let mut known_hosts = KnownHosts::load(&state.known_hosts_path).map_err(describe)?;
    known_hosts
        .trust(&settings.host, settings.port, &fingerprint)
        .map_err(describe)
}

#[tauri::command]
pub fn hub_send(state: State<'_, AppState>, line: String) -> Result<(), String> {
    match state.link.lock().unwrap().as_ref() {
        Some(link) => link.send(line).map_err(describe),
        None => Err("not connected".into()),
    }
}

#[tauri::command]
pub async fn terminal_open(
    state: State<'_, AppState>,
    target: String,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    let connection = state
        .link
        .lock()
        .unwrap()
        .as_ref()
        .and_then(HubLink::connection)
        .ok_or_else(|| "not connected".to_string())?;
    let terminal = connection
        .open_terminal(&target, cols, rows)
        .await
        .map_err(describe)?;
    let id = state.next_terminal.fetch_add(1, Ordering::Relaxed);
    state.terminals.lock().unwrap().insert(id, terminal.input);
    let terminals = state.terminals.clone();
    let mut output = terminal.output;
    tauri::async_runtime::spawn(async move {
        while let Some(chunk) = output.recv().await {
            if on_data.send(InvokeResponseBody::Raw(chunk)).is_err() {
                break;
            }
        }
        let _ = on_data.send(InvokeResponseBody::Json("null".into()));
        terminals.lock().unwrap().remove(&id);
    });
    Ok(id)
}

#[tauri::command]
pub fn terminal_write(state: State<'_, AppState>, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("terminal_write takes raw bytes".into());
    };
    let id: u32 = request
        .headers()
        .get("terminal-id")
        .and_then(|value| value.to_str().ok()?.parse().ok())
        .ok_or_else(|| "terminal_write needs a terminal-id header".to_string())?;
    if let Some(terminal) = state.terminal(id) {
        terminal.write(data.clone());
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_resize(state: State<'_, AppState>, id: u32, cols: u32, rows: u32) {
    if let Some(terminal) = state.terminal(id) {
        terminal.resize(cols, rows);
    }
}

#[tauri::command]
pub fn terminal_close(state: State<'_, AppState>, id: u32) {
    if let Some(terminal) = state.terminal(id) {
        terminal.close();
    }
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Result<Settings, String> {
    Settings::load(&state.settings_path).map_err(describe)
}

#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    settings.save(&state.settings_path).map_err(describe)
}

#[tauri::command]
pub fn debug_log(state: State<'_, AppState>, message: String) -> bool {
    if state.debug {
        eprintln!("orfoni-debug: {message}");
    }
    state.debug
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_changed_host_key_names_the_file_that_holds_the_trusted_key() {
        let outcome = ConnectOutcome::from_error(
            SshError::HostKeyChanged {
                expected: "SHA256:old".into(),
                found: "SHA256:new".into(),
            },
            Path::new("/data/known-hosts.json"),
        );
        assert_eq!(
            serde_json::to_value(outcome).unwrap(),
            serde_json::json!({
                "kind": "hostKeyChanged",
                "expected": "SHA256:old",
                "found": "SHA256:new",
                "knownHostsFile": "/data/known-hosts.json",
            })
        );
    }
}
