use super::{FilterOp, Selection, Selector, Thinning};
use crate::store::engine::ListedSelection;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct SelectionInput {
    pub selector: Selector<SelectionInput>,
    #[serde(default)]
    #[specta(optional)]
    pub color: Option<[u8; 3]>,
}

impl SelectionInput {
    pub fn compile(self) -> Selection {
        let selector = self.selector.map_children(Self::compile);
        let mut selection = Selection::of(selector);
        selection.color = self.color.unwrap_or_else(|| match &selection.selector {
            Selector::Reviewed { mode, .. } => {
                hsl(if mode == "unreviewed" { 280.0 } else { 145.0 }, 0.6, 0.5)
            }
            _ => selection.color,
        });
        selection
    }
}

fn number(n: f64) -> String {
    if n == 0.0 {
        return "0".into();
    }
    if (1e-6..1e21).contains(&n.abs()) {
        return n.to_string();
    }
    let n = format!("{n:e}");
    let (mantissa, exponent) = n.split_once('e').expect("scientific number");
    let exponent: i32 = exponent.parse().expect("numeric exponent");
    format!(
        "{mantissa}e{}{exponent}",
        if exponent >= 0 { "+" } else { "" }
    )
}

fn value(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => "null".into(),
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => number(n.as_f64().unwrap_or_default()),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Array(a) => a
            .iter()
            .map(|v| if v.is_null() { String::new() } else { value(v) })
            .collect::<Vec<_>>()
            .join(","),
        serde_json::Value::Object(_) => "[object Object]".into(),
    }
}

fn base36(mut n: u32) -> String {
    if n == 0 {
        return "0".into();
    }
    let mut digits = Vec::new();
    while n > 0 {
        digits.push(char::from_digit(n % 36, 36).unwrap());
        n /= 36;
    }
    digits.into_iter().rev().collect()
}

pub fn key(selector: &Selector) -> String {
    let child = |s: &Option<Box<Selection>>| s.as_ref().map_or("", |s| s.key.as_str()).to_string();
    let thin = |t: &Thinning| match t {
        Thinning::Count { n } => format!("count:{n}"),
        Thinning::Metres { m } => format!("metres:{}", number(*m)),
    };
    match selector {
        Selector::Everything => "everything".into(),
        Selector::Selected => "selected".into(),
        Selector::Uncommitted => "uncommitted".into(),
        Selector::Manual { .. } => "manual".into(),
        Selector::Locations { locations, .. } => {
            let (mut a, mut b) = (0xdeadbeefu32, 0x41c6ce57u32);
            for id in locations {
                a = (a ^ id).wrapping_mul(2654435761);
                b = (b ^ id).wrapping_mul(1597334677);
            }
            a = (a ^ (a >> 16)).wrapping_mul(2246822507) ^ (b ^ (b >> 13)).wrapping_mul(3266489909);
            b = (b ^ (b >> 16)).wrapping_mul(2246822507) ^ (a ^ (a >> 13)).wrapping_mul(3266489909);
            format!("locations:{}:{}{}", locations.len(), base36(a), base36(b))
        }
        Selector::Polygon { polygon } => {
            let (mut a, mut b) = (0xdeadbeefu32, 0x41c6ce57u32);
            for ring in polygon
                .coordinates
                .iter()
                .chain(polygon.extra_polygons.iter().flatten().flatten())
            {
                for [lng, lat] in ring {
                    let (lng, lat) = (lng.to_bits(), lat.to_bits());
                    a = (a ^ lng as u32).wrapping_mul(2654435761) ^ (lng >> 32) as u32;
                    b = (b ^ lat as u32).wrapping_mul(1597334677) ^ (lat >> 32) as u32;
                }
            }
            format!("polygon:{}{}", base36(a), base36(b))
        }
        Selector::Duplicates { distance } => format!("duplicates:{}", number(*distance)),
        Selector::Validation { category, .. } => format!("validation:{category}"),
        Selector::Reviewed {
            session_id, mode, ..
        } => format!("review:{session_id}:{mode}"),
        Selector::Intersection { selections } | Selector::Union { selections } => selections
            .iter()
            .map(|s| format!("({})", s.key))
            .collect::<Vec<_>>()
            .join(if matches!(selector, Selector::Union { .. }) {
                "|"
            } else {
                "^"
            }),
        Selector::Invert { selections } => {
            format!("!{}", selections.first().map_or("", |s| &s.key))
        }
        Selector::Filter { field, test } => {
            let operands = match test {
                FilterOp::Has | FilterOp::Nothas => vec!["null".into()],
                FilterOp::Between { lo, hi, .. } => vec![value(lo), value(hi)],
                FilterOp::BetweenAnyyear { lo, hi, .. }
                | FilterOp::BetweenAnytime { lo, hi, .. } => vec![lo.clone(), hi.clone()],
                FilterOp::Eq { value: v }
                | FilterOp::Neq { value: v }
                | FilterOp::Contains { value: v }
                | FilterOp::Notcontains { value: v }
                | FilterOp::Gt { value: v, .. }
                | FilterOp::Lt { value: v, .. }
                | FilterOp::Gte { value: v, .. }
                | FilterOp::Lte { value: v, .. } => vec![value(v)],
            };
            let op = serde_json::to_value(test).unwrap()["op"]
                .as_str()
                .unwrap()
                .to_string();
            format!(
                "filter:{field}:{op}:{}{}",
                operands.join(":"),
                if test.tz_local() { ":local" } else { "" }
            )
        }
        Selector::Ranked {
            selection,
            expr,
            k,
            ascending,
        } => format!(
            "ranked:{expr}:{}:{ascending}:{}",
            k.map_or("null".into(), |k| k.to_string()),
            child(selection)
        ),
        Selector::Sample { selection, n } => format!("sample:{n}:{}", child(selection)),
        Selector::Spaced { selection, thin: t } => {
            format!("spaced:{}:{}", thin(t), child(selection))
        }
        Selector::EvenlySpaced { selection, thin: t } => {
            format!("evenlySpaced:{}:{}", thin(t), child(selection))
        }
        Selector::Nearby {
            selection,
            lat,
            lng,
            radius_m,
        } => format!(
            "nearby:{}:{}:{}:{}",
            number(*lat),
            number(*lng),
            number(*radius_m),
            child(selection)
        ),
        Selector::Nearest {
            selection,
            lat,
            lng,
        } => format!(
            "nearest:{}:{}:{}",
            number(*lat),
            number(*lng),
            child(selection)
        ),
    }
}

