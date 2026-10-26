use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::known_hosts::KnownHosts;
use crate::settings::Settings;
use crate::ssh::{Connection, HubChannel, SshError};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Status {
    Connecting,
    Connected,
    Reconnecting { attempt: u32, error: String },
    Failed { error: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum LinkEvent {
    Status(Status),
    Line(String),
}

struct Login {
    settings: Settings,
    passphrase: Option<String>,
    known_hosts: KnownHosts,
}

impl Login {
    async fn open(&self) -> Result<(Arc<Connection>, HubChannel), SshError> {
        let connection = Connection::connect(
            &self.settings,
            self.passphrase.as_deref(),
            &self.known_hosts,
        )
        .await?;
        let hub = connection.open_hub().await?;
        Ok((Arc::new(connection), hub))
    }
}

pub struct HubLink {
    outgoing: mpsc::UnboundedSender<String>,
    connection: watch::Receiver<Option<Arc<Connection>>>,
    task: JoinHandle<()>,
}

impl HubLink {
    pub async fn start<F>(
        settings: Settings,
        passphrase: Option<String>,
        known_hosts: KnownHosts,
        on_event: F,
    ) -> Result<HubLink, SshError>
    where
        F: Fn(LinkEvent) + Send + Sync + 'static,
    {
        let login = Login {
            settings,
            passphrase,
            known_hosts,
        };
        on_event(LinkEvent::Status(Status::Connecting));
        let (connection, hub) = match login.open().await {
            Ok(opened) => opened,
            Err(error) => {
                on_event(LinkEvent::Status(Status::Failed {
                    error: error.to_string(),
                }));
                return Err(error);
            }
        };
        let (outgoing, queue) = mpsc::unbounded_channel();
        let (current, connection) = watch::channel(Some(connection));
        let task = tokio::spawn(supervise(login, hub, queue, current, on_event));
        Ok(HubLink {
            outgoing,
            connection,
            task,
        })
    }

    pub fn send(&self, line: String) -> Result<(), SshError> {
        if self.connection.borrow().is_none() {
            return Err(SshError::Closed("not connected".into()));
        }
        self.outgoing
            .send(line)
            .map_err(|_| SshError::Closed("the connection was given up".into()))
    }

    pub fn connection(&self) -> Option<Arc<Connection>> {
        self.connection.borrow().clone()
    }
}

impl Drop for HubLink {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub fn backoff(attempt: u32) -> Duration {
    Duration::from_secs(match attempt {
        0 | 1 => 1,
        2 => 2,
        3 => 4,
        4 => 8,
        _ => 15,
    })
}

// A hub command that exits at once still gets its exec accepted, so the link counts as up only once the hub answers this probe or the channel stays open for SETTLE. HubClient numbers its requests from 1 and ignores the answer.
pub const PROBE: &str = r#"{"id":0,"method":"listSessions"}"#;
const SETTLE: Duration = Duration::from_secs(30);

async fn confirm(hub: &mut HubChannel) -> Result<Option<String>, SshError> {
    hub.send(PROBE).await?;
    match tokio::time::timeout(SETTLE, hub.next_line()).await {
        Ok(line) => line.map(Some),
        Err(_) => Ok(None),
    }
}

async fn relay(
    hub: &mut HubChannel,
    queue: &mut mpsc::UnboundedReceiver<String>,
    on_event: &impl Fn(LinkEvent),
) -> SshError {
    loop {
        tokio::select! {
            line = hub.next_line() => match line {
                Ok(line) => on_event(LinkEvent::Line(line)),
                Err(error) => return error,
            },
            Some(line) = queue.recv() => {
                if let Err(error) = hub.send(&line).await {
                    return error;
                }
            }
        }
    }
}

async fn supervise(
    login: Login,
    mut hub: HubChannel,
    mut queue: mpsc::UnboundedReceiver<String>,
    current: watch::Sender<Option<Arc<Connection>>>,
    on_event: impl Fn(LinkEvent),
) {
    let mut attempt = 0;
    loop {
        let mut error = match confirm(&mut hub).await {
            Ok(first) => {
                attempt = 0;
                on_event(LinkEvent::Status(Status::Connected));
                if let Some(line) = first {
                    on_event(LinkEvent::Line(line));
                }
                relay(&mut hub, &mut queue, &on_event).await
            }
            Err(error) => error,
        };
        current.send_replace(None);
        hub = loop {
            attempt += 1;
            on_event(LinkEvent::Status(Status::Reconnecting {
                attempt,
                error: error.to_string(),
            }));
            tokio::time::sleep(backoff(attempt)).await;
            match login.open().await {
                Ok((connection, hub)) => {
                    while queue.try_recv().is_ok() {}
                    current.send_replace(Some(connection));
                    break hub;
                }
                Err(retry @ (SshError::Io(_) | SshError::Closed(_))) => error = retry,
                Err(fatal) => {
                    on_event(LinkEvent::Status(Status::Failed {
                        error: fatal.to_string(),
                    }));
                    return;
                }
            }
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_wait_one_two_four_eight_and_then_fifteen_seconds() {
        let waits: Vec<u64> = (1..=7).map(|attempt| backoff(attempt).as_secs()).collect();
        assert_eq!(waits, [1, 2, 4, 8, 15, 15, 15]);
    }
}
