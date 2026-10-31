use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::commands::AppState;

/// What the hub says a person following a session would want to hear about, shown by the app itself, so it still shows while Android keeps the page paused in the background.
#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub session_id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
}

impl Notice {
    pub fn parse(line: &str) -> Option<Notice> {
        if !line.contains("\"notice\"") {
            return None;
        }
        let value: serde_json::Value = serde_json::from_str(line).ok()?;
        if value.get("type")?.as_str()? != "notice" {
            return None;
        }
        serde_json::from_value(value).ok()
    }

    /// A session that cannot go on without you, or one Claude says you should hear from.
    pub fn urgent(&self) -> bool {
        matches!(self.kind.as_str(), "approval" | "question" | "push")
    }
}

pub fn show<R: Runtime>(app: &AppHandle<R>, notice: Notice) {
    if app.state::<AppState>().focused() {
        return;
    }
    #[cfg(target_os = "android")]
    crate::background::notify(app, &notice);
    #[cfg(not(target_os = "android"))]
    {
        use tauri_plugin_notification::NotificationExt;
        if let Err(error) = app
            .notification()
            .builder()
            .title(&notice.title)
            .body(&notice.body)
            .extra("sessionId", &notice.session_id)
            .show()
        {
            log::warn!("showing a notification failed: {error}");
        }
    }
    #[cfg(desktop)]
    if notice.urgent() {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_notice_line_from_the_hub_becomes_a_notice_and_other_lines_do_not() {
        let line = r#"{"type":"notice","sessionId":"s1","kind":"approval","title":"Fix the login page","body":"Claude needs your approval in proj"}"#;
        assert_eq!(
            Notice::parse(line),
            Some(Notice {
                session_id: "s1".into(),
                kind: "approval".into(),
                title: "Fix the login page".into(),
                body: "Claude needs your approval in proj".into(),
            })
        );
        for other in [
            r#"{"type":"chatItem","sessionId":"s1","item":{"kind":"user","id":"u","text":"say \"notice\"","at":1}}"#,
            r#"{"type":"notice","sessionId":"s1"}"#,
            "not json \"notice\"",
        ] {
            assert_eq!(Notice::parse(other), None, "{other}");
        }
    }

    #[test]
    fn approvals_questions_and_pushes_are_urgent_and_answers_and_failures_are_not() {
        let notice = |kind: &str| Notice {
            session_id: "s".into(),
            kind: kind.into(),
            title: String::new(),
            body: String::new(),
        };
        let urgent: Vec<bool> = ["approval", "question", "push", "answered", "failed"]
            .iter()
            .map(|kind| notice(kind).urgent())
            .collect();
        assert_eq!(urgent, [true, true, true, false, false]);
    }
}
