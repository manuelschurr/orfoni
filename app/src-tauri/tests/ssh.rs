#![cfg(unix)]

mod sshd;

use std::time::Duration;

use orfoni_lib::known_hosts::KnownHosts;
use orfoni_lib::link::{HubLink, LinkEvent, Status};
use orfoni_lib::ssh::{Connection, SshError};
use orfoni_lib::terminal::TerminalChannel;
use sshd::PrivateSshd;
use tokio::sync::mpsc;
use tokio::time::timeout;

const WAIT: Duration = Duration::from_secs(10);
// The `cat` hub echoes the request the link sends to learn that the hub runs.
const PROBE: &str = r#"{"id":0,"method":"listSessions"}"#;

async fn trusted(sshd: &PrivateSshd) -> KnownHosts {
    let mut known_hosts = KnownHosts::load(&sshd.path("known-hosts.json")).unwrap();
    known_hosts
        .trust("127.0.0.1", sshd.port, &sshd.host_fingerprint())
        .unwrap();
    known_hosts
}

async fn next(events: &mut mpsc::UnboundedReceiver<LinkEvent>) -> LinkEvent {
    timeout(WAIT, events.recv())
        .await
        .expect("no link event in time")
        .expect("the link stopped sending events")
}

async fn read_until(terminal: &mut TerminalChannel, needle: &str) -> String {
    let mut seen = Vec::new();
    timeout(WAIT, async {
        while let Some(chunk) = terminal.output.recv().await {
            seen.extend_from_slice(&chunk);
            if String::from_utf8_lossy(&seen).contains(needle) {
                return;
            }
        }
        panic!(
            "terminal ended before {needle:?}: {}",
            String::from_utf8_lossy(&seen)
        );
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "no {needle:?} within {WAIT:?}: {}",
            String::from_utf8_lossy(&seen)
        )
    });
    String::from_utf8_lossy(&seen).into_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_first_connection_to_a_new_host_asks_to_trust_its_key() {
    let sshd = PrivateSshd::start();
    let path = sshd.path("known-hosts.json");
    let mut known_hosts = KnownHosts::load(&path).unwrap();

    let result = Connection::connect(&sshd.settings("cat"), None, &known_hosts).await;
    match result {
        Err(SshError::HostKeyUnknown { fingerprint }) => {
            assert_eq!(fingerprint, sshd.host_fingerprint())
        }
        other => panic!("expected HostKeyUnknown, got {:?}", other.err()),
    }

    known_hosts
        .trust("127.0.0.1", sshd.port, &sshd.host_fingerprint())
        .unwrap();
    let reloaded = KnownHosts::load(&path).unwrap();
    Connection::connect(&sshd.settings("cat"), None, &reloaded)
        .await
        .expect("connects once the fingerprint is stored");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_changed_host_key_is_refused_before_the_key_is_offered() {
    let mut sshd = PrivateSshd::start();
    let known_hosts = trusted(&sshd).await;
    let old = sshd.host_fingerprint();

    sshd.replace_host_key();
    let result = Connection::connect(&sshd.settings("cat"), None, &known_hosts).await;

    match result {
        Err(SshError::HostKeyChanged { expected, found }) => {
            assert_eq!(expected, old);
            assert_eq!(found, sshd.host_fingerprint());
            assert_ne!(expected, found);
        }
        other => panic!("expected HostKeyChanged, got {:?}", other.err()),
    }
    let log = sshd.log();
    assert!(
        !log.contains("publickey"),
        "the client offered its key to a host with a changed key:\n{log}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn trusting_a_different_key_for_a_known_host_is_refused() {
    let sshd = PrivateSshd::start();
    let mut known_hosts = trusted(&sshd).await;

    let result = known_hosts.trust("127.0.0.1", sshd.port, "SHA256:somethingelse");

    assert!(matches!(result, Err(SshError::HostKeyChanged { .. })));
    let reloaded = KnownHosts::load(&sshd.path("known-hosts.json")).unwrap();
    assert_eq!(
        reloaded.fingerprint("127.0.0.1", sshd.port),
        Some(sshd.host_fingerprint().as_str())
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_encrypted_key_needs_the_right_passphrase() {
    let sshd = PrivateSshd::start();
    let known_hosts = trusted(&sshd).await;
    let mut settings = sshd.settings("cat");
    settings.key_path = sshd.encrypted_key("secret phrase");

    let without = Connection::connect(&settings, None, &known_hosts).await;
    assert!(matches!(without, Err(SshError::PassphraseNeeded)));
    let wrong = Connection::connect(&settings, Some("wrong"), &known_hosts).await;
    assert!(matches!(wrong, Err(SshError::PassphraseNeeded)));
    Connection::connect(&settings, Some("secret phrase"), &known_hosts)
        .await
        .expect("connects with the right passphrase");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_key_the_server_does_not_know_fails_authentication() {
    let sshd = PrivateSshd::start();
    let known_hosts = trusted(&sshd).await;
    let mut settings = sshd.settings("cat");
    settings.key_path = sshd.unknown_key();

    let result = Connection::connect(&settings, None, &known_hosts).await;

    assert!(matches!(result, Err(SshError::AuthFailed)));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_hub_channel_relays_lines_both_ways() {
    let sshd = PrivateSshd::start();
    let known_hosts = trusted(&sshd).await;
    let connection = Connection::connect(&sshd.settings("cat"), None, &known_hosts)
        .await
        .unwrap();
    let mut hub = connection.open_hub().await.unwrap();

    hub.send(r#"{"id":1,"method":"listSessions"}"#)
        .await
        .unwrap();
    hub.send("second").await.unwrap();

    let first = timeout(WAIT, hub.next_line()).await.unwrap().unwrap();
    let second = timeout(WAIT, hub.next_line()).await.unwrap().unwrap();
    assert_eq!(first, r#"{"id":1,"method":"listSessions"}"#);
    assert_eq!(second, "second");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_line_written_in_pieces_arrives_whole() {
    let sshd = PrivateSshd::start();
    let known_hosts = trusted(&sshd).await;
    let command = r#"printf '{"type":'; sleep 0.3; printf '"päuse"}\n'; sleep 5"#;
    let connection = Connection::connect(&sshd.settings(command), None, &known_hosts)
        .await
        .unwrap();
    let mut hub = connection.open_hub().await.unwrap();

    let line = timeout(WAIT, hub.next_line()).await.unwrap().unwrap();

    assert_eq!(line, r#"{"type":"päuse"}"#);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hub_command_that_fails_ends_the_stream_with_its_error() {
    let sshd = PrivateSshd::start();
    let known_hosts = trusted(&sshd).await;
    let command = "echo 'orfoni-hub connect: connect ENOENT' >&2; exit 1";
    let connection = Connection::connect(&sshd.settings(command), None, &known_hosts)
        .await
        .unwrap();
    let mut hub = connection.open_hub().await.unwrap();

    let result = timeout(WAIT, hub.next_line()).await.unwrap();

    match result {
        Err(error @ SshError::Closed(_)) => {
            assert!(error.to_string().contains("connect ENOENT"), "{error}")
        }
        other => panic!("expected Closed, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn killing_the_sshd_ends_the_hub_stream_with_closed() {
    let mut sshd = PrivateSshd::start();
    let known_hosts = trusted(&sshd).await;
    let connection = Connection::connect(&sshd.settings("cat"), None, &known_hosts)
        .await
        .unwrap();
    let mut hub = connection.open_hub().await.unwrap();
    hub.send("alive").await.unwrap();
    assert_eq!(
        timeout(WAIT, hub.next_line()).await.unwrap().unwrap(),
        "alive"
    );

    sshd.stop();
    let result = timeout(WAIT, hub.next_line()).await.unwrap();

    assert!(
        matches!(result, Err(SshError::Closed(_))),
        "expected Closed, got {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_terminal_attaches_to_the_tmux_session_and_follows_resizes() {
    let sshd = PrivateSshd::start();
    let tmux = sshd.tmux_session("orfoni-term", "sh");
    let known_hosts = trusted(&sshd).await;
    let connection = Connection::connect(&sshd.settings("cat"), None, &known_hosts)
        .await
        .unwrap();

    let mut terminal = connection
        .open_terminal("orfoni-term", 100, 30)
        .await
        .unwrap();
    assert_eq!(tmux.client_size_eventually("100x30"), "100x30");
    terminal.input.write(b"echo term-$((6*7))\r".to_vec());
    read_until(&mut terminal, "term-42").await;

    terminal.input.resize(120, 40);
    assert_eq!(tmux.client_size_eventually("120x40"), "120x40");

    terminal.input.close();
    let rest = timeout(WAIT, async {
        while terminal.output.recv().await.is_some() {}
    })
    .await;
    assert!(rest.is_ok(), "the terminal stream did not end after close");
    assert_eq!(
        tmux.client_size_eventually(""),
        "",
        "the tmux client is still attached"
    );
    assert!(tmux.has_session(), "closing the terminal must only detach");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dropped_link_reconnects_with_backoff_and_relays_again() {
    let mut sshd = PrivateSshd::start();
    let known_hosts = trusted(&sshd).await;
    let (tx, mut events) = mpsc::unbounded_channel();
    let link = HubLink::start(sshd.settings("cat"), None, known_hosts, move |event| {
        let _ = tx.send(event);
    })
    .await
    .unwrap();
    assert_eq!(
        next(&mut events).await,
        LinkEvent::Status(Status::Connecting)
    );
    assert_eq!(
        next(&mut events).await,
        LinkEvent::Status(Status::Connected)
    );
    assert_eq!(next(&mut events).await, LinkEvent::Line(PROBE.into()));
    link.send("before".into()).unwrap();
    assert_eq!(next(&mut events).await, LinkEvent::Line("before".into()));

    sshd.stop();
    match next(&mut events).await {
        LinkEvent::Status(Status::Reconnecting { attempt: 1, .. }) => {}
        other => panic!("expected the first reconnect attempt, got {other:?}"),
    }
    assert!(link.send("lost".into()).is_err());
    match next(&mut events).await {
        LinkEvent::Status(Status::Reconnecting { attempt: 2, error }) => {
            assert!(!error.is_empty())
        }
        other => panic!("expected the second reconnect attempt, got {other:?}"),
    }
    sshd.restart();
    assert_eq!(
        next(&mut events).await,
        LinkEvent::Status(Status::Connected)
    );
    assert_eq!(next(&mut events).await, LinkEvent::Line(PROBE.into()));

    link.send("after".into()).unwrap();
    assert_eq!(next(&mut events).await, LinkEvent::Line("after".into()));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_changed_host_key_during_a_reconnect_fails_the_link() {
    let mut sshd = PrivateSshd::start();
    let known_hosts = trusted(&sshd).await;
    let (tx, mut events) = mpsc::unbounded_channel();
    let _link = HubLink::start(sshd.settings("cat"), None, known_hosts, move |event| {
        let _ = tx.send(event);
    })
    .await
    .unwrap();

    sshd.replace_host_key();
    let failed = timeout(Duration::from_secs(20), async {
        loop {
            match events.recv().await {
                Some(LinkEvent::Status(Status::Failed { error })) => return error,
                Some(_) => continue,
                None => panic!("the link ended without reporting a failure"),
            }
        }
    })
    .await
    .unwrap();

    assert!(failed.contains(&sshd.host_fingerprint()), "{failed}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hub_that_exits_at_once_is_never_reported_connected_and_backs_off() {
    let sshd = PrivateSshd::start();
    let known_hosts = trusted(&sshd).await;
    let (tx, mut events) = mpsc::unbounded_channel();
    let _link = HubLink::start(sshd.settings("exit 1"), None, known_hosts, move |event| {
        let _ = tx.send(event);
    })
    .await
    .unwrap();

    let mut statuses = Vec::new();
    let _ = timeout(Duration::from_millis(5500), async {
        while let Some(event) = events.recv().await {
            if let LinkEvent::Status(status) = event {
                statuses.push(status);
            }
        }
    })
    .await;

    let shown: Vec<String> = statuses
        .iter()
        .map(|status| match status {
            Status::Reconnecting { attempt, .. } => format!("reconnecting {attempt}"),
            other => format!("{other:?}"),
        })
        .collect();
    assert_eq!(
        shown,
        [
            "Connecting",
            "reconnecting 1",
            "reconnecting 2",
            "reconnecting 3"
        ]
    );
    let logins = sshd.log().matches("Accepted publickey").count();
    assert_eq!(logins, 3, "{}", sshd.log());
}
