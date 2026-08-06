use std::collections::VecDeque;
use std::env;
use std::future::Future;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use clap::ValueEnum;
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::protocol::{ActivityStatus, Event, EventKind, NoticeLevel, Outcome, Phase};

const MAX_DETAIL_CHARS: usize = 2_400;
const MAX_ERROR_LINES: usize = 12;
static NEXT_RESPONSE_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone)]
pub struct RunOptions {
    pub provider: Provider,
    pub cwd: String,
    pub model: Option<String>,
    pub sandbox: String,
    pub session: Option<String>,
    pub codex_bin: String,
    pub base_url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Provider {
    Codex,
    OpenaiCompatible,
}

impl Provider {
    fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::OpenaiCompatible => "openai-compatible",
        }
    }
}

pub async fn run(options: RunOptions) -> Result<()> {
    match options.provider {
        Provider::Codex => run_codex(options).await,
        Provider::OpenaiCompatible => run_openai_compatible(options).await,
    }
}

async fn run_codex(options: RunOptions) -> Result<()> {
    if !Path::new(&options.cwd).is_dir() {
        bail!("working directory does not exist: {}", options.cwd);
    }

    let mut prompt = String::new();
    tokio::io::stdin()
        .read_to_string(&mut prompt)
        .await
        .context("failed to read the prompt from stdin")?;
    if prompt.trim().is_empty() {
        bail!("prompt cannot be empty");
    }

    let started = Instant::now();
    emit(Event::new(EventKind::RunStarted {
        provider: "codex".into(),
        cwd: options.cwd.clone(),
        resumed: options.session.is_some(),
    }))
    .await?;
    emit(phase(Phase::Thinking, "Reading the workspace")).await?;

    let mut command = codex_command(&options);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command
        .spawn()
        .with_context(|| format!("failed to start {}", options.codex_bin))?;

    let mut child_stdin = child.stdin.take().context("provider stdin unavailable")?;
    child_stdin
        .write_all(prompt.as_bytes())
        .await
        .context("failed to send prompt to provider")?;
    child_stdin
        .shutdown()
        .await
        .context("failed to close provider input")?;
    // Codex waits for EOF before starting the turn. Async shutdown flushes the
    // pipe, but the descriptor remains open until the handle itself is dropped.
    drop(child_stdin);

    let stdout = child.stdout.take().context("provider stdout unavailable")?;
    let stderr = child.stderr.take().context("provider stderr unavailable")?;
    let stderr_task = tokio::spawn(collect_stderr(stderr));
    let mut lines = BufReader::new(stdout).lines();
    let mut stopped = false;

    loop {
        tokio::select! {
            line = lines.next_line() => {
                match line.context("failed while reading provider output")? {
                    Some(line) if !line.trim().is_empty() => {
                        match serde_json::from_str::<Value>(&line) {
                            Ok(value) => {
                                for event in normalize_provider_event(&value) {
                                    emit(event).await?;
                                }
                            }
                            Err(_) => {
                                emit(Event::new(EventKind::Notice {
                                    level: NoticeLevel::Warning,
                                    text: "The provider emitted an unreadable event; the turn is still running.".into(),
                                })).await?;
                            }
                        }
                    }
                    Some(_) => {}
                    None => break,
                }
            }
            signal = tokio::signal::ctrl_c() => {
                signal.context("failed to listen for cancellation")?;
                stopped = true;
                child.start_kill().context("failed to stop provider process")?;
                emit(phase(Phase::Stopped, "Stopped")).await?;
                break;
            }
        }
    }

    let status = child.wait().await.context("failed to wait for provider")?;
    let stderr_lines = stderr_task.await.context("stderr collector failed")?;
    let elapsed_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;

    if stopped {
        emit(Event::new(EventKind::Done {
            outcome: Outcome::Stopped,
            elapsed_ms,
        }))
        .await?;
        return Ok(());
    }

    if !status.success() {
        let detail = (!stderr_lines.is_empty()).then(|| stderr_lines.join("\n"));
        emit(phase(Phase::Failed, "Provider failed")).await?;
        emit(Event::new(EventKind::Error {
            code: "provider_exit".into(),
            message: format!(
                "Codex exited with {}. Run `codex login` or inspect the folded diagnostics.",
                status
            ),
            detail,
        }))
        .await?;
        emit(Event::new(EventKind::Done {
            outcome: Outcome::Failed,
            elapsed_ms,
        }))
        .await?;
    } else {
        emit(phase(Phase::Ready, "Ready")).await?;
        emit(Event::new(EventKind::Done {
            outcome: Outcome::Completed,
            elapsed_ms,
        }))
        .await?;
    }

    Ok(())
}

