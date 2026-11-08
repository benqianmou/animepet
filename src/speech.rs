//! TTS / STT：GPT-SoVITS、espeak-ng 兜底与 Whisper 转写。

use std::path::Path;
use std::process::Command;

use crate::{AppConfig, MAX_AUDIO_BYTES, SttResponse, TtsRequest, http_agent, load_config};

pub(crate) fn contains_japanese(text: &str) -> bool {
    text.chars()
        .any(|c| matches!(c, '\u{3040}'..='\u{30ff}' | '\u{31f0}'..='\u{31ff}'))
}

pub(crate) fn normalize_language(language: &str) -> Result<&'static str, String> {
    match language.trim().to_ascii_lowercase().as_str() {
        "ja" | "jp" | "日语" | "日文" => Ok("ja"),
        "zh" | "中文" | "汉语" | "漢語" => Ok("zh"),
        "en" | "english" | "英语" | "英文" => Ok("en"),
        _ => Err(format!(
            "不支持的 TTS 参考语言: {language}（请使用 ja、zh 或 en）"
        )),
    }
}

pub(crate) fn resolve_tts_reference_path(reference: &str) -> String {
    let reference = Path::new(reference.trim());
    if reference.is_absolute() {
        return reference.to_string_lossy().into_owned();
    }

    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(reference)
        .to_string_lossy()
        .into_owned()
}

pub(crate) fn synthesize_speech(req: TtsRequest) -> Result<(Vec<u8>, &'static str), String> {
    let config = load_config()?;
    synthesize_speech_with_config(req, config)
}

pub(crate) fn synthesize_speech_with_config(
    req: TtsRequest,
    config: AppConfig,
) -> Result<(Vec<u8>, &'static str), String> {
    let text = req.text.trim();
    if text.is_empty() {
        return Err("TTS 文本为空".into());
    }
    if text.chars().count() > 40_000 {
        return Err("TTS 文本过长（最多 40000 个字符）".into());
    }
    let text_lang = if contains_japanese(text) { "ja" } else { "zh" };
    if !config.tts_enabled {
        return synthesize_speech_fallback(text, text_lang).map(|audio| (audio, "fallback"));
    }
    if config.tts_ref_audio.trim().is_empty() || config.tts_prompt_text.trim().is_empty() {
        return Err("已启用加藤惠语音，但缺少 tts_ref_audio 或 tts_prompt_text 配置".into());
    }
    let prompt_lang = normalize_language(&config.tts_prompt_lang)?;
    let ref_audio_path = resolve_tts_reference_path(&config.tts_ref_audio);
    let url = format!("{}/tts", config.tts_base_url.trim_end_matches('/'));
    let payload = serde_json::json!({
        "text": text,
        "text_lang": text_lang,
        "ref_audio_path": ref_audio_path,
        "prompt_text": config.tts_prompt_text,
        "prompt_lang": prompt_lang,
        "text_split_method": "cut5",
        "batch_size": 1,
        "speed_factor": 1.0,
        "media_type": "wav",
        "streaming_mode": false,
    });
    let agent = http_agent();
    let mut response = match agent
        .post(&url)
        .header("Content-Type", "application/json")
        .send_json(&payload)
    {
        Ok(response) => response,
        Err(error) => {
            return Err(format!(
                "加藤惠语音服务不可用: {error}。请先运行 bash scripts/start-gpt-sovits.sh"
            ));
        }
    };
    let audio = response
        .body_mut()
        .with_config()
        .limit(64 * 1024 * 1024)
        .read_to_vec()
        .map_err(|error| format!("读取 GPT-SoVITS 音频失败: {error}"))?;
    if !is_wav_audio(&audio) {
        return Err("GPT-SoVITS 未返回有效 WAV 音频，请检查服务日志和参考音频配置".into());
    }
    Ok((audio, "gpt-sovits"))
}

pub(crate) fn is_wav_audio(audio: &[u8]) -> bool {
    audio.len() >= 12 && &audio[..4] == b"RIFF" && &audio[8..12] == b"WAVE"
}

