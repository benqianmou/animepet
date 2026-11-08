//! DeepSeek 对话流、人格/身份/记忆注入与 NDJSON 事件输出。

use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex, mpsc::Sender};

use serde::{Deserialize, Serialize};

use crate::{
    MAX_HISTORY_MESSAGES, MAX_IDENTITY_BYTES, MAX_MEMORY_BYTES, chrono_like_now, http_agent,
    load_config, load_prompt_file, load_soul_for_model,
};

#[derive(Clone, Serialize)]
pub(crate) struct ChatMessage {
    role: String,
    content: String,
}
#[derive(Deserialize)]
pub(crate) struct ChatRequest {
    message: String,
    #[serde(default = "default_soul_model")]
    pub(crate) model: String,
}

fn default_soul_model() -> String {
    "katoumegumi".into()
}

pub(crate) const IDENTITY_OPEN: &str = "<identity_update>";
pub(crate) const IDENTITY_CLOSE: &str = "</identity_update>";

pub(crate) fn extract_identity_update(response: &str) -> (String, Option<String>) {
    let Some(start) = response.find(IDENTITY_OPEN) else {
        return (response.to_string(), None);
    };
    let content_start = start + IDENTITY_OPEN.len();
    let Some(end_offset) = response[content_start..].find(IDENTITY_CLOSE) else {
        return (response.to_string(), None);
    };
    let end = content_start + end_offset;
    let update = response[content_start..end].trim();
    let mut clean = String::with_capacity(response.len());
    clean.push_str(response[..start].trim_end());
    clean.push_str(response[end + IDENTITY_CLOSE.len()..].trim_start());
    let update = (!update.is_empty()).then(|| update.to_string());
    (clean.trim().to_string(), update)
}

fn append_identity_update(update: &str) {
    let update = update.trim();
    if update.is_empty() {
        return;
    }

    // Keep accidental verbose output from growing the local profile without bound.
    let update: String = update.chars().take(2_000).collect();
    let path = format!("{}/IDENTITY.md", env!("CARGO_MANIFEST_DIR"));
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if existing.contains(&update) {
        return;
    }

    let section = format!("\n## 对话提取 [{}]\n{}\n", chrono_like_now(), update);
    if let Err(error) = append_bounded_file(Path::new(&path), &section, MAX_IDENTITY_BYTES) {
        eprintln!("无法写入身份记录: {error}");
    }
}

fn append_bounded_file(path: &Path, entry: &str, max_bytes: usize) -> Result<(), String> {
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let mut combined = String::with_capacity(existing.len() + entry.len());
    combined.push_str(&existing);
    combined.push_str(entry);
    if combined.len() > max_bytes {
        let mut start = combined.len() - max_bytes;
        while start < combined.len() && !combined.is_char_boundary(start) {
            start += 1;
        }
        if let Some(newline) = combined[start..].find('\n') {
            start += newline + 1;
        }
        combined = combined[start..].to_string();
    }
    std::fs::write(path, combined).map_err(|error| error.to_string())
}

fn emit_stream_delta(response: &str, emitted_len: &mut usize, tx: &Sender<Vec<u8>>) {
    let safe_end = if let Some(marker_start) = response.find(IDENTITY_OPEN) {
        marker_start
    } else {
        // Hold a short suffix so a marker split across network chunks stays hidden.
        let hold = IDENTITY_OPEN.len().saturating_sub(1);
        let mut end = response.len().saturating_sub(hold);
        while end > 0 && !response.is_char_boundary(end) {
            end -= 1;
        }
        end
    };
    if safe_end > *emitted_len {
        json_event(tx, "delta", &response[*emitted_len..safe_end]);
        *emitted_len = safe_end;
    }
}

fn json_event(tx: &Sender<Vec<u8>>, kind: &str, text: &str) {
    let body = serde_json::json!({"type": kind, "text": text}).to_string() + "\n";
    let _ = tx.send(body.into_bytes());
}

fn process_stream_line(
    line: &str,
    answer: &mut String,
    emitted_len: &mut usize,
    tx: &Sender<Vec<u8>>,
) {
    let data = line.trim().strip_prefix("data: ").unwrap_or("");
    if data.is_empty() || data == "[DONE]" {
        return;
    }
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(data)
        && let Some(delta) = value["choices"][0]["delta"]["content"].as_str()
    {
        answer.push_str(delta);
        emit_stream_delta(answer, emitted_len, tx);
    }
}