async fn run_openai_compatible(options: RunOptions) -> Result<()> {
    if !Path::new(&options.cwd).is_dir() {
        bail!("working directory does not exist: {}", options.cwd);
    }

    let mut prompt = String::new();
    tokio::io::stdin()
        .read_to_string(&mut prompt)
        .await
        .context("failed to read the prompt from stdin")?;
    if prompt.trim().is_empty() {
        bail!("prompt cannot be empty");
    }

    let started = Instant::now();
    let response_id = unique_openai_response_id();
    emit(Event::new(EventKind::RunStarted {
        provider: options.provider.as_str().into(),
        cwd: options.cwd.clone(),
        resumed: false,
    }))
    .await?;
    if options.session.is_some() {
        emit(Event::new(EventKind::Notice {
            level: NoticeLevel::Info,
            text: "OpenAI-compatible providers do not expose resumable sessions; starting a fresh request.".into(),
        }))
        .await?;
    }
    emit(phase(Phase::Thinking, "Thinking")).await?;

    let model = options
        .model
        .or_else(|| env::var("FIBONACCI_OPENAI_MODEL").ok())
        .unwrap_or_else(|| "gpt-4o-mini".into());
    let api_key = env::var("FIBONACCI_OPENAI_API_KEY")
        .ok()
        .or_else(|| env::var("OPENAI_API_KEY").ok())
        .filter(|value| !value.trim().is_empty());
    let endpoint = format!(
        "{}/chat/completions",
        options.base_url.trim_end_matches('/')
    );
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .build()
        .context("failed to configure the OpenAI-compatible HTTP client")?;
    let mut request = client.post(endpoint).json(&serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": true
    }));
    if let Some(api_key) = api_key {
        request = request.bearer_auth(api_key);
    }

    let response = match response_or_stop(request.send(), tokio::signal::ctrl_c()).await {
        RequestWait::Response(Ok(response)) => response,
        RequestWait::Response(Err(error)) => {
            return emit_http_failure(
                started,
                format!("OpenAI-compatible request failed: {error}"),
            )
            .await;
        }
        RequestWait::Stopped => return emit_stopped(started).await,
        RequestWait::StopFailed(error) => {
            return Err(error).context("failed to listen for cancellation");
        }
    };
    if !response.status().is_success() {
        let status = response.status();
        let detail = match response_or_stop(response.text(), tokio::signal::ctrl_c()).await {
            RequestWait::Response(Ok(detail)) => detail,
            RequestWait::Response(Err(error)) => {
                return emit_http_failure(
                    started,
                    format!("OpenAI-compatible error response failed: {error}"),
                )
                .await;
            }
            RequestWait::Stopped => return emit_stopped(started).await,
            RequestWait::StopFailed(error) => {
                return Err(error).context("failed to listen for cancellation");
            }
        };
        return emit_http_failure(
            started,
            if detail.trim().is_empty() {
                format!("OpenAI-compatible provider returned {status}.")
            } else {
                format!(
                    "OpenAI-compatible provider returned {status}: {}",
                    truncate(&detail)
                )
            },
        )
        .await;
    }

    let mut stream = response.bytes_stream();
    let mut decoder = OpenAiSseDecoder::default();
    let mut responded = false;
    let mut completed = false;
    while !completed {
        tokio::select! {
            signal = tokio::signal::ctrl_c() => {
                signal.context("failed to listen for cancellation")?;
                return emit_stopped(started).await;
            }
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        let deltas = match decoder.push(&bytes) {
                            Ok(deltas) => deltas,
                            Err(error) => {
                                return emit_http_failure(started, error.to_string()).await;
                            }
                        };
                        completed = emit_openai_deltas(deltas, &mut responded, &response_id).await?;
                    }
                    Some(Err(error)) => {
                        return emit_http_failure(started, format!("OpenAI-compatible stream failed: {error}")).await;
                    }
                    None => {
                        let deltas = match decoder.finish() {
                            Ok(deltas) => deltas,
                            Err(error) => return emit_http_failure(started, error.to_string()).await,
                        };
                        completed = emit_openai_deltas(deltas, &mut responded, &response_id).await?;
                        break;
                    }
                }
            }
        }
    }

    if !completed {
        return emit_http_failure(
            started,
            "OpenAI-compatible stream ended before [DONE].".into(),
        )
        .await;
    }

    emit(phase(Phase::Ready, "Ready")).await?;
    emit(Event::new(EventKind::Done {
        outcome: Outcome::Completed,
        elapsed_ms: elapsed_ms(started),
    }))
    .await
}

