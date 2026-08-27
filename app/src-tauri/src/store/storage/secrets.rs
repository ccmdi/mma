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

#[cfg(not(test))]
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

/// Test builds swap in a thread-local map so the suite never touches the real keychain.
#[cfg(test)]
pub(crate) mod secret {
    use crate::types::AppResult;
    use std::cell::RefCell;
    use std::collections::HashMap;

    thread_local! {
        static STORE: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
    }

    pub fn get(name: &str) -> AppResult<Option<String>> {
        Ok(STORE.with(|s| s.borrow().get(name).cloned()))
    }

    pub fn set(name: &str, value: &str) -> AppResult<()> {
        STORE.with(|s| {
            s.borrow_mut().insert(name.to_string(), value.to_string());
        });
        Ok(())
    }

    pub fn delete(name: &str) -> AppResult<()> {
        STORE.with(|s| {
            s.borrow_mut().remove(name);
        });
        Ok(())
    }
}
