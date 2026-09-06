mod detect;
mod fetch;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use clap::{Parser, Subcommand};
use std::io::{self, Write};

/// MMA hands every command the same two directories, so they are global rather than
/// repeated per subcommand.
#[derive(Parser)]
#[command(name = "mma-copyright", about = "Copyright year detection sidecar for MMA")]
struct Cli {
    #[command(subcommand)]
    command: Command,
    /// Where the ONNX models live (inside the sidecar bundle).
    #[arg(long, global = true, default_value = "models")]
    model_dir: String,
    /// Working data owned by this sidecar. Accepted but unused: detection is stateless.
    #[arg(long, global = true, default_value = "data")]
    data_dir: String,
}

#[derive(Subcommand)]
enum Command {
    /// Detect copyright year from pano tiles
    Detect {
        #[arg(long)]
        input: String,
    },
}

fn read_input(path: &str) -> String {
    std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("failed to read input file {path}: {e}"))
}

#[allow(unused_mut, reason = "every execution provider push is feature-gated")]
#[allow(unused_mut, reason = "every execution provider push is feature-gated")]
fn init_ort() {
    let mut ep_names: Vec<&str> = Vec::new();
    let mut eps: Vec<ort::execution_providers::ExecutionProviderDispatch> = Vec::new();

    #[cfg(feature = "directml")]
    { eps.push(ort::ep::DirectML::default().build()); ep_names.push("DirectML"); }

    #[cfg(feature = "coreml")]
    { eps.push(ort::ep::CoreML::default().build()); ep_names.push("CoreML"); }

    #[cfg(feature = "cuda")]
    { eps.push(ort::ep::CUDA::default().build()); ep_names.push("CUDA"); }

    if !eps.is_empty() {
        let ok = ort::init().with_execution_providers(eps).commit();
        if ok {
            eprintln!("[copyright] GPU: registered {}", ep_names.join(", "));
        }
    }
}

fn main() {
    init_ort();
    let Cli { command, model_dir, data_dir: _ } = Cli::parse();
    let mut stdout = io::stdout();

    match command {
        Command::Detect { input } => {
            let input: detect::DetectInput =
                serde_json::from_str(&read_input(&input)).expect("invalid input JSON");
            detect::run(&input, &model_dir, |result| {
                let line = serde_json::to_string(&result).unwrap();
                writeln!(stdout, "{line}").ok();
                stdout.flush().ok();
            });
        }
    }
}