enum RequestWait<T, E, SE> {
    Response(Result<T, E>),
    Stopped,
    StopFailed(SE),
}

async fn response_or_stop<R, S, T, E, SE>(response: R, stop: S) -> RequestWait<T, E, SE>
where
    R: Future<Output = Result<T, E>>,
    S: Future<Output = Result<(), SE>>,
{
    tokio::select! {
        response = response => RequestWait::Response(response),
        stop = stop => match stop {
            Ok(()) => RequestWait::Stopped,
            Err(error) => RequestWait::StopFailed(error),
        },
    }
}

async fn emit_stopped(started: Instant) -> Result<()> {
    emit(phase(Phase::Stopped, "Stopped")).await?;
    emit(Event::new(EventKind::Done {
        outcome: Outcome::Stopped,
        elapsed_ms: elapsed_ms(started),
    }))
    .await
}

async fn emit_openai_deltas(
    deltas: Vec<OpenAiSseDelta>,
    responded: &mut bool,
    response_id: &str,
) -> Result<bool> {
    let mut completed = false;
    for delta in deltas {
        if let Some(text) = delta.text {
            if !*responded {
                emit(phase(Phase::Acting, "Responding")).await?;
                *responded = true;
            }
            emit(Event::new(EventKind::MessageDelta {
                id: response_id.into(),
                delta: text,
            }))
            .await?;
        }
        if let Some(usage) = delta.usage {
            emit(Event::new(EventKind::Usage {
                input_tokens: usage.input_tokens,
                cached_input_tokens: usage.cached_input_tokens,
                output_tokens: usage.output_tokens,
                reasoning_output_tokens: usage.reasoning_output_tokens,
            }))
            .await?;
        }
        completed |= delta.done;
    }
    Ok(completed)
}

fn unique_openai_response_id() -> String {
    let sequence = NEXT_RESPONSE_ID.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "openai-response-{}-{timestamp}-{sequence}",
        std::process::id()
    )
}

