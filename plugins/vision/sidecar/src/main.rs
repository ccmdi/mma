mod fetch;
mod embed;
mod project;
mod search;
mod serve;

use clap::{Parser, Subcommand};
use std::io::{self, Write};

/// MMA hands every command the same two directories, so they are global rather than
/// repeated per subcommand.
#[derive(Parser)]
#[command(name = "mma-vision", about = "Vision analysis sidecar for MMA")]
struct Cli {
    #[command(subcommand)]
    command: Command,
    /// Where the ONNX models live (inside the sidecar bundle).
    #[arg(long, global = true, default_value = "models")]
    model_dir: String,
    /// Working data owned by this sidecar. Survives sidecar updates.
    #[arg(long, global = true, default_value = "data")]
    data_dir: String,
}

#[derive(Subcommand)]
enum Command {
    /// List pano IDs already in the embedding cache
    ListCached,
    /// Batch-compute CLIP image embeddings
    Embed {
        #[arg(long)]
        input: String,
    },
    /// Text-to-image search over cached embeddings
    SearchText {
        #[arg(long)]
        input: String,
    },
    /// Image-to-image similarity search
    SearchImage {
        #[arg(long)]
        input: String,
    },
    /// Resident search server: models + cache stay loaded across queries.
    /// Prints `{"port":N}` on stdout, serves /search-text, /search-image,
    /// /list-cached, /ping on 127.0.0.1, and exits by itself after `idle_secs`
    /// without a request.
    Serve {
        #[arg(long, default_value_t = 600)]
        idle_secs: u64,
    },
    /// Debug: fetch, stitch, crop a single pano and save images
    DebugCrops {
        #[arg(long)]
        pano_id: String,
        #[arg(long)]
        world_width: u32,
        #[arg(long)]
        world_height: u32,
        #[arg(long)]
        output_dir: String,
    },
}

fn read_input(path: &str) -> String {
    std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("failed to read input file {path}: {e}"))
}

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

    if eps.is_empty() {
        eprintln!("[vision] GPU: none compiled, using CPU");
    } else {
        let ok = ort::init().with_execution_providers(eps).commit();
        if ok {
            eprintln!("[vision] GPU: registered {}", ep_names.join(", "));
        } else {
            eprintln!("[vision] GPU: init failed (env already set), falling back to CPU");
        }
    }
}

fn main() {
    init_ort();
    let cli = Cli::parse();
    let Cli { model_dir, data_dir, command } = cli;
    let mut stdout = io::stdout();

    match command {
        Command::ListCached => {
            let cache = embed::EmbedCache::load(&data_dir);
            let out = serde_json::to_string(&cache.pano_ids()).unwrap();
            writeln!(stdout, "{out}").ok();
            stdout.flush().ok();
        }
        Command::Embed { input } => {
            let input: embed::EmbedInput =
                serde_json::from_str(&read_input(&input)).expect("invalid input JSON");
            embed::run(&input, &model_dir, &data_dir, |status| {
                let line = serde_json::to_string(&status).unwrap();
                writeln!(stdout, "{line}").ok();
                stdout.flush().ok();
            });
        }
        Command::SearchText { input } => {
            let input: search::TextSearchInput =
                serde_json::from_str(&read_input(&input)).expect("invalid input JSON");
            let results = search::text_search(&input, &model_dir, &data_dir);
            let out = serde_json::to_string(&results).unwrap();
            writeln!(stdout, "{out}").ok();
            stdout.flush().ok();
        }
        Command::SearchImage { input } => {
            let input: search::ImageSearchInput =
                serde_json::from_str(&read_input(&input)).expect("invalid input JSON");
            let results = search::image_search(&input, &data_dir);
            let out = serde_json::to_string(&results).unwrap();
            writeln!(stdout, "{out}").ok();
            stdout.flush().ok();
        }
        Command::Serve { idle_secs } => {
            serve::run(&model_dir, &data_dir, idle_secs);
        }
        Command::DebugCrops { pano_id, world_width, world_height, output_dir } => {
            let out = std::path::Path::new(&output_dir);
            std::fs::create_dir_all(out).ok();
            let fetched = fetch::fetch_panos_concurrent(&[(pano_id.as_str(), world_width, world_height)]);
            let pano = fetched.get(&pano_id).expect("fetch failed").as_ref().expect("fetch error");
            println!("Stitched pano: {}x{}", pano.width(), pano.height());
            pano.save(out.join("pano_stitched.png")).expect("save failed");
            let crops = embed::debug_extract_crops(pano);
            for (i, crop) in crops.iter().enumerate() {
                let name = format!("crop_{}_{}deg.png", i, i * 90);
                crop.save(out.join(&name)).expect("save failed");
                println!("Saved {name} ({}x{})", crop.width(), crop.height());
            }
        }
    }
}
