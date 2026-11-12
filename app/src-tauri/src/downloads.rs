#[cfg(desktop)]
use std::fs::File;
use std::fs::{self, OpenOptions};
#[cfg(desktop)]
use std::io::Read;
use std::io::{self, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime};

const PARTS: &str = "downloads";
const PART_LIFETIME: Duration = Duration::from_secs(3600);
#[cfg(desktop)]
const PROGRAM_TYPES: [&str; 17] = [
    "exe", "msi", "msix", "appx", "bat", "cmd", "com", "scr", "ps1", "vbs", "js", "jse", "wsf", "hta", "lnk", "reg", "cpl",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum How {
    Opened,
    Revealed,
    NoApp,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedFile {
    pub folder: String,
    pub name: String,
    pub how: How,
}

#[tauri::command]
pub async fn file_write(app: AppHandle, token: String, offset: u64, data: String) -> Result<(), String> {
    let dir = parts_dir(&app)?;
    let token = Token::parse(&token)?;
    blocking(move || write_piece(&dir, &token, offset, &data)).await
}

#[tauri::command]
pub async fn file_finish(app: AppHandle, token: String, name: String, size: u64) -> Result<SavedFile, String> {
    let dir = parts_dir(&app)?;
    let part = Token::parse(&token)?.part_in(&dir);
    blocking(move || {
        let saved = truncate_to_size(&part, size).and_then(|()| save_and_open(&app, &part, &safe_name(&name)));
        let _ = fs::remove_file(&part);
        saved
    })
    .await
}

fn parts_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|error| error.to_string())?.join(PARTS);
    fs::create_dir_all(&dir).map_err(|error| format!("The app could not make its download folder: {error}"))?;
    Ok(dir)
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|error| error.to_string())?
}

fn write_piece(dir: &Path, token: &Token, offset: u64, data: &str) -> Result<(), String> {
    let part = token.part_in(dir);
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|error| format!("A piece of the file was not base64: {error}"))?;
    if offset == 0 {
        prune_parts(dir, PART_LIFETIME);
    }
    let write = || -> io::Result<()> {
        let mut file = OpenOptions::new().create(true).write(true).truncate(false).open(&part)?;
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(&bytes)
    };
    write().map_err(|error| format!("Writing the file on this device failed: {error}"))
}

struct Token(String);

impl Token {
    fn parse(token: &str) -> Result<Token, String> {
        let groups: Vec<&str> = token.split('-').collect();
        let uuid = groups.iter().map(|group| group.len()).eq([8, 4, 4, 4, 12]) && groups.iter().all(|group| group.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')));
        if !uuid {
            return Err(format!("{token:?} is not a download token."));
        }
        Ok(Token(token.to_owned()))
    }

    fn part_in(&self, dir: &Path) -> PathBuf {
        dir.join(format!("{}.part", self.0))
    }
}

fn prune_parts(dir: &Path, older_than: Duration) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let old = entry.metadata().and_then(|metadata| metadata.modified()).is_ok_and(|modified| SystemTime::now().duration_since(modified).is_ok_and(|age| age > older_than));
        if old && entry.path().extension().is_some_and(|extension| extension == "part") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn truncate_to_size(part: &Path, size: u64) -> Result<(), String> {
    let file = OpenOptions::new().create(true).truncate(false).write(true).open(part).map_err(|error| format!("Reading the downloaded file failed: {error}"))?;
    let len = file.metadata().map_err(|error| error.to_string())?.len();
    if len < size {
        return Err(format!("Only {len} of {size} bytes arrived."));
    }
    file.set_len(size).map_err(|error| format!("Writing the file on this device failed: {error}"))
}

/// Windows refuses <>:"|?* and trailing dots and spaces in a name, and reserves CON, PRN, AUX, NUL, COM1 to COM9 and LPT1 to LPT9 with any extension.
pub fn safe_name(name: &str) -> String {
    const MAX: usize = 200;
    let replaced: String = name.chars().map(|c| if c.is_control() || "/\\<>:\"|?*".contains(c) { '_' } else { c }).collect();
    let mut name = replaced.trim_end_matches(['.', ' ']).to_string();
    if name.len() > MAX {
        let (stem, extension) = split_extension(&name);
        name = if extension.len() < MAX / 2 { format!("{}{extension}", prefix(stem, MAX - extension.len())) } else { prefix(&name, MAX).trim_end_matches(['.', ' ']).to_string() };
    }
    if name.is_empty() {
        return "file".into();
    }
    let device = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL") || ((device.starts_with("COM") || device.starts_with("LPT")) && device.len() == 4 && matches!(device.as_bytes()[3], b'1'..=b'9'));
    if reserved { format!("_{name}") } else { name }
}

fn prefix(text: &str, max: usize) -> &str {
    let mut end = max.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(at) if at > 0 => name.split_at(at),
        _ => (name, ""),
    }
}

