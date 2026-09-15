pub mod decode;
pub mod paths;
use std::path::Path;
use vali_core::Location;
pub fn decode_file(path: &Path) -> anyhow::Result<Vec<Location>> {
    let file =
        std::fs::File::open(path).map_err(|e| anyhow::anyhow!("open {}: {e}", path.display()))?;
    let mmap = unsafe { memmap2::Mmap::map(&file)? };
    decode::decode_locations(&mmap)
}
