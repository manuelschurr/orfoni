# Over-the-air updates for orfoni

Research of 2026-10-29, for the Android app and later the Windows app. Nothing here is built yet.

## Short answer

orfoni has three layers, and each updates differently.

| Layer | Where it runs | Updates over the air today | How it could |
|---|---|---|---|
| Hub: sessions, hooks, Claude Code integration | the VPS | yes, `hub/scripts/install.sh` | already does |
| UI: Svelte, JavaScript, CSS | inside the app | no, it ships inside the installer | swap the UI files the app serves, on Windows and Android alike |
| Native shell: Rust, Tauri plugins, permissions, Android manifest | the app binary | no | a full app update: Tauri's updater on Windows, an APK update on Android |

Most of orfoni's changes land in the first two layers. Of the 161 commits since the app was scaffolded on 2026-10-26, 16 touched the Rust shell or the Tauri config, and 12 of those came on the first day, while the shell was being built. Since then only 4 did: the release version, one window permission, the notification plugin, and the drop setting. With UI updates over the air, nearly every change after the first install reaches the phone without a reinstall.

## UI updates

Tauri serves the UI from an asset provider compiled into the app, and `tauri::Context::set_assets` (tauri 2.12.5, `src/lib.rs`) replaces that provider at startup. A replacement provider can serve a newer UI bundle from the app's data folder and fall back to the compiled-in files. The page still loads from `tauri://localhost`, so the CSP, the capabilities and local storage stay as they are. Tauri itself offers no such update; its maintainers said in 2023 that a mobile app's frontend changes only with the binary.

Two community plugins do this on Android and desktop, and both are young:

- `tauri-plugin-hotswap` (0.0.4, 16 stars): minisign-signed bundles from any HTTPS host, rollback to the compiled-in UI when the new one never reports ready.
- `tauri-plugin-hot-update` (pre-1.0, 1 star): minisign-signed manifest, sha256 check, a staged, booting and committed pointer for rollback, and a version watermark against downgrades.

For orfoni the natural source of the bundle is the hub. The app already talks to it over an authenticated SSH connection, so the hub can offer the UI built from the same commit as itself. The UI and the hub then always match, which also ends protocol mismatches between them, and `install.sh` updates both at once. What it takes:

- The hub serves the built `app/dist` with its version and hash, through a request over the existing connection.
- The Rust shell stores the bundle, swaps the asset provider at the next start, and falls back to the compiled-in UI when the new one does not report ready.
- Each bundle names the oldest shell it runs on. A bundle that needs a newer shell, for example one that calls a new Tauri plugin, waits until the app itself is updated.

Trust: a bundle from the hub is as trusted as the hub, which already runs everything on the VPS. The bundle's code can call only the Tauri commands the capabilities allow, and the private key never reaches it. Signing the bundle in CI would add protection only against a compromised VPS.

Google Play allows this for a Play app: its Device and Network Abuse policy forbids downloading executable code such as dex, JAR or .so files, but exempts "code that runs in a virtual machine or an interpreter", naming "JavaScript in a webview or browser".

## App updates on Windows

Tauri's official updater plugin supports Windows, Linux and macOS, and not Android or iOS. It downloads the new NSIS installer named in a `latest.json`, which can sit in GitHub releases (`https://github.com/<user>/<repo>/releases/latest/download/latest.json`), checks its minisign signature, which cannot be turned off, and installs it. The default `passive` mode shows a small progress window, needs no clicks, and restarts the app. The work is a signing key pair, with the private key as a GitHub secret, `createUpdaterArtifacts`, writing `latest.json` in the workflow, and a check at start with an update button. The download comes from the app itself, not a browser, so it should not carry the mark of the web that makes SmartScreen ask (inference, not tested).

## App updates on Android

Ways to get a new APK onto the phone, easiest first:

1. **Obtainium** (no code in orfoni). An open-source app that watches GitHub releases and installs their APKs. On Android 12 and later it installs in the background when it installed the current version itself, the app targets a recent API level, and background updates are on; otherwise it notifies and takes a tap. Failed background installs go unreported. orfoni would need only an APK in each release, a version code that only grows, and one signing key forever.
2. **A self-updater in orfoni** (a small Kotlin plugin). The app downloads the new APK, from GitHub or through the hub, and installs it with `PackageInstaller`. Android documents that no user action is needed when the session asks for `USER_ACTION_NOT_REQUIRED`, the app targets a recent API level (API 35 or higher on the newest Android), the installer is updating itself, and it declares `REQUEST_INSTALL_PACKAGES` and `UPDATE_PACKAGES_WITHOUT_USER_ACTION`. The user allows "install unknown apps" for orfoni once. Android may still ask in some cases, so the code must handle that.
3. **Google Play internal testing.** A developer account costs $25 once and needs identity verification. Internal testing takes up to 100 testers, has builds ready within minutes, and the Play Store then updates the app like any other. The rule of 12 testers for 14 days applies only to production access for personal accounts created after 2023-11-13. Play forbids an app from updating itself, but allows the UI updates above.
4. **Downloading the APK by hand**, as now.

## Android developer verification

Google requires apps on certified Android devices to come from registered developers: from 2026-09-30 in Brazil, Indonesia, Singapore and Thailand, and globally in 2027. Apps from unregistered developers still install over ADB, or after a one-time "advanced flow" per device (Developer Options, a restart, a 24 hour wait, then "allow indefinitely"). Apps installed before enforcement keep working, but their updates then need one of those routes. A free "limited distribution" account lets hobbyists share an app with up to 20 devices without an ID or a fee. For orfoni this means: register the app under that account before enforcement reaches Germany, or do the advanced flow once on the phone. Either way the APKs need one signing key from the first release on, kept safe, since Android updates and the registration both depend on it.

## Recommendation

1. Give the Android app UI updates from the hub from its first release on, so later UI changes never need a reinstall. The same mechanism serves the Windows app.
2. Publish each APK in the GitHub release and install it with Obtainium. Build a self-updater only if Obtainium falls short.
3. Add Tauri's updater to the Windows app for the rare shell changes.
4. Create the Android signing key once, back it up outside the VPS, and register the app for developer verification before 2027.

## Sources

- [Tauri updater plugin](https://v2.tauri.app/plugin/updater/) and its [crate documentation](https://docs.rs/tauri-plugin-updater/latest), which list Windows, Linux and macOS.
- [Tauri discussion on mobile OTA](https://github.com/tauri-apps/tauri/discussions/8467), 2023.
- [tauri-plugin-hotswap](https://github.com/denniskribl/tauri-plugin-hotswap) and [tauri-plugin-hot-update](https://github.com/yanqianglu/tauri-plugin-hot-update).
- [PackageInstaller.SessionParams.setRequireUserAction](https://developer.android.com/reference/android/content/pm/PackageInstaller.SessionParams#setRequireUserAction(int)).
- [Obtainium wiki on how apps are tracked](https://hamster45105.github.io/Obtainium-Wiki/app_tracking) and [Obtainium releases](https://github.com/ImranR98/Obtainium/releases).
- [Play Console help: testing requirements for new personal accounts](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en).
- [Google Play Device and Network Abuse policy](https://support.google.com/googleplay/android-developer/answer/16559646).
- [Android developer verification](https://developer.android.com/developer-verification), [Android Authority on the timeline](https://www.androidauthority.com/android-sideloading-changes-timeline-3679204/) and [on the advanced flow and ADB](https://www.androidauthority.com/how-to-bypass-android-developer-verification-sideloading-rules-3718002/).