fn hsl(h: f64, s: f64, l: f64) -> [u8; 3] {
    let a = s * l.min(1.0 - l);
    [0.0, 8.0, 4.0].map(|n| {
        let k = (n + h / 30.0) % 12.0;
        (255.0 * (l - a * (k - 3.0).min(9.0 - k).min(1.0).max(-1.0))).round() as u8
    })
}

pub fn color(key: &str) -> [u8; 3] {
    let hash = key
        .encode_utf16()
        .fold(0i32, |h, c| h.wrapping_mul(33).wrapping_add(c as i32));
    let hash = hash.wrapping_mul(214013).wrapping_add(2531011);
    hsl((i64::from(hash).abs() % 360) as f64, 0.5, 0.5)
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Composition {
    Intersection,
    Union,
    Invert,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SelectionOp {
    Add {
        selections: Vec<SelectionInput>,
    },
    Set {
        selections: Vec<SelectionInput>,
    },
    Remove {
        keys: Vec<String>,
    },
    Toggle {
        selections: Vec<SelectionInput>,
    },
    Manual {
        id: u32,
    },
    Active {
        op: Box<SelectionOp>,
    },
    Combine {
        mode: Composition,
        keys: Option<Vec<String>>,
    },
    Ghost {
        index: usize,
    },
    Isolate {
        index: usize,
    },
    GhostAll,
    Invert {
        path: Vec<usize>,
    },
    Compose {
        drag: Vec<usize>,
        drop: Vec<usize>,
        mode: Composition,
    },
    Move {
        from: Vec<usize>,
        to: Vec<usize>,
        after: bool,
    },
    RemoveAt {
        path: Vec<usize>,
    },
    Replace {
        path: Vec<usize>,
        selection: SelectionInput,
    },
    Color {
        path: Vec<usize>,
        color: [u8; 3],
    },
    PolygonName {
        path: Vec<usize>,
        name: String,
    },
}

fn dedupe(rows: Vec<Selection>) -> Vec<Selection> {
    let mut keys = HashSet::new();
    rows.into_iter()
        .rev()
        .filter(|s| keys.insert(s.key.clone()))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn invert(selection: Selection) -> Selection {
    match selection.selector {
        Selector::Invert { mut selections } if !selections.is_empty() => selections.remove(0),
        _ => Selection::of(Selector::Invert {
            selections: vec![selection],
        }),
    }
}

fn combine(mode: Composition, rows: Vec<Selection>) -> Selection {
    if mode == Composition::Invert {
        return invert(combine(Composition::Union, rows));
    }
    let rows = dedupe(
        rows.into_iter()
            .flat_map(|s| match (mode, &s.selector) {
                (Composition::Union, Selector::Union { selections })
                | (Composition::Intersection, Selector::Intersection { selections }) => {
                    selections.clone()
                }
                (Composition::Intersection, Selector::Everything) => vec![],
                _ => vec![s],
            })
            .collect(),
    );
    if rows.len() == 1 {
        return rows.into_iter().next().unwrap();
    }
    if rows.is_empty() && mode == Composition::Intersection {
        return Selection::of(Selector::Everything);
    }
    Selection::of(match mode {
        Composition::Union => Selector::Union { selections: rows },
        _ => Selector::Intersection { selections: rows },
    })
}

pub fn at<'a>(rows: &'a [ListedSelection], path: &[usize]) -> Option<&'a Selection> {
    let mut node = &rows.get(*path.first()?)?.selection;
    for index in &path[1..] {
        node = *node.selector.children().get(*index)?;
    }
    Some(node)
}

pub(super) fn rebuilt(node: &Selection, children: Vec<Selection>) -> Vec<Selection> {
    if matches!(
        node.selector,
        Selector::Intersection { .. } | Selector::Union { .. }
    ) && children.len() <= 1
    {
        return children;
    }
    if matches!(node.selector, Selector::Invert { .. }) && children.is_empty() {
        return vec![];
    }
    vec![node.rebuilt(node.selector.clone().with_children(children))]
}

type PathEdit = (Vec<usize>, Vec<Selection>);

fn splice<T: Clone>(
    list: &[T],
    edits: &[PathEdit],
    of: fn(&T) -> &Selection,
    hold: &dyn Fn(Selection, &T) -> T,
) -> Vec<T> {
    let mut indices: Vec<usize> = edits
        .iter()
        .filter_map(|(path, _)| path.first().copied())
        .collect();
    indices.sort_unstable();
    indices.dedup();
    indices.reverse();
    let mut out = list.to_vec();
    for (n, &index) in indices.iter().enumerate() {
        let Some(item) = list.get(index) else {
            continue;
        };
        let node = of(item);
        let here: Vec<_> = edits
            .iter()
            .filter(|(p, _)| p.first() == Some(&index))
            .collect();
        let replacement = if let Some((_, rows)) = here.iter().find(|(p, _)| p.len() == 1) {
            rows.clone()
        } else {
            let children: Vec<_> = node.selector.children().into_iter().cloned().collect();
            let nested: Vec<_> = here
                .iter()
                .map(|(p, rows)| (p[1..].to_vec(), rows.clone()))
                .collect();
            let next = splice(&children, &nested, |s| s, &|s, _| s);
            if next == children {
                vec![node.clone()]
            } else {
                rebuilt(node, next)
            }
        };
        let kept: HashSet<String> = out
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != index && !indices[n + 1..].contains(i))
            .map(|(_, r)| of(r).key.clone())
            .collect();
        let placed = dedupe(
            replacement
                .into_iter()
                .filter(|s| !kept.contains(&s.key))
                .collect(),
        );
        out.splice(index..index + 1, placed.into_iter().map(|s| hold(s, item)));
    }
    out
}

