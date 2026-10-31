#![cfg(unix)]

mod sshd;

use std::fs;
use std::os::unix::fs::PermissionsExt;

use orfoni_lib::keys::{self, KeyError};
use orfoni_lib::ssh::Connection;
use sshd::PrivateSshd;

fn mode(path: &str) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

// The public half without its comment, as an authorized_keys line names the key.
fn key_part(public_key: &str) -> String {
    public_key.split(' ').take(2).collect::<Vec<_>>().join(" ")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_key_made_on_the_device_logs_in_once_its_public_half_is_authorized() {
    let sshd = PrivateSshd::start();
    let dir = tempfile::tempdir().unwrap();

    let key = keys::create(dir.path(), "orfoni-android", false).unwrap();

    assert!(key.public_key.starts_with("ssh-ed25519 "), "{}", key.public_key);
    assert!(key.public_key.ends_with(" orfoni-android"), "{}", key.public_key);
    assert!(key.fingerprint.starts_with("SHA256:"), "{}", key.fingerprint);
    assert_eq!(mode(&key.path), 0o600);
    let mut settings = sshd.settings("cat");
    settings.key_path = key.path.clone();
    let known_hosts = sshd.known_hosts();
    assert!(Connection::connect(&settings, None, &known_hosts).await.is_err());
    sshd.authorize(&key.public_key);
    Connection::connect(&settings, None, &known_hosts)
        .await
        .expect("the authorized key logs in");
}

#[test]
fn the_key_is_there_to_show_again_and_a_second_one_replaces_it_only_when_asked() {
    let dir = tempfile::tempdir().unwrap();
    assert!(keys::info(dir.path()).unwrap().is_none());

    let first = keys::create(dir.path(), "orfoni-android", false).unwrap();

    assert_eq!(keys::info(dir.path()).unwrap(), Some(first.clone()));
    assert!(matches!(keys::create(dir.path(), "orfoni-android", false), Err(KeyError::Exists)));
    let second = keys::create(dir.path(), "orfoni-android", true).unwrap();
    assert_ne!(second.public_key, first.public_key);
    assert_eq!(keys::info(dir.path()).unwrap(), Some(second));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_imported_key_is_kept_for_the_app_and_logs_in() {
    let sshd = PrivateSshd::start();
    let dir = tempfile::tempdir().unwrap();
    let text = fs::read_to_string(sshd.path("client_key")).unwrap();

    let key = keys::import(dir.path(), &text, false).unwrap();

    assert_eq!(key_part(&key.public_key), key_part(&fs::read_to_string(sshd.path("client_key.pub")).unwrap()));
    assert_eq!(fs::read_to_string(&key.path).unwrap(), text);
    assert_eq!(mode(&key.path), 0o600);
    let mut settings = sshd.settings("cat");
    settings.key_path = key.path.clone();
    Connection::connect(&settings, None, &sshd.known_hosts())
        .await
        .expect("the imported key logs in");
}

#[test]
fn an_encrypted_key_imports_and_shows_its_public_half_without_the_passphrase() {
    let sshd = PrivateSshd::start();
    let dir = tempfile::tempdir().unwrap();
    let encrypted = sshd.encrypted_key("correct horse");

    let key = keys::import(dir.path(), &fs::read_to_string(&encrypted).unwrap(), false).unwrap();

    assert_eq!(key_part(&key.public_key), key_part(&fs::read_to_string(format!("{encrypted}.pub")).unwrap()));
}

#[test]
fn text_that_is_not_an_openssh_private_key_is_refused_and_kept_nowhere() {
    let dir = tempfile::tempdir().unwrap();
    let putty = "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: laptop\n";

    let refused = keys::import(dir.path(), putty, false);

    assert!(matches!(refused, Err(KeyError::NotOpenSsh(_))), "{refused:?}");
    assert!(keys::info(dir.path()).unwrap().is_none());
}