pub(crate) fn synthesize_speech_fallback(text: &str, text_lang: &str) -> Result<Vec<u8>, String> {
    let voice = if text_lang == "ja" { "ja" } else { "zh" };
    let limited_text: String = text.chars().take(2_000).collect();
    let output = Command::new("espeak-ng")
        .arg("--stdout")
        .arg("-v")
        .arg(voice)
        .arg("-s")
        .arg("150")
        .arg(limited_text)
        .output()
        .map_err(|e| format!("GPT-SoVITS 不可用，且无法启动 espeak-ng 兜底: {e}"))?;
    if !output.status.success() || output.stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("GPT-SoVITS 不可用，espeak-ng 兜底失败: {stderr}"));
    }
    Ok(output.stdout)
}

pub(crate) fn stt_endpoint(base_url: &str, provider: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if provider.eq_ignore_ascii_case("whisper-cpp") {
        return if base.ends_with("/inference") {
            base.to_string()
        } else {
            format!("{base}/inference")
        };
    }
    if base.ends_with("/v1/audio/transcriptions") {
        base.to_string()
    } else {
        format!("{base}/v1/audio/transcriptions")
    }
}

pub(crate) fn audio_extension(mime: &str) -> &'static str {
    if mime.contains("ogg") {
        "ogg"
    } else if mime.contains("wav") {
        "wav"
    } else if mime.contains("mp4") || mime.contains("m4a") {
        "m4a"
    } else {
        "webm"
    }
}

fn multipart_text_field(body: &mut Vec<u8>, boundary: &str, name: &str, value: &str) {
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
        )
        .as_bytes(),
    );
}

pub(crate) fn transcribe_speech(audio: Vec<u8>, mime: &str) -> Result<String, String> {
    let config = load_config()?;
    if !config.stt_enabled {
        return Err(
            "STT 未启用。请在 config.toml 中设置 stt_enabled = true，并启动 whisper.cpp server"
                .into(),
        );
    }
    if audio.is_empty() {
        return Err("STT 音频为空".into());
    }
    if audio.len() > MAX_AUDIO_BYTES {
        return Err(format!(
            "STT 音频过大（最多 {} MB）",
            MAX_AUDIO_BYTES / 1024 / 1024
        ));
    }

    let boundary = "AnimePetWhisperBoundary";
    let mut multipart = Vec::with_capacity(audio.len() + 512);
    let whisper_cpp = config.stt_provider.eq_ignore_ascii_case("whisper-cpp");
    if !whisper_cpp {
        multipart_text_field(&mut multipart, boundary, "model", &config.stt_model);
    } else {
        multipart_text_field(&mut multipart, boundary, "response_format", "json");
    }
    if !config.stt_language.trim().is_empty() && config.stt_language.trim() != "auto" {
        multipart_text_field(
            &mut multipart,
            boundary,
            "language",
            config.stt_language.trim(),
        );
    }
    let extension = audio_extension(mime);
    multipart.extend_from_slice(format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"recording.{extension}\"\r\nContent-Type: {mime}\r\n\r\n"
    ).as_bytes());
    multipart.extend_from_slice(&audio);
    multipart.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let content_type = format!("multipart/form-data; boundary={boundary}");
    let mut request = http_agent()
        .post(&stt_endpoint(&config.stt_base_url, &config.stt_provider))
        .header("Accept", "application/json")
        .header("Content-Type", &content_type);
    if !config.stt_api_key.trim().is_empty() {
        request = request.header(
            "Authorization",
            &format!("Bearer {}", config.stt_api_key.trim()),
        );
    }
    let mut response = request
        .send(multipart)
        .map_err(|error| format!("Whisper STT 服务不可用: {error}"))?;
    let response_body = response
        .body_mut()
        .with_config()
        .limit(1024 * 1024)
        .read_to_string()
        .map_err(|error| format!("读取 Whisper STT 响应失败: {error}"))?;
    let parsed: SttResponse = serde_json::from_str(&response_body)
        .map_err(|error| format!("Whisper STT 返回了无效响应: {error}"))?;
    let text = parsed.text.trim();
    if text.is_empty() {
        return Err("Whisper STT 没有识别出文字".into());
    }
    Ok(text.to_string())
}
