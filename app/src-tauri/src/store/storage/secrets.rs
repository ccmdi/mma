//! Named secrets in the OS credential store, cached in memory per session.

use crate::types::AppResult;
use std::sync::Mutex;

/// A named secret cached in memory: read from the credential store on first use, then held
/// for the process lifetime. Outer `None` = not yet read; inner `None` = no session.
pub(crate) struct SessionCell {
    name: &'static str,
    cached: Mutex<Option<Option<String>>>,
}

impl SessionCell {
    pub(crate) const fn new(name: &'static str) -> Self {
        Self {
            name,
            cached: Mutex::new(None),
        }
    }

    /// A load failure is propagated and NOT cached, so the next call retries rather than
    /// reporting "signed out" until restart.
    pub(crate) fn get(&self) -> AppResult<Option<String>> {
        let mut g = self.cached.lock()?;
        if g.is_none() {
            *g = Some(secret::get(self.name)?);
        }
        Ok(g.clone().unwrap_or_default())
    }

    pub(crate) fn set(&self, value: Option<String>) -> AppResult<()> {
        match value.as_deref() {
            Some(v) => secret::set(self.name, v)?,
            None => secret::delete(self.name)?,
        }
        *self.cached.lock()? = Some(value);
        Ok(())
    }
}

#[cfg(not(any(test, feature = "e2e")))]
pub(crate) mod secret {
    use crate::types::AppResult;

    /// One credential per `name`, all under the app identifier.
    const SERVICE: &str = "app.map-making.local";

    fn entry(name: &str) -> AppResult<keyring::Entry> {
        Ok(keyring::Entry::new(SERVICE, name)?)
    }

    pub fn get(name: &str) -> AppResult<Option<String>> {
        match entry(name)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn set(name: &str, value: &str) -> AppResult<()> {
        Ok(entry(name)?.set_password(value)?)
    }

    pub fn delete(name: &str) -> AppResult<()> {
        match entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

/// Test and e2e builds swap in an in-memory map, so neither the unit suite nor a headless
/// e2e container touches the real keychain (a container has no credential store at all).
#[cfg(any(test, feature = "e2e"))]
pub(crate) mod secret {
    use crate::types::AppResult;
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    fn store() -> &'static Mutex<HashMap<String, String>> {
        static STORE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
        STORE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub fn get(name: &str) -> AppResult<Option<String>> {
        Ok(store().lock()?.get(name).cloned())
    }

    pub fn set(name: &str, value: &str) -> AppResult<()> {
        store().lock()?.insert(name.to_string(), value.to_string());
        Ok(())
    }

    pub fn delete(name: &str) -> AppResult<()> {
        store().lock()?.remove(name);
        Ok(())
    }
}
