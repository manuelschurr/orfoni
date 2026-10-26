use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::files;
use crate::ssh::SshError;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Hosts {
    hosts: BTreeMap<String, String>,
}

#[derive(Clone, Debug)]
pub struct KnownHosts {
    path: PathBuf,
    hosts: Hosts,
}

fn key(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

impl KnownHosts {
    pub fn load(path: &Path) -> io::Result<KnownHosts> {
        Ok(KnownHosts {
            path: path.to_path_buf(),
            hosts: files::read(path)?.unwrap_or_default(),
        })
    }

    pub fn fingerprint(&self, host: &str, port: u16) -> Option<&str> {
        self.hosts.hosts.get(&key(host, port)).map(String::as_str)
    }

    pub fn trust(&mut self, host: &str, port: u16, fingerprint: &str) -> Result<(), SshError> {
        match self.fingerprint(host, port) {
            Some(known) if known == fingerprint => return Ok(()),
            Some(known) => {
                return Err(SshError::HostKeyChanged {
                    expected: known.into(),
                    found: fingerprint.into(),
                });
            }
            None => {}
        }
        self.hosts.hosts.insert(key(host, port), fingerprint.into());
        files::write(&self.path, &self.hosts).map_err(|error| SshError::Io(error.to_string()))
    }
}