fn splice_rows(rows: &[ListedSelection], edits: &[PathEdit]) -> Vec<ListedSelection> {
    let ghosts: HashMap<_, _> = rows
        .iter()
        .map(|r| (r.selection.key.clone(), r.ghosted))
        .collect();
    splice(rows, edits, |r| &r.selection, &|selection, old| {
        ListedSelection {
            ghosted: ghosts.get(&selection.key).copied().unwrap_or(old.ghosted),
            selection,
        }
    })
}

fn lifted(node: &Selection) -> Vec<Selection> {
    let inner = match &node.selector {
        Selector::Invert { selections } => selections.first().unwrap_or(node),
        _ => node,
    };
    match &inner.selector {
        Selector::Intersection { selections } | Selector::Union { selections } => {
            selections.clone()
        }
        _ => vec![],
    }
}

impl SelectionOp {
    pub fn apply(&self, rows: &[ListedSelection]) -> Vec<ListedSelection> {
        match self {
            Self::Set { selections } => dedupe(
                selections
                    .iter()
                    .cloned()
                    .map(SelectionInput::compile)
                    .collect(),
            )
            .into_iter()
            .map(|selection| ListedSelection {
                selection,
                ghosted: false,
            })
            .collect(),
            Self::Add { selections } | Self::Toggle { selections } => {
                let mut out = rows.to_vec();
                for seed in selections {
                    let selection = seed.clone().compile();
                    match out.iter().position(|r| r.selection.key == selection.key) {
                        Some(i) if matches!(self, Self::Toggle { .. }) => {
                            out = splice_rows(&out, &[(vec![i], lifted(&out[i].selection))])
                        }
                        Some(i) => out[i].selection = selection,
                        None => out.push(ListedSelection {
                            selection,
                            ghosted: false,
                        }),
                    }
                }
                out
            }
            Self::Remove { keys } => {
                let mut out = rows.to_vec();
                for key in keys {
                    if let Some(i) = out.iter().position(|r| &r.selection.key == key) {
                        out = splice_rows(&out, &[(vec![i], lifted(&out[i].selection))]);
                    }
                }
                out
            }
            Self::Manual { id } => {
                let mut ids = rows
                    .iter()
                    .find_map(|r| match &r.selection.selector {
                        Selector::Manual { locations } => Some(locations.clone()),
                        _ => None,
                    })
                    .unwrap_or_default();
                if let Some(i) = ids.iter().position(|i| i == id) {
                    ids.remove(i);
                } else {
                    ids.push(*id);
                }
                if ids.is_empty() {
                    Self::Remove {
                        keys: vec!["manual".into()],
                    }
                    .apply(rows)
                } else {
                    Self::Add {
                        selections: vec![SelectionInput {
                            selector: Selector::Manual { locations: ids },
                            color: None,
                        }],
                    }
                    .apply(rows)
                }
            }
            Self::Active { op } => {
                let active: Vec<_> = rows.iter().filter(|r| !r.ghosted).cloned().collect();
                let next = op.apply(&active);
                let ghosts: HashMap<_, _> = rows
                    .iter()
                    .enumerate()
                    .filter(|(_, r)| r.ghosted)
                    .map(|(i, r)| (r.selection.key.clone(), i))
                    .collect();
                let mut landed = HashMap::new();
                let mut fresh = Vec::new();
                for r in next {
                    if let Some(i) = ghosts.get(&r.selection.key) {
                        landed.insert(*i, r.selection);
                    } else {
                        fresh.push(r);
                    }
                }
                let mut fresh = fresh.into_iter();
                let mut out = Vec::new();
                for (i, r) in rows.iter().enumerate() {
                    if r.ghosted {
                        out.push(ListedSelection {
                            selection: landed.remove(&i).unwrap_or_else(|| r.selection.clone()),
                            ghosted: true,
                        });
                    } else if let Some(r) = fresh.next() {
                        out.push(r);
                    }
                }
                out.extend(fresh);
                out
            }
            Self::Combine { mode, keys } => {
                let targets: Vec<_> = rows
                    .iter()
                    .enumerate()
                    .filter(|(_, r)| {
                        keys.as_ref()
                            .is_none_or(|keys| keys.contains(&r.selection.key))
                    })
                    .collect();
                if targets.is_empty() {
                    return rows.to_vec();
                }
                let selection = combine(
                    *mode,
                    targets.iter().map(|(_, r)| r.selection.clone()).collect(),
                );
                let first = targets[0].0;
                let mut out: Vec<_> = rows
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| !targets.iter().any(|(j, _)| i == j))
                    .map(|(_, r)| r.clone())
                    .collect();
                out.insert(
                    first,
                    ListedSelection {
                        selection,
                        ghosted: rows[first].ghosted,
                    },
                );
                out
            }
            Self::Ghost { index } => rows
                .iter()
                .enumerate()
                .map(|(i, r)| ListedSelection {
                    selection: r.selection.clone(),
                    ghosted: r.ghosted ^ (i == *index),
                })
                .collect(),
            Self::Isolate { .. } | Self::GhostAll => {
                let ghost = |i| match self {
                    Self::Isolate { index } => i != *index,
                    _ => true,
                };
                let clear = rows.iter().enumerate().all(|(i, r)| r.ghosted == ghost(i));
                rows.iter()
                    .enumerate()
                    .map(|(i, r)| ListedSelection {
                        selection: r.selection.clone(),
                        ghosted: !clear && ghost(i),
                    })
                    .collect()
            }
            Self::Invert { path } => at(rows, path).map_or_else(
                || rows.to_vec(),
                |s| splice_rows(rows, &[(path.clone(), vec![invert(s.clone())])]),
            ),
            Self::RemoveAt { path } => at(rows, path).map_or_else(
                || rows.to_vec(),
                |s| splice_rows(rows, &[(path.clone(), lifted(s))]),
            ),
            Self::Replace { path, selection } => {
                splice_rows(rows, &[(path.clone(), vec![selection.clone().compile()])])
            }
            Self::Color { path, color } => at(rows, path).map_or_else(
                || rows.to_vec(),
                |s| {
                    let mut s = s.clone();
                    s.color = *color;
                    splice_rows(rows, &[(path.clone(), vec![s])])
                },
            ),
            Self::PolygonName { path, name } => at(rows, path).map_or_else(
                || rows.to_vec(),
                |s| {
                    let mut s = s.clone();
                    if let Selector::Polygon { polygon } = &mut s.selector {
                        let properties = polygon
                            .properties
                            .get_or_insert_with(|| serde_json::json!({}));
                        if let Some(properties) = properties.as_object_mut() {
                            properties.insert("name".into(), name.clone().into());
                        }
                    }
                    splice_rows(rows, &[(path.clone(), vec![s])])
                },
            ),
            Self::Compose { drag, drop, mode } => {
                if drag.starts_with(drop) || drop.starts_with(drag) {
                    return rows.to_vec();
                }
                let (Some(source), Some(target)) = (at(rows, drag), at(rows, drop)) else {
                    return rows.to_vec();
                };
                let mut children = match (&target.selector, mode) {
                    (Selector::Union { selections }, Composition::Union)
                    | (Selector::Intersection { selections }, Composition::Intersection) => {
                        selections.clone()
                    }
                    _ => vec![target.clone()],
                };
                children.push(source.clone());
                let selector = match mode {
                    Composition::Union => Selector::Union {
                        selections: dedupe(children),
                    },
                    _ => Selector::Intersection {
                        selections: dedupe(children),
                    },
                };
                splice_rows(
                    rows,
                    &[
                        (drag.clone(), vec![]),
                        (drop.clone(), vec![Selection::of(selector)]),
                    ],
                )
            }
            Self::Move { from, to, after } => {
                if to.starts_with(from) {
                    return rows.to_vec();
                }
                let (Some(source), Some(target)) = (at(rows, from), at(rows, to)) else {
                    return rows.to_vec();
                };
                if to.len() > 1
                    && !at(rows, &to[..to.len() - 1]).is_some_and(|s| {
                        matches!(
                            s.selector,
                            Selector::Union { .. } | Selector::Intersection { .. }
                        )
                    })
                {
                    return rows.to_vec();
                }
                let mut rest = if from.starts_with(to) {
                    let within = [vec![0], from[to.len()..].to_vec()].concat();
                    splice(&[target.clone()], &[(within, vec![])], |s| s, &|s, _| s)
                } else {
                    vec![target.clone()]
                };
                rest.insert(if *after { rest.len() } else { 0 }, source.clone());
                let edits = if from.starts_with(to) {
                    vec![(to.clone(), rest)]
                } else {
                    vec![(from.clone(), vec![]), (to.clone(), rest)]
                };
                splice_rows(rows, &edits)
            }
        }
    }
}

pub fn rewrite(selection: &Selection, from: &str, to: Option<&str>) -> Option<Selection> {
    selection.filter_map(&|selector| {
        let mut selector = selector.clone();
        match &mut selector {
            Selector::Filter { field, .. } if field == from => *field = to?.to_string(),
            Selector::Ranked { expr, .. } if expr == from => *expr = to?.to_string(),
            _ => {}
        }
        Some(selector)
    })
}

#[cfg(test)]
#[path = "tree.test.rs"]
mod tests;
