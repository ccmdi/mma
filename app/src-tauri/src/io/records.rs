use serde::{de::DeserializeOwned, Deserialize};
use serde_json::Value;

pub(crate) fn decode<'de, T: DeserializeOwned, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<T, D::Error> {
    let mut value = Value::deserialize(deserializer)?;
    if let Some(records) = value.as_object_mut() {
        records.retain(|key, record| {
            let Ok(id) = key.parse::<u32>() else {
                return false;
            };
            if let Some(record) = record.as_object_mut() {
                record.insert("id".into(), id.into());
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
