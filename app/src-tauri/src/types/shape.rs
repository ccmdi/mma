//! What a destination keeps of a map. Every writer and every sync provider names its [`MapShape`]
//! and asks [`MapShape::keeps`]; nothing else decides what survives.

use serde::{Deserialize, Serialize};

wire_str_enum! {
    /// How much of a map a destination keeps. Each shape keeps everything the one before it does.
    derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, specta::Type)
    pub enum MapShape {
        /// Coordinates, camera and pinned panoramas: what GeoGuessr stores.
        GeoGuessr = "geoguessr",
        /// Adds tags, unpinned panoramas, capture months and location flags: what map-making.app stores.
        MapMaking = "mapMaking",
        /// Everything this app stores, including custom fields.
        Local = "local",
    }
}

/// A part of a map that not every shape keeps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MapPart {
    /// Tag membership, and each tag's color and order.
    Tags,
    /// A panorama id on a location that does not load it.
    UnpinnedPano,
    /// The capture month of a location's panorama.
    PanoDate,
    /// Location flag bits beyond pinning.
    Flags,
    /// Custom fields and their definitions, and every key on an interned value's record beyond its color and order.
    AppData,
}

impl MapPart {
    /// The smallest shape that keeps this part.
    const fn floor(self) -> MapShape {
        match self {
            MapPart::Tags | MapPart::UnpinnedPano | MapPart::PanoDate | MapPart::Flags => {
                MapShape::MapMaking
            }
            MapPart::AppData => MapShape::Local,
        }
    }
}

impl MapShape {
    pub fn keeps(self, part: MapPart) -> bool {
        self >= part.floor()
    }
}

#[cfg(test)]
#[path = "shape.test.rs"]
mod tests;
