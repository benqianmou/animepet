//! 本地 HTTP 服务装配：路由、聊天流、语音、状态与静态资源。
//! 具体实现分散在 chat / speech / state / http_util 模块。

use std::io::Read;
use std::sync::{
    Arc, Mutex,
    mpsc::{self, Receiver, Sender},
};

use crate::{
    CHAT_SERVER_PORT, MAX_AUDIO_BYTES, MAX_STATE_BYTES, TtsRequest,
    chat::{ChatMessage, ChatRequest, stream_chat},
    http_util::{
        read_request_body, read_request_bytes, request_is_authorized, respond_json, respond_text,
        serve_file,
    },
    speech::{synthesize_speech, transcribe_speech},
    state::{
        read_state_json, send_desktop_notification, validate_state_payload, write_state_atomic,
    },
};

struct StreamReader {
    rx: Receiver<Vec<u8>>,
    pending: Vec<u8>,
}
impl Read for StreamReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.pending.is_empty() {
            self.pending = self.rx.recv().unwrap_or_default();
        }
        if self.pending.is_empty() {
            return Ok(0);
        }
        let n = out.len().min(self.pending.len());
        out[..n].copy_from_slice(&self.pending[..n]);
        self.pending.drain(..n);
        Ok(n)
    }
}

/// 启动本地 HTTP 服务：聊天 / TTS / STT / 状态 / 通知 / 退出。
pub(crate) fn start_chat_server(
    root: &str,
    history: Arc<Mutex<Vec<ChatMessage>>>,
    quit_tx: Sender<()>,
    token: String,
) -> u16 {
    // A stable origin lets WebKit persist model selection in localStorage across restarts.
    // Fall back to an ephemeral port if another AnimePet instance already owns it.
    let server = tiny_http::Server::http(format!("127.0.0.1:{CHAT_SERVER_PORT}"))
        .or_else(|_| tiny_http::Server::http("127.0.0.1:0"))
        .expect("failed to bind local server");
    let port = server.server_addr().to_ip().unwrap().port();
    let root = root.to_string();
    std::thread::spawn(move || {
        for mut request in server.incoming_requests() {
            let route = request.url().split('?').next().unwrap_or("");
            if route == "/tts" && request.method() == &tiny_http::Method::Post {
                if !request_is_authorized(&request, &token) {
                    respond_text(request, 403, "forbidden");
                    continue;
                }
                let body = match read_request_body(&mut request) {
                    Ok(body) => body,
                    Err(error) => {
                        respond_text(request, 413, &error);
                        continue;
                    }
                };
                std::thread::spawn(move || {
                    match serde_json::from_str::<TtsRequest>(&body)
                        .map_err(|e| e.to_string())
                        .and_then(synthesize_speech)
                    {
                        Ok((audio, lang)) => {
                            let header = tiny_http::Header::from_bytes(
                                &b"Content-Type"[..],
                                &b"audio/wav"[..],
                            )
                            .unwrap();
                            let voice_header = tiny_http::Header::from_bytes(
                                &b"X-AnimePet-TTS"[..],
                                lang.as_bytes(),
                            )
                            .unwrap();
                            let _ = request.respond(
                                tiny_http::Response::from_data(audio)
                                    .with_header(header)
                                    .with_header(voice_header),
                            );
                        }
                        Err(error) => {
                            respond_text(request, 503, &error);
                        }
                    }
                });
            } else if route == "/stt" && request.method() == &tiny_http::Method::Post {
                if !request_is_authorized(&request, &token) {
                    respond_text(request, 403, "forbidden");
                    continue;
                }
                let mime = request
                    .headers()
                    .iter()
                    .find(|header| header.field.equiv("Content-Type"))
                    .map(|header| header.value.as_str().to_string())
                    .unwrap_or_else(|| "audio/webm".into());
                let body = match read_request_bytes(&mut request, MAX_AUDIO_BYTES) {
                    Ok(body) => body,
                    Err(error) => {
                        respond_text(request, 413, &error);
                        continue;
                    }
                };
                std::thread::spawn(move || match transcribe_speech(body, &mime) {
                    Ok(text) => {
                        let header = tiny_http::Header::from_bytes(
                            &b"Content-Type"[..],
                            &b"application/json; charset=utf-8"[..],
                        )
                        .unwrap();
                        let payload = serde_json::json!({"text": text}).to_string();
                        let _ = request
                            .respond(tiny_http::Response::from_string(payload).with_header(header));
                    }
                    Err(error) => {
                        respond_text(request, 503, &error);
                    }
                });
            } else if route == "/state" {
                match *request.method() {
                    tiny_http::Method::Get => {
                        respond_json(request, 200, &read_state_json());
                    }
                    tiny_http::Method::Post => {
                        if !request_is_authorized(&request, &token) {
                            respond_text(request, 403, "forbidden");
                            continue;
                        }
                        let body = match read_request_bytes(&mut request, MAX_STATE_BYTES).and_then(
                            |bytes| {
                                String::from_utf8(bytes)
                                    .map_err(|error| format!("状态不是有效 UTF-8: {error}"))
                            },
                        ) {
                            Ok(body) => body,
                            Err(error) => {
                                respond_text(request, 413, &error);
                                continue;
                            }
                        };
                        match validate_state_payload(&body)
                            .and_then(|state| write_state_atomic(&state).map(|_| state))
                        {
                            Ok(state) => respond_json(request, 200, &state),
                            Err(error) => respond_text(request, 400, &error),
                        }
                    }
                    _ => respond_text(request, 405, "405 Method Not Allowed"),
                }
            } else if route == "/notify" && request.method() == &tiny_http::Method::Post {
                if !request_is_authorized(&request, &token) {
                    respond_text(request, 403, "forbidden");
                    continue;
                }
                let body = match read_request_body(&mut request) {
                    Ok(body) => body,
                    Err(error) => {
                        respond_text(request, 413, &error);
                        continue;
                    }
                };
                let payload: serde_json::Value =
                    serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
                let title = payload["title"].as_str().unwrap_or("AnimePet").to_string();
                let message = payload["body"].as_str().unwrap_or("").to_string();
                std::thread::spawn(move || {
                    if let Err(error) = send_desktop_notification(&title, &message) {
                        eprintln!("desktop notification skipped: {error}");
                    }
                });
                respond_text(request, 200, "ok");
            } else if route == "/app/quit" && request.method() == &tiny_http::Method::Post {
                if !request_is_authorized(&request, &token) {
                    respond_text(request, 403, "forbidden");
                    continue;
                }
                let _ = quit_tx.send(());
                respond_text(request, 200, "bye");
            } else if route == "/chat" && request.method() == &tiny_http::Method::Post {
                if !request_is_authorized(&request, &token) {
                    respond_text(request, 403, "forbidden");
                    continue;
                }
                let body = match read_request_body(&mut request) {
                    Ok(body) => body,
                    Err(error) => {
                        respond_text(request, 413, &error);
                        continue;
                    }
                };
                let parsed = serde_json::from_str::<ChatRequest>(&body);
                if let Ok(chat) = parsed {
                    let (tx, rx) = mpsc::channel();
                    let history_ref = history.clone();
                    std::thread::spawn(move || stream_chat(chat, tx, history_ref));
                    let header = tiny_http::Header::from_bytes(
                        &b"Content-Type"[..],
                        &b"application/x-ndjson"[..],
                    )
                    .unwrap();
                    let response = tiny_http::Response::new(
                        tiny_http::StatusCode(200),
                        vec![header],
                        StreamReader {
                            rx,
                            pending: vec![],
                        },
                        None,
                        None,
                    );
                    let _ = request.respond(response);
                } else {
                    respond_text(request, 400, "bad request");
                }
            } else {
                serve_file(request, &root, &token);
            }
        }
    });
    port
}