async fn emit_http_failure(started: Instant, message: String) -> Result<()> {
    emit(phase(Phase::Failed, "Provider failed")).await?;
    emit(Event::new(EventKind::Error {
        code: "provider_http".into(),
        message,
        detail: None,
    }))
    .await?;
    emit(Event::new(EventKind::Done {
        outcome: Outcome::Failed,
        elapsed_ms: elapsed_ms(started),
    }))
    .await
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

#[derive(Debug, PartialEq)]
struct OpenAiSseDelta {
    text: Option<String>,
    done: bool,
    usage: Option<UsageCounts>,
}

#[derive(Debug, PartialEq)]
struct UsageCounts {
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
}

#[derive(Debug, Default)]
struct OpenAiSseDecoder {
    buffer: Vec<u8>,
    data_lines: Vec<String>,
    completed: bool,
}

impl OpenAiSseDecoder {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<OpenAiSseDelta>> {
        self.buffer.extend_from_slice(bytes);
        let mut deltas = Vec::new();
        while let Some(newline) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let mut line = self.buffer.drain(..=newline).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.parse_line(&line, &mut deltas)?;
        }
        Ok(deltas)
    }

    fn finish(&mut self) -> Result<Vec<OpenAiSseDelta>> {
        let mut deltas = Vec::new();
        if !self.buffer.is_empty() {
            let line = std::mem::take(&mut self.buffer);
            self.parse_line(&line, &mut deltas)?;
        }
        self.flush_event(&mut deltas)?;
        if !self.completed {
            bail!("OpenAI-compatible stream ended before [DONE].");
        }
        Ok(deltas)
    }

    fn parse_line(&mut self, line: &[u8], deltas: &mut Vec<OpenAiSseDelta>) -> Result<()> {
        let line = std::str::from_utf8(line)
            .context("OpenAI-compatible stream contained invalid UTF-8")?;
        if line.is_empty() {
            return self.flush_event(deltas);
        }
        if line.starts_with(':') {
            return Ok(());
        }
        if let Some(data) = line.strip_prefix("data:") {
            self.data_lines
                .push(data.strip_prefix(' ').unwrap_or(data).to_owned());
        } else if line == "data" {
            self.data_lines.push(String::new());
        }
        Ok(())
    }

    fn flush_event(&mut self, deltas: &mut Vec<OpenAiSseDelta>) -> Result<()> {
        if self.data_lines.is_empty() {
            return Ok(());
        }
        let data = std::mem::take(&mut self.data_lines).join("\n");
        let line = format!("data: {data}");
        let delta = parse_openai_sse_line(&line)
            .context("OpenAI-compatible stream contained malformed data")?;
        self.completed |= delta.done;
        deltas.push(delta);
        Ok(())
    }
}

fn parse_openai_sse_line(line: &str) -> Option<OpenAiSseDelta> {
    let data = line.strip_prefix("data:")?.trim();
    if data == "[DONE]" {
        return Some(OpenAiSseDelta {
            text: None,
            done: true,
            usage: None,
        });
    }

    let value = serde_json::from_str::<Value>(data).ok()?;
    let text = value
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let usage = value.get("usage").map(|usage| UsageCounts {
        input_tokens: number(usage, "prompt_tokens"),
        cached_input_tokens: number(usage, "prompt_tokens_details/cached_tokens"),
        output_tokens: number(usage, "completion_tokens"),
        reasoning_output_tokens: number(usage, "completion_tokens_details/reasoning_tokens"),
    });

    Some(OpenAiSseDelta {
        text,
        done: false,
        usage,
    })
}

fn codex_command(options: &RunOptions) -> Command {
    let mut command = Command::new(&options.codex_bin);
    command.arg("exec");

    if let Some(session) = &options.session {
        command
            .args(["resume", "--json", "--skip-git-repo-check"])
            .arg(session);
        if let Some(model) = &options.model {
            command.args(["--model", model]);
        }
        command.arg("-");
    } else {
        command.args([
            "--json",
            "--color",
            "never",
            "--skip-git-repo-check",
            "--sandbox",
            &options.sandbox,
            "--cd",
            &options.cwd,
        ]);
        if let Some(model) = &options.model {
            command.args(["--model", model]);
        }
        command.arg("-");
    }

    command
}

async fn collect_stderr(stderr: tokio::process::ChildStderr) -> Vec<String> {
    let mut lines = BufReader::new(stderr).lines();
    let mut tail = VecDeque::with_capacity(MAX_ERROR_LINES);
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        if tail.len() == MAX_ERROR_LINES {
            tail.pop_front();
        }
        tail.push_back(truncate(&line));
    }
    tail.into_iter().collect()
}

pub fn normalize_provider_event(value: &Value) -> Vec<Event> {
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match event_type {
        "thread.started" => text(value, "thread_id")
            .map(|id| Event::new(EventKind::Session { id }))
            .into_iter()
            .collect(),
        "turn.started" => vec![phase(Phase::Thinking, "Thinking")],
        "turn.completed" => {
            let usage = value.get("usage");
            usage
                .map(|usage| {
                    Event::new(EventKind::Usage {
                        input_tokens: number(usage, "input_tokens"),
                        cached_input_tokens: number(usage, "cached_input_tokens"),
                        output_tokens: number(usage, "output_tokens"),
                        reasoning_output_tokens: number(usage, "reasoning_output_tokens"),
                    })
                })
                .into_iter()
                .collect()
        }
        "turn.failed" => vec![Event::new(EventKind::Error {
            code: "turn_failed".into(),
            message: nested_text(value, &["error", "message"])
                .or_else(|| text(value, "message"))
                .unwrap_or_else(|| "The provider could not complete this turn.".into()),
            detail: None,
        })],
        "error" => vec![Event::new(EventKind::Error {
            code: "provider_error".into(),
            message: text(value, "message")
                .unwrap_or_else(|| "The provider reported an error.".into()),
            detail: None,
        })],
        "item.started" | "item.updated" | "item.completed" => normalize_item(value, event_type),
        _ => Vec::new(),
    }
}

