//! Arrow IPC files: buffered atomic writes, mmap reads, orphaned temp sweep.

use super::*;
use crate::store::arrow::migrate;
use crate::store::storage::atomic_write;
use crate::types::{AppError, AppResult};
use arrow_ipc::reader::FileReader;
use arrow_ipc::writer::FileWriter;
use arrow_select::concat;
use std::fs::File;
use std::io::BufWriter;
use std::panic;
use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::sync::Arc;

/// Atomically write a RecordBatch to an Arrow IPC file.
///
/// Uses a 1 MB `BufWriter` (unbuffered writes are ~15x slower on Windows).
/// The write targets a `.tmp` sibling then renames, so readers never see
/// a partial file.
pub(crate) fn write_arrow_ipc(path: &Path, batch: &RecordBatch) -> AppResult<()> {
    atomic_write(path, |file| {
        let buf = BufWriter::with_capacity(1 << 20, file);
        let mut writer = FileWriter::try_new(buf, &batch.schema())?;
        writer.write(batch)?;
        writer.finish()?;
        Ok(())
    })
}

/// Read an Arrow IPC file into a single RecordBatch.
///
/// If the file contains multiple batches they are concatenated. An empty or
/// missing-batch file returns an empty batch with the location schema.
pub(crate) fn read_arrow_ipc(path: &Path) -> AppResult<RecordBatch> {
    let file = File::open(path)?;
    let reader = FileReader::try_new(file, None)?;
    let mut batches = Vec::new();
    for batch in reader {
        batches.push(migrate::migrate(batch?)?);
    }
    if batches.is_empty() {
        return Ok(RecordBatch::new_empty(Arc::new(location_schema())));
    }
    if batches.len() == 1 {
        return Ok(batches.into_iter().next().unwrap());
    }
    let schema = Arc::new(location_schema());
    concat::concat_batches(&schema, &batches).map_err(AppError::from)
}

/// Keeps the mmap alive for as long as the RecordBatch references it.
pub(crate) struct MmapHandle {
    _buffer: arrow_buffer::Buffer,
}

/// Zero-copy Arrow IPC read via memory-mapped file.
///
/// Returns the batch alongside an [`MmapHandle`] that must be kept alive for
/// as long as any array data from the batch is referenced. Parses the IPC
/// footer and record-batch blocks directly from the mmap buffer, avoiding
/// any heap allocation for the raw column data.
pub(crate) fn read_arrow_ipc_mmap(path: &Path) -> AppResult<(RecordBatch, MmapHandle)> {
    use arrow_buffer::Buffer;
    use arrow_ipc::reader::{read_footer_length, FileDecoder};
    use arrow_ipc::{convert::fb_to_schema, root_as_footer};
    use std::sync::Arc;

    let file = File::open(path)?;
    // SAFETY: we own the file exclusively; no other process modifies it while mapped.
    // On Windows, the mmap holds an exclusive lock preventing external modification.
    let mmap = unsafe { memmap2::Mmap::map(&file) }?;
    let buffer = Buffer::from(bytes::Bytes::from_owner(mmap));

    let buf_len = buffer.len();
    if buf_len < 10 {
        return Err(AppError(format!(
            "Arrow file {} is truncated ({buf_len} bytes)",
            path.display()
        )));
    }

    let trailer: [u8; 10] = buffer[buf_len - 10..].try_into().unwrap();
    let footer_len = read_footer_length(trailer)?;
    let footer = root_as_footer(&buffer[buf_len - 10 - footer_len..buf_len - 10])
        .map_err(|e| AppError(e.to_string()))?;
    let fb_schema = footer.schema().ok_or_else(|| {
        AppError(format!(
            "Arrow file {}: footer has no schema",
            path.display()
        ))
    })?;
    // fb_to_schema panics (not Errs) on out-of-range enum values in a corrupted footer.
    let schema = panic::catch_unwind(AssertUnwindSafe(|| fb_to_schema(fb_schema)))
        .map_err(|_| AppError(format!("Arrow file {}: corrupted footer", path.display())))?;
    let schema = Arc::new(schema);
    let mut decoder = FileDecoder::new(schema.clone(), footer.version());

    // Read dictionaries if present
    for block in footer.dictionaries().iter().flatten() {
        let block_len = block.bodyLength() as usize + block.metaDataLength() as usize;
        let data = buffer.slice_with_length(block.offset() as usize, block_len);
        decoder.read_dictionary(block, &data)?;
    }

    let blocks = footer.recordBatches();
    let blocks = blocks.as_ref();
    #[allow(clippy::redundant_closure_for_method_calls)]
    let empty = blocks.map_or(true, |b| b.is_empty());
    if empty {
        return Ok((
            RecordBatch::new_empty(schema),
            MmapHandle { _buffer: buffer },
        ));
    }
    let blocks = blocks.unwrap();

    if blocks.len() == 1 {
        let block = blocks.get(0);
        let block_len = block.bodyLength() as usize + block.metaDataLength() as usize;
        let data = buffer.slice_with_length(block.offset() as usize, block_len);
        let batch = decoder
            .read_record_batch(block, &data)?
            .unwrap_or_else(|| RecordBatch::new_empty(schema));
        Ok((migrate::migrate(batch)?, MmapHandle { _buffer: buffer }))
    } else {
        let mut batches = Vec::with_capacity(blocks.len());
        for i in 0..blocks.len() {
            let block = blocks.get(i);
            let block_len = block.bodyLength() as usize + block.metaDataLength() as usize;
            let data = buffer.slice_with_length(block.offset() as usize, block_len);
            if let Some(batch) = decoder.read_record_batch(block, &data)? {
                batches.push(batch);
            }
        }
        let merged = concat::concat_batches(&schema, &batches)?;
        Ok((migrate::migrate(merged)?, MmapHandle { _buffer: buffer }))
    }
}
