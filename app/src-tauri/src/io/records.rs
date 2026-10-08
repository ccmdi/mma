use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

pub(crate) fn write<T: Serialize>(records: &T) -> serde_json::Result<Value> {
    let mut value = serde_json::to_value(records)?;
    if let Some(records) = value.as_object_mut() {
        for (key, record) in records {
            if let (Ok(id), Some(record)) = (key.parse::<u32>(), record.as_object_mut()) {
                record.insert("id".into(), id.into());
            }
        }
    }
    Ok(value)
}

pub(crate) fn encode<T: Serialize, S: serde::Serializer>(
    records: &T,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    write(records)
        .map_err(serde::ser::Error::custom)?
        .serialize(serializer)
}

pub(crate) fn decode<'de, T: DeserializeOwned, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<T, D::Error> {
    let mut value = Value::deserialize(deserializer)?;
    if let Some(records) = value.as_object_mut() {
        records.retain(|key, record| {
            if key.parse::<u32>().is_err() {
                return false;
            }
            if let Some(record) = record.as_object_mut() {
                record.remove("id");
                record.remove("visible");
            }
            true
        });
    }
    serde_json::from_value(value).map_err(serde::de::Error::custom)
}

pub(crate) fn read<T: Default + DeserializeOwned>(
    row: &rusqlite::Row<'_>,
    column: &str,
) -> rusqlite::Result<T> {
    let text: String = row.get(column)?;
    Ok(decode(&mut serde_json::Deserializer::from_str(&text)).unwrap_or_default())
}