fn normalize_item(value: &Value, event_type: &str) -> Vec<Event> {
    let Some(item) = value.get("item") else {
        return Vec::new();
    };
    let item_type = item
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("activity");
    let id = text(item, "id").unwrap_or_else(|| format!("{item_type}-unknown"));
    let completed = event_type == "item.completed";

    match item_type {
        "agent_message" => {
            if !completed {
                return Vec::new();
            }
            text(item, "text")
                .or_else(|| text(item, "message"))
                .filter(|content| !content.trim().is_empty())
                .map(|content| Event::new(EventKind::Message { id, text: content }))
                .into_iter()
                .collect()
        }
        "reasoning" => {
            if !completed {
                return Vec::new();
            }
            text(item, "text")
                .or_else(|| text(item, "message"))
                .filter(|content| !content.trim().is_empty())
                .map(|content| Event::new(EventKind::Thought { id, text: content }))
                .into_iter()
                .collect()
        }
        "command_execution" => {
            let command = command_text(item);
            let verification = looks_like_verification(&command);
            let status = activity_status(item, completed);
            let mut events = vec![phase(
                if verification {
                    Phase::Verifying
                } else {
                    Phase::Acting
                },
                if verification { "Verifying" } else { "Working" },
            )];
            events.push(Event::new(EventKind::Activity {
                id,
                label: command
                    .lines()
                    .next()
                    .map(truncate)
                    .filter(|line| !line.is_empty())
                    .unwrap_or_else(|| "Ran a command".into()),
                detail: activity_detail(item),
                status,
            }));
            events
        }
        "file_change" => vec![
            phase(Phase::Acting, "Editing"),
            Event::new(EventKind::Activity {
                id,
                label: file_change_label(item),
                detail: activity_detail(item),
                status: activity_status(item, completed),
            }),
        ],
        "mcp_tool_call" => vec![
            phase(Phase::Acting, "Using a tool"),
            Event::new(EventKind::Activity {
                id,
                label: mcp_label(item),
                detail: activity_detail(item),
                status: activity_status(item, completed),
            }),
        ],
        "web_search" => vec![
            phase(Phase::Acting, "Researching"),
            Event::new(EventKind::Activity {
                id,
                label: text(item, "query")
                    .map(|query| format!("Searched for {query}"))
                    .unwrap_or_else(|| "Searched the web".into()),
                detail: None,
                status: activity_status(item, completed),
            }),
        ],
        "todo_list" => vec![Event::new(EventKind::Activity {
            id,
            label: "Updated the plan".into(),
            detail: activity_detail(item),
            status: activity_status(item, completed),
        })],
        other => vec![Event::new(EventKind::Activity {
            id,
            label: humanize(other),
            detail: activity_detail(item),
            status: activity_status(item, completed),
        })],
    }
}

fn phase(phase: Phase, label: impl Into<String>) -> Event {
    Event::new(EventKind::Phase {
        phase,
        label: label.into(),
    })
}

fn activity_status(item: &Value, completed: bool) -> ActivityStatus {
    if !completed {
        return ActivityStatus::Running;
    }
    let failed = item
        .get("exit_code")
        .and_then(Value::as_i64)
        .is_some_and(|code| code != 0)
        || text(item, "status")
            .is_some_and(|status| matches!(status.as_str(), "failed" | "error" | "declined"));
    if failed {
        ActivityStatus::Failed
    } else {
        ActivityStatus::Completed
    }
}

