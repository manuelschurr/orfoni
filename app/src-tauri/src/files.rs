use std::fs;
use std::io::{self, ErrorKind};
use std::path::Path;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

const VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct Versioned<T> {
    version: u32,
    #[serde(flatten)]
    body: T,
}

fn invalid(path: &Path, problem: impl std::fmt::Display) -> io::Error {
    io::Error::new(
        ErrorKind::InvalidData,
        format!("{}: {problem}", path.display()),
    )
}

pub fn read<T: DeserializeOwned>(path: &Path) -> io::Result<Option<T>> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let file: Versioned<T> = serde_json::from_str(&text).map_err(|error| invalid(path, error))?;
    if file.version != VERSION {
        return Err(invalid(
            path,
            format!("version {} is not one this app reads", file.version),
        ));
    }
    Ok(Some(file.body))
}

pub fn write<T: Serialize>(path: &Path, body: &T) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let text = serde_json::to_string_pretty(&Versioned {
        version: VERSION,
        body,
    })?;
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, text)?;
    fs::rename(&temporary, path)
}
