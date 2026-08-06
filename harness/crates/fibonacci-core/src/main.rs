use anyhow::Result;
use clap::{Parser, Subcommand, ValueEnum};
use fibonacci_core::runner::{Provider, RunOptions, run};

#[derive(Debug, Parser)]
#[command(
    name = "fibonacci-core",
    version,
    about = "Provider process and event core for Fibonacci"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Run one provider turn and emit normalized JSONL events.
    Run {
        /// Provider adapter to use.
        #[arg(long, value_enum, default_value_t = Provider::Codex)]
        provider: Provider,

        /// Workspace the provider may inspect and modify.
        #[arg(long)]
        cwd: String,

        /// Provider model override.
        #[arg(long)]
        model: Option<String>,

        /// Codex sandbox policy for a new session.
        #[arg(long, value_enum, default_value_t = Sandbox::WorkspaceWrite)]
        sandbox: Sandbox,

        /// Existing provider session to resume.
        #[arg(long)]
        session: Option<String>,

        /// Codex executable name or path.
        #[arg(long, default_value = "codex", env = "FIBONACCI_CODEX")]
        codex_bin: String,

        /// OpenAI-compatible API base URL.
        #[arg(
            long,
            default_value = "http://127.0.0.1:1234/v1",
            env = "FIBONACCI_OPENAI_BASE_URL"
        )]
        base_url: String,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum Sandbox {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

impl Sandbox {
    fn as_codex_value(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::WorkspaceWrite => "workspace-write",
            Self::DangerFullAccess => "danger-full-access",
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Run {
            provider,
            cwd,
            model,
            sandbox,
            session,
            codex_bin,
            base_url,
        } => {
            run(RunOptions {
                provider,
                cwd,
                model,
                sandbox: sandbox.as_codex_value().into(),
                session,
                codex_bin,
                base_url,
            })
            .await
        }
    }
}