#[cfg(desktop)]
fn numbered(name: &str, n: u32) -> String {
    if n == 0 {
        return name.to_string();
    }
    let (stem, extension) = split_extension(name);
    format!("{stem} ({n}){extension}")
}

/// Windows takes ".exe" as a name with the extension exe, so the leading dot counts here, unlike in split_extension.
#[cfg(desktop)]
fn is_program(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(_, extension)| PROGRAM_TYPES.contains(&extension.to_ascii_lowercase().as_str()))
}

#[cfg(desktop)]
trait Opener {
    fn open(&self, path: &Path) -> Result<(), String>;
    fn reveal(&self, path: &Path) -> Result<(), String>;
}

#[cfg(desktop)]
fn save_into(dir: &Path, part: &Path, name: &str, opener: &impl Opener) -> Result<SavedFile, String> {
    let folder = dir.file_name().map_or_else(|| dir.display().to_string(), |name| name.to_string_lossy().into_owned());
    let path = place_or_reuse_same_bytes(dir, part, name).map_err(|error| format!("Saving {name} to {folder} failed: {error}"))?;
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let how = if is_program(&name) {
        opener.reveal(&path).map_err(|error| format!("Saved {name} to {folder}, but showing it in its folder failed: {error}"))?;
        How::Revealed
    } else {
        opener.open(&path).map_err(|error| format!("Saved {name} to {folder}, but opening it failed: {error}"))?;
        How::Opened
    };
    Ok(SavedFile { folder, name, how })
}

#[cfg(desktop)]
fn place_or_reuse_same_bytes(dir: &Path, part: &Path, name: &str) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let mut source = File::open(part)?;
    for n in 0..1000 {
        let path = dir.join(numbered(name, n));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let copied = io::copy(&mut source, &mut file).and_then(|_| file.sync_all());
                drop(file);
                if let Err(error) = copied {
                    let _ = fs::remove_file(&path);
                    return Err(error);
                }
                mark_from_internet(&path);
                return Ok(path);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if same_bytes(&path, part).unwrap_or(false) {
                    return Ok(path);
                }
            }
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::other(format!("{name} and 999 numbered names after it are taken")))
}

#[cfg(desktop)]
fn same_bytes(a: &Path, b: &Path) -> io::Result<bool> {
    let (mut a, mut b) = (File::open(a)?, File::open(b)?);
    if a.metadata()?.len() != b.metadata()?.len() {
        return Ok(false);
    }
    let (mut left, mut right) = (vec![0; 64 * 1024], vec![0; 64 * 1024]);
    loop {
        let read = a.read(&mut left)?;
        if read == 0 {
            return Ok(true);
        }
        b.read_exact(&mut right[..read])?;
        if left[..read] != right[..read] {
            return Ok(false);
        }
    }
}

/// The opener's open_path is outside the opener's JS scope, so it needs no capability. A file no app takes makes Windows ask which app to use, so it counts as opened.
#[cfg(desktop)]
fn save_and_open<R: Runtime>(app: &AppHandle<R>, part: &Path, name: &str) -> Result<SavedFile, String> {
    let dir = app.path().download_dir().map_err(|error| error.to_string())?;
    save_into(&dir, part, name, &SystemOpener(app))
}

#[cfg(desktop)]
struct SystemOpener<'a, R: Runtime>(&'a AppHandle<R>);

#[cfg(desktop)]
impl<R: Runtime> Opener for SystemOpener<'_, R> {
    fn open(&self, path: &Path) -> Result<(), String> {
        use tauri_plugin_opener::OpenerExt;
        self.0.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|error| error.to_string())
    }
    fn reveal(&self, path: &Path) -> Result<(), String> {
        use tauri_plugin_opener::OpenerExt;
        self.0.opener().reveal_item_in_dir(path).map_err(|error| error.to_string())
    }
}

/// Windows marks a browser's downloads with a Zone.Identifier stream, which makes Office open them in Protected View and SmartScreen check a program before it runs, so a saved file gets the same mark.
#[cfg(windows)]
fn mark_from_internet(path: &Path) {
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    if let Err(error) = fs::write(&stream, "[ZoneTransfer]\r\nZoneId=3\r\n") {
        log::warn!("marking {} as downloaded failed: {error}", path.display());
    }
}

#[cfg(all(desktop, not(windows)))]
fn mark_from_internet(_path: &Path) {}

