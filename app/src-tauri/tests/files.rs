use std::fs;

use orfoni_lib::known_hosts::KnownHosts;
use orfoni_lib::settings::Settings;
use serde_json::json;

#[test]
fn settings_start_with_the_defaults_and_no_host() {
    let dir = tempfile::tempdir().unwrap();

    let settings = Settings::load(&dir.path().join("settings.json")).unwrap();

    assert_eq!(
        serde_json::to_value(&settings).unwrap(),
        json!({
            "host": "",
            "port": 22,
            "user": "root",
            "keyPath": "~/.ssh/id_ed25519",
            "hubCommand": "\"$HOME/.local/bin/orfoni-hub\" connect",
        })
    );
}

#[test]
fn saved_settings_load_back() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app-data").join("settings.json");
    let settings = Settings {
        host: "vps.example".into(),
        port: 2222,
        user: "manuel".into(),
        key_path: "C:\\Users\\manuel\\.ssh\\id_ed25519".into(),
        hub_command: "orfoni-hub connect".into(),
    };

    settings.save(&path).unwrap();

    assert_eq!(Settings::load(&path).unwrap(), settings);
}

#[test]
fn a_settings_file_that_does_not_parse_is_an_error_and_stays_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    fs::write(&path, "{ not json").unwrap();

    assert!(Settings::load(&path).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
}

#[test]
fn a_settings_file_from_a_newer_version_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    fs::write(
        &path,
        r#"{"version":2,"host":"h","port":22,"user":"u","keyPath":"k","hubCommand":"c"}"#,
    )
    .unwrap();

    assert!(Settings::load(&path).is_err());
}

#[test]
fn a_tilde_in_the_key_path_means_the_home_folder() {
    let settings = Settings {
        key_path: "~/.ssh/id_ed25519".into(),
        ..Settings::default()
    };

    assert_eq!(
        settings.key_file(),
        std::env::home_dir().unwrap().join(".ssh/id_ed25519")
    );
}

#[test]
fn known_hosts_are_kept_per_host_and_port() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("known-hosts.json");
    let mut known_hosts = KnownHosts::load(&path).unwrap();

    known_hosts.trust("vps.example", 22, "SHA256:aaa").unwrap();
    known_hosts
        .trust("vps.example", 2222, "SHA256:bbb")
        .unwrap();

    let reloaded = KnownHosts::load(&path).unwrap();
    assert_eq!(reloaded.fingerprint("vps.example", 22), Some("SHA256:aaa"));
    assert_eq!(
        reloaded.fingerprint("vps.example", 2222),
        Some("SHA256:bbb")
    );
    assert_eq!(reloaded.fingerprint("other.example", 22), None);
}

#[test]
fn a_known_hosts_file_that_does_not_parse_is_an_error_and_stays_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("known-hosts.json");
    fs::write(&path, "[]").unwrap();

    assert!(KnownHosts::load(&path).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "[]");
}
