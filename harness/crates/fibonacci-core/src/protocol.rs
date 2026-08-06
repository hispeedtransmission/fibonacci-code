use serde::Serialize;

pub const PROTOCOL_VERSION: u8 = 1;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Event {
    pub v: u8,
    #[serde(flatten)]
    pub kind: EventKind,
}

impl Event {
    pub fn new(kind: EventKind) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            kind,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventKind {
    RunStarted {
        provider: String,
        cwd: String,
        resumed: bool,
    },
    Session {
        id: String,
    },
    Phase {
        phase: Phase,
        label: String,
    },
    Message {
        id: String,
        text: String,
    },
    MessageDelta {
        id: String,
        delta: String,
    },
    Thought {
        id: String,
        text: String,
    },
    Activity {
        id: String,
        label: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        status: ActivityStatus,
    },
    Usage {
        input_tokens: u64,
        cached_input_tokens: u64,
        output_tokens: u64,
        reasoning_output_tokens: u64,
    },
    Notice {
        level: NoticeLevel,
        text: String,
    },
    Error {
        code: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    Done {
        outcome: Outcome,
        elapsed_ms: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Ready,
    Thinking,
    Acting,
    Verifying,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityStatus {
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoticeLevel {
    Info,
    Warning,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Completed,
    Stopped,
    Failed,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_serializes_with_version_and_discriminator() {
        let event = Event::new(EventKind::Phase {
            phase: Phase::Thinking,
            label: "Inspecting".into(),
        });

        let value = serde_json::to_value(event).expect("event serializes");

        assert_eq!(value["v"], 1);
        assert_eq!(value["type"], "phase");
        assert_eq!(value["phase"], "thinking");
        assert_eq!(value["label"], "Inspecting");
    }
}