fn command_text(item: &Value) -> String {
    match item.get("command") {
        Some(Value::String(command)) => command.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

fn looks_like_verification(command: &str) -> bool {
    let command = command.to_ascii_lowercase();
    [
        " test",
        "test ",
        "pytest",
        "vitest",
        "jest",
        "cargo test",
        "cargo clippy",
        " typecheck",
        "lint",
        "check",
        "build",
        "verify",
    ]
    .iter()
    .any(|needle| command.contains(needle))
}

fn activity_detail(item: &Value) -> Option<String> {
    ["aggregated_output", "output", "result", "changes"]
        .into_iter()
        .find_map(|key| item.get(key))
        .and_then(value_to_text)
        .filter(|detail| !detail.trim().is_empty())
        .map(|detail| truncate(&detail))
}

fn value_to_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Null => None,
        other => serde_json::to_string_pretty(other).ok(),
    }
}

fn file_change_label(item: &Value) -> String {
    item.get("changes")
        .and_then(Value::as_array)
        .map(|changes| match changes.len() {
            0 => "Prepared file changes".into(),
            1 => "Changed 1 file".into(),
            count => format!("Changed {count} files"),
        })
        .unwrap_or_else(|| "Applied file changes".into())
}

fn mcp_label(item: &Value) -> String {
    let server = text(item, "server").or_else(|| text(item, "server_name"));
    let tool = text(item, "tool").or_else(|| text(item, "tool_name"));
    match (server, tool) {
        (Some(server), Some(tool)) => format!("{server} · {tool}"),
        (_, Some(tool)) => tool,
        _ => "Used an external tool".into(),
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn nested_text(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(str::to_owned)
}

fn number(value: &Value, key: &str) -> u64 {
    let mut current = value;
    for segment in key.split('/') {
        let Some(next) = current.get(segment) else {
            return 0;
        };
        current = next;
    }
    current.as_u64().unwrap_or_default()
}

fn humanize(value: &str) -> String {
    let mut chars = value.replace(['_', '-'], " ").chars().collect::<Vec<_>>();
    if let Some(first) = chars.first_mut() {
        first.make_ascii_uppercase();
    }
    chars.into_iter().collect()
}

fn truncate(value: &str) -> String {
    let count = value.chars().count();
    if count <= MAX_DETAIL_CHARS {
        return value.trim_end().to_owned();
    }
    let prefix = value.chars().take(MAX_DETAIL_CHARS).collect::<String>();
    format!(
        "{}\n… {} characters folded",
        prefix.trim_end(),
        count - MAX_DETAIL_CHARS
    )
}

async fn emit(event: Event) -> Result<()> {
    let mut stdout = tokio::io::stdout();
    let mut line = serde_json::to_vec(&event).context("failed to encode event")?;
    line.push(b'\n');
    stdout
        .write_all(&line)
        .await
        .context("failed to write event")?;
    stdout.flush().await.context("failed to flush event")
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::*;

    #[test]
    fn normalizes_agent_message() {
        let source = json!({
            "type": "item.completed",
            "item": {"id": "answer-1", "type": "agent_message", "text": "Done."}
        });

        assert_eq!(
            normalize_provider_event(&source),
            vec![Event::new(EventKind::Message {
                id: "answer-1".into(),
                text: "Done.".into(),
            })]
        );
    }

    #[test]
    fn test_command_moves_run_into_verification_phase() {
        let source = json!({
            "type": "item.started",
            "item": {"id": "cmd-1", "type": "command_execution", "command": "cargo test"}
        });

        let events = normalize_provider_event(&source);

        assert_eq!(
            events[0],
            Event::new(EventKind::Phase {
                phase: Phase::Verifying,
                label: "Verifying".into(),
            })
        );
    }

    #[test]
    fn failed_command_is_visible() {
        let source = json!({
            "type": "item.completed",
            "item": {
                "id": "cmd-2",
                "type": "command_execution",
                "command": "pnpm test",
                "exit_code": 1,
                "aggregated_output": "one test failed"
            }
        });

        let events = normalize_provider_event(&source);

        assert!(matches!(
            events[1].kind,
            EventKind::Activity {
                status: ActivityStatus::Failed,
                ..
            }
        ));
    }

    #[test]
    fn openai_response_ids_are_unique_between_runs() {
        assert_ne!(unique_openai_response_id(), unique_openai_response_id());
    }

    #[test]
    fn parses_openai_compatible_sse_delta() {
        let delta = parse_openai_sse_line(r#"data: {"choices":[{"delta":{"content":"Hello"}}]}"#)
            .expect("delta parses");

        assert_eq!(delta.text.as_deref(), Some("Hello"));
        assert!(!delta.done);
    }

    #[test]
    fn parses_openai_compatible_nested_usage() {
        let delta = parse_openai_sse_line(
            r#"data: {"usage":{"prompt_tokens":11,"prompt_tokens_details":{"cached_tokens":3},"completion_tokens":7,"completion_tokens_details":{"reasoning_tokens":2}}}"#,
        )
        .expect("usage parses");

        assert_eq!(
            delta.usage,
            Some(UsageCounts {
                input_tokens: 11,
                cached_input_tokens: 3,
                output_tokens: 7,
                reasoning_output_tokens: 2,
            }),
        );
    }

    #[test]
    fn recognizes_openai_compatible_sse_done_marker() {
        let delta = parse_openai_sse_line("data: [DONE]").expect("done parses");

        assert!(delta.done);
        assert_eq!(delta.text, None);
    }

    #[tokio::test]
    async fn request_wait_can_be_cancelled_before_headers() {
        let outcome = response_or_stop(
            std::future::pending::<Result<(), ()>>(),
            std::future::ready(Ok::<(), ()>(())),
        )
        .await;

        assert!(matches!(outcome, RequestWait::Stopped));
    }

    #[test]
    fn sse_decoder_rejects_eof_before_done() {
        let mut decoder = OpenAiSseDecoder::default();
        decoder
            .push(b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n")
            .expect("chunk parses");

        let error = decoder.finish().expect_err("truncated stream must fail");

        assert!(error.to_string().contains("before [DONE]"));
    }

    #[test]
    fn sse_decoder_processes_done_without_trailing_newline() {
        let mut decoder = OpenAiSseDecoder::default();

        let deltas = decoder
            .push(b"data: {\"choices\":[{\"delta\":{\"content\":\"complete\"}}]}\n\ndata: [DONE]")
            .expect("chunk parses");
        let final_deltas = decoder.finish().expect("completed stream succeeds");

        assert_eq!(deltas[0].text.as_deref(), Some("complete"));
        assert!(final_deltas.iter().any(|delta| delta.done));
    }

    #[test]
    fn sse_decoder_rejects_malformed_data_events() {
        let mut decoder = OpenAiSseDecoder::default();

        let error = decoder
            .push(b"data: {not-json}\n\n")
            .expect_err("malformed data must fail");

        assert!(error.to_string().contains("malformed"));
    }

    #[test]
    fn sse_decoder_preserves_utf8_split_across_chunks() {
        let mut decoder = OpenAiSseDecoder::default();
        let event = "data: {\"choices\":[{\"delta\":{\"content\":\"héllo\"}}]}\n\n".as_bytes();
        let split = event
            .windows(2)
            .position(|window| window == "é".as_bytes())
            .expect("multibyte character exists")
            + 1;

        assert!(
            decoder
                .push(&event[..split])
                .expect("first chunk buffers")
                .is_empty()
        );
        let deltas = decoder.push(&event[split..]).expect("second chunk parses");
        decoder.push(b"data: [DONE]\n\n").expect("done parses");
        decoder.finish().expect("completed stream succeeds");

        assert_eq!(deltas[0].text.as_deref(), Some("héllo"));
    }

    #[test]
    fn sse_decoder_joins_multiline_data_at_event_boundaries() {
        let mut decoder = OpenAiSseDecoder::default();
        let deltas = decoder
            .push(
                b"data: {\"choices\":\n\
data: [{\"delta\":{\"content\":\"joined\"}}]}\n\n",
            )
            .expect("multiline event parses");
        decoder.push(b"data: [DONE]\n\n").expect("done parses");
        decoder.finish().expect("completed stream succeeds");

        assert_eq!(deltas[0].text.as_deref(), Some("joined"));
    }
}
