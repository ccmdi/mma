//! The frames a host and its peers exchange, each kind only the way it travels, and how they
//! encode.

use crate::store::engine::{whole, Entry, Intent, Store, ValueRecord};
use crate::store::maps::{FieldDef, MapMeta};
use crate::types::{AppError, AppResult, Location};
use mma_algebra::{Encode, Id, IdRange, Json, Patch, Patchable};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::value::RawValue;
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

/// The protocol this app speaks. A peer speaking another is refused.
pub(crate) const PROTOCOL: u32 = 5;

/// The most bytes one frame encodes to.
pub(crate) const MAX_FRAME: usize = 32 << 20;

/// The most rows one snapshot frame carries.
const CHUNK_ROWS: usize = 2000;

/// Where a returning peer left off: the session it was in and the last change it applied.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct Resume {
    pub(crate) session: u64,
    pub(crate) seq: u64,
}

/// What someone shows everyone else in a session, which only the plugin reads.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(transparent)]
pub(crate) struct Shown(
    #[specta(type = specta_typescript::Unknown)] pub(crate) Json<Box<RawValue>>,
);

impl PartialEq for Shown {
    fn eq(&self, other: &Self) -> bool {
        self.0.get() == other.0.get()
    }
}

/// Someone in a session: the login their room vouched for, and whether they joined as a guest
/// with an invite code rather than an account.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub(crate) struct Member {
    /// Their login.
    pub(crate) login: String,
    /// Whether they joined with an invite code.
    pub(crate) guest: bool,
}

/// What a peer sends its host.
#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) enum Up {
    /// The first frame: the protocol the peer speaks and where it left off.
    Hello {
        protocol: u32,
        resume: Option<Resume>,
    },
    /// A request the host answers with a reply numbered `id`.
    Call { id: u64, call: Call },
    /// The peer missed a change and asks for the map again.
    Resync,
    /// What the peer shows everyone else, which only the plugin reads.
    Presence(Shown),
    /// The peer leaves.
    Bye,
}

/// What a host sends its peers.
#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) enum Down {
    /// The peer is in: the session, everyone here, and how it catches up.
    Welcome {
        session: u64,
        roster: Vec<Member>,
        catchup: Catchup,
    },
    /// The host's change `seq`.
    Change {
        seq: u64,
        #[serde(with = "whole")]
        change: Arc<Entry>,
    },
    /// Part of the map as the host holds it.
    Snapshot(Part),
    /// The answer to call `id`.
    Reply {
        id: u64,
        reply: Result<Reply, String>,
    },
    /// Everyone in the session now, the host first.
    Roster(Vec<Member>),
    /// What `login` shows everyone else.
    Presence { login: String, data: Shown },
    /// The session is over for this peer.
    End(End),
}

/// How a welcomed peer catches up.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) enum Catchup {
    /// The changes it missed follow.
    Replay,
    /// The whole map follows.
    Snapshot,
}

/// One part of a snapshot.
#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) enum Part {
    /// The map besides its rows.
    Head(Box<Head>),
    /// Some of the rows.
    Rows(Vec<Location>),
    /// The last part.
    End,
}

/// What a peer asks its host for.
#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) enum Call {
    /// Make a write.
    Write(Intent),
    /// Lend this many ids for the peer's new rows.
    Lease(u32),
}

/// What a host answers a call with.
#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) enum Reply {
    /// The write was made.
    Wrote(Wrote),
    /// The ids lent.
    Lent(IdRange<Location>),
}

/// A write a host made: the change that carries it, which follows this answer, or none when it
/// changed nothing, the keys it gave new value records, how many locations it changed, and
/// the locations a work could not work out a value for.
#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct Wrote {
    pub(crate) seq: Option<u64>,
    pub(crate) keys: Vec<Id<ValueRecord>>,
    pub(crate) changed: u32,
    pub(crate) failed: Vec<Id<Location>>,
}

impl TryFrom<Reply> for Wrote {
    type Error = AppError;

    fn try_from(reply: Reply) -> AppResult<Self> {
        match reply {
            Reply::Wrote(wrote) => Ok(wrote),
            Reply::Lent(_) => Err("the map's host answered a write with ids".into()),
        }
    }
}

impl TryFrom<Reply> for IdRange<Location> {
    type Error = AppError;

    fn try_from(reply: Reply) -> AppResult<Self> {
        match reply {
            Reply::Lent(range) => Ok(range),
            Reply::Wrote(_) => Err("the map's host answered a lease with a write".into()),
        }
    }
}

