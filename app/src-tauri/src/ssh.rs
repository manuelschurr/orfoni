use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle, Msg};
use russh::keys::{HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate, ssh_key};
use russh::{ChannelMsg, ChannelReadHalf, ChannelWriteHalf};

use crate::known_hosts::KnownHosts;
use crate::settings::Settings;
use crate::terminal::TerminalChannel;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
// A laptop that sleeps drops the TCP connection without a FIN, so only keepalives notice.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
const KEEPALIVE_MAX: usize = 3;
const STDERR_LIMIT: usize = 4096;

#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("the host's key {fingerprint} is not trusted yet")]
    HostKeyUnknown { fingerprint: String },
    #[error("the host's key changed from {expected} to {found}, so the connection was refused")]
    HostKeyChanged { expected: String, found: String },
    #[error("the key needs its passphrase")]
    PassphraseNeeded,
    #[error("the server did not accept the key")]
    AuthFailed,
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    Closed(String),
}

impl From<russh::Error> for SshError {
    fn from(error: russh::Error) -> SshError {
        SshError::Io(error.to_string())
    }
}

struct HostKeyCheck {
    expected: Option<String>,
}

impl client::Handler for HostKeyCheck {
    type Error = SshError;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, SshError> {
        let key_data = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.key_data(),
            PublicKeyOrCertificate::Certificate(certificate) => certificate.public_key(),
        };
        let found = key_data.fingerprint(HashAlg::Sha256).to_string();
        match &self.expected {
            None => Err(SshError::HostKeyUnknown { fingerprint: found }),
            Some(expected) if *expected == found => Ok(true),
            Some(expected) => Err(SshError::HostKeyChanged {
                expected: expected.clone(),
                found,
            }),
        }
    }
}

fn load_key(path: &Path, passphrase: Option<&str>) -> Result<PrivateKey, SshError> {
    match russh::keys::load_secret_key(path, passphrase) {
        Ok(key) => Ok(key),
        Err(russh::keys::Error::KeyIsEncrypted) => Err(SshError::PassphraseNeeded),
        Err(russh::keys::Error::SshKey(ssh_key::Error::Crypto)) if passphrase.is_some() => {
            Err(SshError::PassphraseNeeded)
        }
        Err(error) => Err(SshError::Io(format!("{}: {error}", path.display()))),
    }
}

fn shell_quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', r"'\''"))
}

// -u because the login environment may not name a UTF-8 locale, while xterm.js always speaks UTF-8.
fn attach_command(target: &str) -> String {
    let exact = if target.starts_with('=') {
        target.to_string()
    } else {
        format!("={target}")
    };
    format!("tmux -u -L orfoni attach -t {}", shell_quote(&exact))
}

pub struct Connection {
    handle: Handle<HostKeyCheck>,
    hub_command: String,
}

impl Connection {
    pub async fn connect(
        settings: &Settings,
        passphrase: Option<&str>,
        known_hosts: &KnownHosts,
    ) -> Result<Connection, SshError> {
        let key = load_key(&settings.key_file(), passphrase)?;
        let check = HostKeyCheck {
            expected: known_hosts
                .fingerprint(&settings.host, settings.port)
                .map(String::from),
        };
        let config = Arc::new(client::Config {
            keepalive_interval: Some(KEEPALIVE_INTERVAL),
            keepalive_max: KEEPALIVE_MAX,
            nodelay: true,
            ..Default::default()
        });
        let login = async {
            let mut handle =
                client::connect(config, (settings.host.as_str(), settings.port), check).await?;
            let hash = handle.best_supported_rsa_hash().await?.flatten();
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
            if !handle
                .authenticate_publickey(&settings.user, key)
                .await?
                .success()
            {
                return Err(SshError::AuthFailed);
            }
            Ok(handle)
        };
        let handle = tokio::time::timeout(CONNECT_TIMEOUT, login)
            .await
            .map_err(|_| {
                SshError::Io(format!(
                    "{}:{} did not answer within {} s",
                    settings.host,
                    settings.port,
                    CONNECT_TIMEOUT.as_secs()
                ))
            })??;
        Ok(Connection {
            handle,
            hub_command: settings.hub_command.clone(),
        })
    }

    pub async fn open_hub(&self) -> Result<HubChannel, SshError> {
        let channel = self.handle.channel_open_session().await?;
        channel.exec(true, self.hub_command.as_bytes()).await?;
        let (read, write) = channel.split();
        Ok(HubChannel {
            read,
            write,
            pending: Vec::new(),
            stderr: Vec::new(),
            exit_status: None,
        })
    }

    pub async fn open_terminal(
        &self,
        target: &str,
        cols: u32,
        rows: u32,
    ) -> Result<TerminalChannel, SshError> {
        let channel = self.handle.channel_open_session().await?;
        channel
            .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
            .await?;
        channel.exec(true, attach_command(target)).await?;
        Ok(TerminalChannel::spawn(channel))
    }
}

pub struct HubChannel {
    read: ChannelReadHalf,
    write: ChannelWriteHalf<Msg>,
    pending: Vec<u8>,
    stderr: Vec<u8>,
    exit_status: Option<u32>,
}

impl HubChannel {
    pub async fn next_line(&mut self) -> Result<String, SshError> {
        loop {
            if let Some(end) = self.pending.iter().position(|&byte| byte == b'\n') {
                let line: Vec<u8> = self.pending.drain(..=end).collect();
                return Ok(String::from_utf8_lossy(&line[..end]).into_owned());
            }
            match self.read.wait().await {
                Some(ChannelMsg::Data { data }) => self.pending.extend_from_slice(&data),
                Some(ChannelMsg::ExtendedData { data, .. }) if self.stderr.len() < STDERR_LIMIT => {
                    self.stderr.extend_from_slice(&data)
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    self.exit_status = Some(exit_status)
                }
                Some(ChannelMsg::Close) | None => return Err(self.closed()),
                Some(_) => {}
            }
        }
    }

    fn closed(&self) -> SshError {
        let stderr = String::from_utf8_lossy(&self.stderr);
        let stderr = stderr.trim();
        let reason = match self.exit_status {
            Some(status) => format!("the hub exited with status {status}"),
            None => "the connection closed".to_string(),
        };
        SshError::Closed(if stderr.is_empty() {
            reason
        } else {
            format!("{reason}: {stderr}")
        })
    }

    pub async fn send(&self, line: &str) -> Result<(), SshError> {
        let mut bytes = Vec::with_capacity(line.len() + 1);
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');
        self.write
            .data_bytes(bytes)
            .await
            .map_err(|_| SshError::Closed("the connection closed".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::attach_command;

    #[test]
    fn attach_command_adds_the_exact_match_prefix_once() {
        assert_eq!(
            attach_command("orfoni-x"),
            "tmux -u -L orfoni attach -t '=orfoni-x'"
        );
        assert_eq!(
            attach_command("=orfoni-x-sh1"),
            "tmux -u -L orfoni attach -t '=orfoni-x-sh1'"
        );
    }
}
