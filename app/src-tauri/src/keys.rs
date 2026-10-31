use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};

use russh::keys::ssh_key::LineEnding;
use russh::keys::ssh_key::private::{Ed25519Keypair, KeypairData};
use russh::keys::{HashAlg, PrivateKey};
use serde::Serialize;

// A device without ~/.ssh, a phone, keeps orfoni's key in the app's own data folder, which no other app can read.
const KEY_FILE: &str = "ssh/orfoni_key";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub path: String,
    pub public_key: String,
    pub fingerprint: String,
}

#[derive(Debug, thiserror::Error)]
pub enum KeyError {
    #[error("orfoni already has a key on this device")]
    Exists,
    #[error("this is not an OpenSSH private key ({0}); PuTTY .ppk files do not work")]
    NotOpenSsh(String),
    #[error("making the key failed: {0}")]
    Make(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

pub fn info(dir: &Path) -> Result<Option<KeyInfo>, KeyError> {
    let path = dir.join(KEY_FILE);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    describe(&path, &parse(&text)?).map(Some)
}

pub fn create(dir: &Path, comment: &str, replace: bool) -> Result<KeyInfo, KeyError> {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).map_err(|error| KeyError::Make(error.to_string()))?;
    let key = PrivateKey::new(KeypairData::Ed25519(Ed25519Keypair::from_seed(&seed)), comment)
        .map_err(|error| KeyError::Make(error.to_string()))?;
    let text = key
        .to_openssh(LineEnding::LF)
        .map_err(|error| KeyError::Make(error.to_string()))?;
    let path = store(dir, &text, replace)?;
    describe(&path, &key)
}

// An encrypted key imports too: its public half is readable without the passphrase, which the connection asks for.
pub fn import(dir: &Path, text: &str, replace: bool) -> Result<KeyInfo, KeyError> {
    let key = parse(text)?;
    let path = store(dir, text, replace)?;
    describe(&path, &key)
}

fn parse(text: &str) -> Result<PrivateKey, KeyError> {
    PrivateKey::from_openssh(text).map_err(|error| KeyError::NotOpenSsh(error.to_string()))
}

fn store(dir: &Path, text: &str, replace: bool) -> Result<PathBuf, KeyError> {
    let path = dir.join(KEY_FILE);
    if !replace && path.exists() {
        return Err(KeyError::Exists);
    }
    fs::create_dir_all(path.parent().expect("the key file sits in a folder"))?;
    let temporary = path.with_extension("tmp");
    let _ = fs::remove_file(&temporary);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&temporary)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    fs::rename(&temporary, &path)?;
    Ok(path)
}

fn describe(path: &Path, key: &PrivateKey) -> Result<KeyInfo, KeyError> {
    let public = key.public_key();
    Ok(KeyInfo {
        path: path.to_string_lossy().into_owned(),
        public_key: public
            .to_openssh()
            .map_err(|error| KeyError::Make(error.to_string()))?,
        fingerprint: public.fingerprint(HashAlg::Sha256).to_string(),
    })
}