pub(crate) fn stream_chat(
    req: ChatRequest,
    tx: Sender<Vec<u8>>,
    history: Arc<Mutex<Vec<ChatMessage>>>,
) {
    let config = match load_config() {
        Ok(c) => c,
        Err(e) => {
            json_event(&tx, "error", &e);
            return;
        }
    };
    let mut messages = vec![ChatMessage {
        role: "system".into(),
        content: format!(
            "{}\n\n用户身份信息（仅记录用户明确提供的事实和偏好）：\n{}\n\n长期记忆：\n{}\n\n身份记录规则：\n- 你不能直接操作文件；如果本轮对话中用户明确提供了姓名、称呼、地区、职业、兴趣、偏好、习惯或其他个人信息，请在正常回复末尾追加一段 <identity_update>...</identity_update>。\n- 标记内部只写简洁的 Markdown 条目，不要写推测、敏感信息、密码、API 密钥或用户没有明确说过的内容。\n- 如果没有新的用户信息，不要输出该标记。标记之外只放给用户看的正常回复。",
            load_soul_for_model(&req.model),
            load_prompt_file("IDENTITY.md"),
            load_prompt_file("MEMORY.md")
        ),
    }];
    let mut guard = history.lock().unwrap();
    messages.extend(guard.clone());
    messages.push(ChatMessage {
        role: "user".into(),
        content: req.message.clone(),
    });
    drop(guard);
    let url = format!(
        "{}/v1/chat/completions",
        config.base_url.trim_end_matches('/')
    );
    let agent = http_agent();
    let response = agent
        .post(&url)
        .header("Authorization", &format!("Bearer {}", config.api_key))
        .send_json(
            serde_json::json!({"model": config.model, "messages": messages, "stream": true}),
        );
    let mut response = match response {
        Ok(r) => r,
        Err(e) => {
            json_event(&tx, "error", &format!("请求 DeepSeek 失败: {e}"));
            return;
        }
    };
    let mut response_reader = response.body_mut().as_reader();
    let mut buf = Vec::new();
    let mut answer = String::new();
    let mut emitted_len = 0;
    let mut bytes = [0u8; 4096];
    loop {
        let n = match response_reader.read(&mut bytes) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                json_event(&tx, "error", &e.to_string());
                return;
            }
        };
        buf.extend_from_slice(&bytes[..n]);
        while let Some(pos) = buf.iter().position(|byte| *byte == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
            let line = match String::from_utf8(line_bytes) {
                Ok(line) => line,
                Err(error) => {
                    json_event(&tx, "error", &format!("DeepSeek 返回了无效 UTF-8: {error}"));
                    return;
                }
            };
            process_stream_line(&line, &mut answer, &mut emitted_len, &tx);
        }
    }
    if !buf.is_empty() {
        let line = match String::from_utf8(buf) {
            Ok(line) => line,
            Err(error) => {
                json_event(&tx, "error", &format!("DeepSeek 返回了无效 UTF-8: {error}"));
                return;
            }
        };
        process_stream_line(&line, &mut answer, &mut emitted_len, &tx);
    }
    if !answer.is_empty() {
        let (clean_answer, identity_update) = extract_identity_update(&answer);
        if let Some(update) = identity_update {
            append_identity_update(&update);
        }
        guard = history.lock().unwrap();
        guard.push(ChatMessage {
            role: "user".into(),
            content: req.message.clone(),
        });
        guard.push(ChatMessage {
            role: "assistant".into(),
            content: clean_answer.clone(),
        });
        if guard.len() > MAX_HISTORY_MESSAGES {
            let excess = guard.len() - MAX_HISTORY_MESSAGES;
            guard.drain(..excess);
        }
        let stamp = format!(
            "\n- [{}] 用户：{}\n  AnimePet：{}\n",
            chrono_like_now(),
            req.message,
            clean_answer
        );
        let memory_path = format!("{}/MEMORY.md", env!("CARGO_MANIFEST_DIR"));
        if let Err(error) = append_bounded_file(Path::new(&memory_path), &stamp, MAX_MEMORY_BYTES) {
            eprintln!("无法写入对话记忆: {error}");
        }
        json_event(&tx, "done", &clean_answer);
    } else {
        json_event(&tx, "done", "");
    }
}
