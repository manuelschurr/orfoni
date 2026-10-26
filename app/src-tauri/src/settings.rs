use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::files;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub key_path: String,
    pub hub_command: String,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            host: String::new(),
            port: 22,
            user: "root".into(),
            key_path: "~/.ssh/id_ed25519".into(),
            // A non-interactive SSH command does not have ~/.local/bin on its PATH.
            hub_command: "\"$HOME/.local/bin/orfoni-hub\" connect".into(),
        }
    }
}

impl Settings {
    pub fn load(path: &Path) -> io::Result<Settings> {
        Ok(files::read(path)?.unwrap_or_default())
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        files::write(path, self)
    }

    pub fn key_file(&self) -> PathBuf {
        let rest = self
            .key_path
            .strip_prefix("~/")
            .or_else(|| self.key_path.strip_prefix("~\\"));
        match (rest, std::env::home_dir()) {
            (Some(rest), Some(home)) => home.join(rest),
            _ => PathBuf::from(&self.key_path),
        }
    }
}
