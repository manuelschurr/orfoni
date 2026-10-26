use std::collections::HashMap;
use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

use orfoni_lib::settings::Settings;
use tempfile::TempDir;

pub struct PrivateSshd {
    dir: TempDir,
    pub port: u16,
    child: Option<Child>,
}

fn run(program: &str, args: &[&str]) -> String {
    let output = Command::new(program)
        .args(args)
        .env_remove("TMUX")
        .output()
        .unwrap_or_else(|error| panic!("{program}: {error}"));
    assert!(
        output.status.success(),
        "{program} {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn keygen(path: &Path, passphrase: &str) {
    let _ = fs::remove_file(path);
    let _ = fs::remove_file(path.with_extension("pub"));
    run(
        "ssh-keygen",
        &[
            "-q",
            "-t",
            "ed25519",
            "-N",
            passphrase,
            "-f",
            path.to_str().unwrap(),
        ],
    );
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn descendants(root: u32) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for entry in fs::read_dir("/proc").unwrap().flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(stat) = fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let after_name = &stat[stat.rfind(')').unwrap() + 2..];
        let ppid: u32 = after_name.split(' ').nth(1).unwrap().parse().unwrap();
        children.entry(ppid).or_default().push(pid);
    }
    let mut found = Vec::new();
    let mut queue = vec![root];
    while let Some(pid) = queue.pop() {
        for &child in children.get(&pid).into_iter().flatten() {
            found.push(child);
            queue.push(child);
        }
    }
    found
}

impl PrivateSshd {
    pub fn start() -> PrivateSshd {
        let dir = tempfile::Builder::new()
            .prefix("orfoni-sshd-")
            .tempdir_in("/tmp")
            .unwrap();
        let path = |name: &str| dir.path().join(name);
        keygen(&path("host_key"), "");
        keygen(&path("client_key"), "");
        fs::copy(path("client_key.pub"), path("authorized_keys")).unwrap();
        let port = free_port();
        let config = format!(
            "Port {port}\n\
             ListenAddress 127.0.0.1\n\
             HostKey {host_key}\n\
             AuthorizedKeysFile {authorized_keys}\n\
             PidFile {pid}\n\
             PasswordAuthentication no\n\
             KbdInteractiveAuthentication no\n\
             PermitRootLogin prohibit-password\n\
             UsePAM yes\n\
             StrictModes no\n\
             LogLevel VERBOSE\n\
             SetEnv TMUX_TMPDIR={tmux_tmpdir}\n",
            host_key = path("host_key").display(),
            authorized_keys = path("authorized_keys").display(),
            pid = path("sshd.pid").display(),
            tmux_tmpdir = dir.path().display(),
        );
        fs::write(path("sshd_config"), config).unwrap();
        let mut sshd = PrivateSshd {
            dir,
            port,
            child: None,
        };
        sshd.restart();
        sshd
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    pub fn restart(&mut self) {
        assert!(self.child.is_none(), "sshd is already running");
        let log = fs::File::create(self.path("sshd.log")).unwrap();
        let child = Command::new("/usr/sbin/sshd")
            .args(["-D", "-e", "-f"])
            .arg(self.path("sshd_config"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(log)
            .spawn()
            .expect("start sshd");
        self.child = Some(child);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.log().contains("Server listening") {
            assert!(
                Instant::now() < deadline,
                "sshd did not start:\n{}",
                self.log()
            );
            sleep(Duration::from_millis(20));
        }
    }

    pub fn stop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let mut pids: Vec<String> = descendants(child.id())
            .into_iter()
            .map(|pid| pid.to_string())
            .collect();
        pids.push(child.id().to_string());
        let _ = Command::new("kill").arg("-KILL").args(&pids).status();
        let _ = child.wait();
    }

    pub fn replace_host_key(&mut self) {
        self.stop();
        keygen(&self.path("host_key"), "");
        self.restart();
    }

    pub fn log(&self) -> String {
        fs::read_to_string(self.path("sshd.log")).unwrap_or_default()
    }

    pub fn host_fingerprint(&self) -> String {
        let line = run(
            "ssh-keygen",
            &["-lf", self.path("host_key.pub").to_str().unwrap()],
        );
        line.split(' ').nth(1).unwrap().to_string()
    }

    pub fn settings(&self, hub_command: &str) -> Settings {
        Settings {
            host: "127.0.0.1".into(),
            port: self.port,
            user: run("id", &["-un"]).trim().to_string(),
            key_path: self.path("client_key").to_string_lossy().into_owned(),
            hub_command: hub_command.into(),
        }
    }

    pub fn encrypted_key(&self, passphrase: &str) -> String {
        let key = self.path("encrypted_key");
        keygen(&key, passphrase);
        let mut authorized = fs::read_to_string(self.path("authorized_keys")).unwrap();
        authorized.push_str(&fs::read_to_string(key.with_extension("pub")).unwrap());
        fs::write(self.path("authorized_keys"), authorized).unwrap();
        key.to_string_lossy().into_owned()
    }

    pub fn unknown_key(&self) -> String {
        let key = self.path("unknown_key");
        keygen(&key, "");
        key.to_string_lossy().into_owned()
    }

    pub fn tmux_session(&self, name: &str, command: &str) -> PrivateTmux {
        let uid = run("id", &["-u"]).trim().to_string();
        let socket_dir = self.path(&format!("tmux-{uid}"));
        fs::create_dir_all(&socket_dir).unwrap();
        let mut permissions = fs::metadata(&socket_dir).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o700);
        fs::set_permissions(&socket_dir, permissions).unwrap();
        let tmux = PrivateTmux {
            socket: socket_dir.join("orfoni"),
            name: name.into(),
        };
        tmux.run(&[
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            name,
            "-x",
            "80",
            "-y",
            "24",
            command,
        ]);
        tmux
    }
}

impl Drop for PrivateSshd {
    fn drop(&mut self) {
        self.stop();
    }
}

pub struct PrivateTmux {
    socket: PathBuf,
    name: String,
}

impl PrivateTmux {
    fn run(&self, args: &[&str]) -> String {
        let mut all = vec!["-S", self.socket.to_str().unwrap()];
        all.extend_from_slice(args);
        run("tmux", &all)
    }

    pub fn client_size_eventually(&self, expected: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let size = self.run(&["list-clients", "-F", "#{client_width}x#{client_height}"]);
            let size = size.trim().to_string();
            if size == expected || Instant::now() > deadline {
                return size;
            }
            sleep(Duration::from_millis(50));
        }
    }

    pub fn has_session(&self) -> bool {
        Command::new("tmux")
            .arg("-S")
            .arg(&self.socket)
            .args(["has-session", "-t", &format!("={}", self.name)])
            .env_remove("TMUX")
            .status()
            .unwrap()
            .success()
    }
}

impl Drop for PrivateTmux {
    fn drop(&mut self) {
        let _ = Command::new("tmux")
            .arg("-S")
            .arg(&self.socket)
            .arg("kill-server")
            .env_remove("TMUX")
            .status();
    }
}