/// What a host's map shared after change `seq`, besides its rows, and how many rows it held.
#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct Head {
    pub(crate) seq: u64,
    #[serde(serialize_with = "Encode::encode")]
    pub(crate) meta: Patch<MapMeta>,
    pub(crate) defs: HashMap<String, FieldDef>,
    pub(crate) records: HashMap<String, HashMap<Id<ValueRecord>, ValueRecord>>,
    pub(crate) total: u64,
}

/// What a map shares with the people in its session, whole: its rows by id, value records,
/// field definitions and details, never this device's own details or its selections.
#[derive(Debug)]
pub(crate) struct Snapshot {
    pub(crate) head: Head,
    pub(crate) rows: Vec<Location>,
}

impl Snapshot {
    /// What `store`'s map shares after change `seq`.
    pub(crate) fn of(store: &Store, seq: u64) -> Self {
        let mut rows: Vec<Location> = store.all().rows().map(|row| row.to_location()).collect();
        rows.sort_by_key(|row| row.id);
        let mut meta = store.meta.to_patch();
        meta.take_local();
        let head = Head {
            seq,
            meta,
            defs: (*store.field_defs).clone(),
            records: store
                .records
                .iter()
                .filter(|(_, records)| !records.is_empty())
                .map(|(field, records)| (field.clone(), (**records).clone()))
                .collect(),
            total: rows.len() as u64,
        };
        Snapshot { head, rows }
    }

    /// The frames that carry this map, its rows in chunks of at most [`CHUNK_ROWS`].
    pub(crate) fn frames(self) -> AppResult<Vec<Vec<u8>>> {
        let head = Down::Snapshot(Part::Head(Box::new(self.head)));
        let mut frames = vec![head.encode()?];
        for chunk in self.rows.chunks(CHUNK_ROWS) {
            frames.push(Down::Snapshot(Part::Rows(chunk.to_vec())).encode()?);
        }
        frames.push(Down::Snapshot(Part::End).encode()?);
        Ok(frames)
    }
}

/// Why the session is over for a peer.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) enum End {
    /// The host turned the peer away, saying why.
    Refused(String),
    /// The host ended the session, saying why.
    Ended(String),
}

/// How a peer's connection to its host ended.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Parting {
    /// The session is over for the peer.
    Over(End),
    /// The peer left.
    Left,
    /// The connection closed without the session ending, so the peer connects again.
    Lost,
}

impl From<End> for Parting {
    fn from(end: End) -> Self {
        Parting::Over(end)
    }
}

impl fmt::Display for Parting {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Parting::Over(End::Refused(reason) | End::Ended(reason)) => f.write_str(reason),
            Parting::Left => f.write_str("left the map's session"),
            Parting::Lost => f.write_str("lost the connection to the map's host"),
        }
    }
}

/// A message one end of a session sends the other, encoded within [`MAX_FRAME`].
pub(crate) trait Frame: Serialize + DeserializeOwned {
    /// This frame's bytes, refused past [`MAX_FRAME`].
    fn encode(&self) -> AppResult<Vec<u8>> {
        let bytes = postcard::to_stdvec(self)
            .map_err(|error| AppError(format!("a collab frame did not encode: {error}")))?;
        if bytes.len() > MAX_FRAME {
            return Err(AppError(format!(
                "a collab frame of {} bytes is over the {MAX_FRAME} byte limit",
                bytes.len()
            )));
        }
        Ok(bytes)
    }

    /// This frame's bytes, or none, said in the log, when it does not encode.
    fn bytes(&self) -> Option<Vec<u8>> {
        self.encode()
            .map_err(|error| log::warn!("[collab] a frame was not sent: {}", error.0))
            .ok()
    }

    /// The frame `bytes` hold, refused past [`MAX_FRAME`].
    fn decode(bytes: &[u8]) -> AppResult<Self> {
        if bytes.len() > MAX_FRAME {
            return Err(AppError(format!(
                "a collab frame of {} bytes is over the {MAX_FRAME} byte limit",
                bytes.len()
            )));
        }
        postcard::from_bytes(bytes)
            .map_err(|error| AppError(format!("a collab frame did not decode: {error}")))
    }
}

impl Frame for Up {}

impl Frame for Down {}

#[cfg(test)]
#[path = "protocol.test.rs"]
mod tests;