#[cfg(target_os = "android")]
fn save_and_open<R: Runtime>(app: &AppHandle<R>, part: &Path, name: &str) -> Result<SavedFile, String> {
    #[derive(Serialize)]
    struct Args<'a> {
        path: String,
        name: &'a str,
    }
    let plugin = app.try_state::<Downloads<R>>().ok_or("Saving files is not ready yet.")?;
    plugin
        .0
        .run_mobile_plugin::<SavedFile>("saveAndOpen", Args { path: part.to_string_lossy().into_owned(), name })
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
struct Downloads<R: Runtime>(tauri::plugin::PluginHandle<R>);

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("downloads")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _app.manage(Downloads(_api.register_android_plugin("com.orfoni.app", "DownloadsPlugin")?));
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Recorded(RefCell<Vec<String>>);

    impl Opener for Recorded {
        fn open(&self, path: &Path) -> Result<(), String> {
            self.0.borrow_mut().push(format!("open {}", path.file_name().unwrap().to_string_lossy()));
            Ok(())
        }
        fn reveal(&self, path: &Path) -> Result<(), String> {
            self.0.borrow_mut().push(format!("reveal {}", path.file_name().unwrap().to_string_lossy()));
            Ok(())
        }
    }

    const TOKEN: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

    fn token() -> Token {
        Token::parse(TOKEN).unwrap()
    }

    fn encode(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn part_with(dir: &Path, bytes: &[u8]) -> PathBuf {
        let part = dir.join("x.part");
        fs::write(&part, bytes).unwrap();
        part
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[test]
    fn pieces_written_out_of_order_and_twice_give_the_whole_file() {
        let dir = tempfile::tempdir().unwrap();

        write_piece(dir.path(), &token(), 6, &encode(b"world")).unwrap();
        write_piece(dir.path(), &token(), 0, &encode(b"hello ")).unwrap();
        write_piece(dir.path(), &token(), 6, &encode(b"world")).unwrap();
        let part = token().part_in(dir.path());
        truncate_to_size(&part, 11).unwrap();

        assert_eq!(fs::read(&part).unwrap(), b"hello world");
    }

    #[test]
    fn a_piece_that_is_not_base64_is_refused() {
        let dir = tempfile::tempdir().unwrap();

        assert!(write_piece(dir.path(), &token(), 0, "not base64!").is_err());
    }

    #[test]
    fn finishing_cuts_a_longer_part_and_refuses_a_short_one() {
        let dir = tempfile::tempdir().unwrap();
        let part = part_with(dir.path(), b"hello world, again");

        truncate_to_size(&part, 11).unwrap();
        assert_eq!(fs::read(&part).unwrap(), b"hello world");
        assert!(truncate_to_size(&part, 12).is_err());
    }

    #[test]
    fn an_empty_file_finishes_without_any_piece() {
        let dir = tempfile::tempdir().unwrap();
        let part = token().part_in(dir.path());

        truncate_to_size(&part, 0).unwrap();

        assert_eq!(fs::read(&part).unwrap(), b"");
    }

    #[test]
    fn a_token_that_is_not_a_lowercase_uuid_names_no_part() {
        let dir = tempfile::tempdir().unwrap();

        assert_eq!(token().part_in(dir.path()), dir.path().join(format!("{TOKEN}.part")));
        for token in ["", "../x", "0F8FAD5B-D9CB-469F-A165-70867728950E", "0f8fad5b-d9cb-469f-a165-70867728950", "0f8fad5b/d9cb-469f-a165-70867728950e"] {
            assert!(Token::parse(token).is_err(), "{token:?}");
        }
    }

    #[test]
    fn a_new_download_removes_parts_left_over_an_hour_ago() {
        let dir = tempfile::tempdir().unwrap();
        let old = part_with(dir.path(), b"old");
        File::options().write(true).open(&old).unwrap().set_modified(SystemTime::now() - Duration::from_secs(7200)).unwrap();
        let other = "1f8fad5b-d9cb-469f-a165-70867728950e";
        write_piece(dir.path(), &Token::parse(other).unwrap(), 0, &encode(b"fresh")).unwrap();

        write_piece(dir.path(), &token(), 0, &encode(b"new")).unwrap();

        assert_eq!(names(dir.path()), [format!("{TOKEN}.part"), format!("{other}.part")]);
    }

    #[test]
    fn a_name_becomes_one_every_platform_takes() {
        assert_eq!(safe_name("a/b\\c:d.txt"), "a_b_c_d.txt");
        assert_eq!(safe_name("what?<now>|\"*.md"), "what__now____.md");
        assert_eq!(safe_name("tab\there\n.txt"), "tab_here_.txt");
        assert_eq!(safe_name("report. "), "report");
        assert_eq!(safe_name("CON.txt"), "_CON.txt");
        assert_eq!(safe_name("lpt9"), "_lpt9");
        assert_eq!(safe_name("console.txt"), "console.txt");
        assert_eq!(safe_name(""), "file");
        assert_eq!(safe_name(".."), "file");
        assert_eq!(safe_name(".env"), ".env");
        assert_eq!(safe_name("Bericht für Jürgen.pdf"), "Bericht für Jürgen.pdf");
        let long = format!("{}.pdf", "ü".repeat(150));
        let kept = safe_name(&long);
        assert!(kept.len() <= 200, "{}", kept.len());
        assert!(kept.ends_with("ü.pdf"), "{kept}");
    }

    #[test]
    fn a_file_is_saved_under_its_name_and_opened() {
        let downloads = tempfile::tempdir().unwrap();
        let parts = tempfile::tempdir().unwrap();
        let opener = Recorded::default();

        let saved = save_into(downloads.path(), &part_with(parts.path(), b"%PDF"), "report.pdf", &opener).unwrap();

        assert_eq!(saved, SavedFile { folder: downloads.path().file_name().unwrap().to_string_lossy().into_owned(), name: "report.pdf".into(), how: How::Opened });
        assert_eq!(fs::read(downloads.path().join("report.pdf")).unwrap(), b"%PDF");
        assert_eq!(*opener.0.borrow(), ["open report.pdf"]);
    }

    #[test]
    fn a_taken_name_with_other_bytes_gets_a_number() {
        let downloads = tempfile::tempdir().unwrap();
        let parts = tempfile::tempdir().unwrap();
        fs::write(downloads.path().join("report.pdf"), b"older").unwrap();
        fs::write(downloads.path().join(".env"), b"A=1").unwrap();
        let opener = Recorded::default();

        let first = save_into(downloads.path(), &part_with(parts.path(), b"newer"), "report.pdf", &opener).unwrap();
        let second = save_into(downloads.path(), &part_with(parts.path(), b"newest"), "report.pdf", &opener).unwrap();
        let env = save_into(downloads.path(), &part_with(parts.path(), b"A=2"), ".env", &opener).unwrap();

        assert_eq!((first.name.as_str(), second.name.as_str(), env.name.as_str()), ("report (1).pdf", "report (2).pdf", ".env (1)"));
        assert_eq!(fs::read(downloads.path().join("report.pdf")).unwrap(), b"older");
        assert_eq!(fs::read(downloads.path().join("report (2).pdf")).unwrap(), b"newest");
        assert_eq!(*opener.0.borrow(), ["open report (1).pdf", "open report (2).pdf", "open .env (1)"]);
    }

    #[test]
    fn the_same_bytes_again_open_the_file_already_saved() {
        let downloads = tempfile::tempdir().unwrap();
        let parts = tempfile::tempdir().unwrap();
        fs::write(downloads.path().join("report.pdf"), b"older").unwrap();
        let opener = Recorded::default();

        save_into(downloads.path(), &part_with(parts.path(), b"newer"), "report.pdf", &opener).unwrap();
        let again = save_into(downloads.path(), &part_with(parts.path(), b"newer"), "report.pdf", &opener).unwrap();

        assert_eq!(again.name, "report (1).pdf");
        assert_eq!(names(downloads.path()), ["report (1).pdf", "report.pdf"]);
        assert_eq!(*opener.0.borrow(), ["open report (1).pdf", "open report (1).pdf"]);
    }

    #[test]
    fn a_program_is_shown_in_its_folder_and_not_run() {
        let downloads = tempfile::tempdir().unwrap();
        let parts = tempfile::tempdir().unwrap();
        let opener = Recorded::default();

        let saved = save_into(downloads.path(), &part_with(parts.path(), b"MZ"), "Setup.EXE", &opener).unwrap();
        let script = save_into(downloads.path(), &part_with(parts.path(), b"echo"), "build.cmd", &opener).unwrap();

        assert_eq!((saved.how, script.how), (How::Revealed, How::Revealed));
        assert_eq!(fs::read(downloads.path().join("Setup.EXE")).unwrap(), b"MZ");
        assert_eq!(*opener.0.borrow(), ["reveal Setup.EXE", "reveal build.cmd"]);
    }

    #[test]
    fn only_program_types_count_as_programs() {
        for name in ["a.exe", "a.MSI", "report.pdf.exe", "x.ps1", "x.lnk", "x.js", ".exe"] {
            assert!(is_program(name), "{name}");
        }
        for name in ["report.pdf", "exe", "a.exe.txt", "notes.md", "app.json"] {
            assert!(!is_program(name), "{name}");
        }
    }

    #[test]
    fn the_saved_answer_reads_as_device_files_expects() {
        let saved = SavedFile { folder: "Download/orfoni".into(), name: "a.pdf".into(), how: How::NoApp };

        assert_eq!(serde_json::to_string(&saved).unwrap(), r#"{"folder":"Download/orfoni","name":"a.pdf","how":"noApp"}"#);
    }
}
