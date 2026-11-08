//! 陪伴状态持久化与桌面通知。

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

fn data_dir() -> PathBuf {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("animepet")
}

fn state_file_path() -> PathBuf {
    data_dir().join("state.json")
}

/// 校验前端提交的陪伴状态：必须是 JSON 对象且不超过上限。
pub(crate) fn validate_state_payload(body: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|error| format!("状态不是合法 JSON: {error}"))?;
    if !value.is_object() {
        return Err("状态必须是 JSON 对象".into());
    }
    Ok(value.to_string())
}

/// 原子写入：先写临时文件再 rename，避免中途崩溃留下半截状态。
pub(crate) fn write_state_atomic(body: &str) -> Result<(), String> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|error| format!("无法创建数据目录: {error}"))?;
    let target = state_file_path();
    let temp = dir.join(format!("state.json.tmp.{}", std::process::id()));
    std::fs::write(&temp, body).map_err(|error| format!("无法写入状态: {error}"))?;
    std::fs::rename(&temp, &target).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("无法更新状态文件: {error}")
    })
}

pub(crate) fn read_state_json() -> String {
    std::fs::read_to_string(state_file_path()).unwrap_or_else(|_| "{}".to_string())
}

/// 桌面通知：调用桌面环境自带的 notify-send，缺失时静默失败。
/// 每分钟最多一条，避免喝水提醒 / 升级 / 专注同时触发时刷屏。
pub(crate) fn send_desktop_notification(title: &str, body: &str) -> Result<(), String> {
    static LAST_SENT: Mutex<Option<Instant>> = Mutex::new(None);
    let title = truncate_chars(title.trim(), 80);
    let body = truncate_chars(body.trim(), 240);
    if title.is_empty() && body.is_empty() {
        return Err("通知内容为空".into());
    }
    {
        let mut last = LAST_SENT.lock().map_err(|error| error.to_string())?;
        let now = Instant::now();
        if let Some(previous) = *last
            && now.duration_since(previous) < Duration::from_secs(60)
        {
            return Ok(());
        }
        *last = Some(now);
    }
    let status = Command::new("notify-send")
        .arg("-a")
        .arg("AnimePet")
        .arg("-i")
        .arg("face-smile")
        .arg("--")
        .arg(&title)
        .arg(&body)
        .status()
        .map_err(|error| format!("无法调用 notify-send: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("notify-send 返回失败".into())
    }
}

pub(crate) fn truncate_chars(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    text.chars().take(limit).collect()
}
