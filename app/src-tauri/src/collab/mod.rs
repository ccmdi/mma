//! Live collaboration: a host serves its map to peers who edit it at the same time.

mod copy;
mod host;
mod peer;
mod protocol;
mod room;
mod rtc;
pub(crate) mod sessions;
mod worker;

/// Every message the collab Worker and this app exchange, for the Worker's code to satisfy.
#[cfg(debug_assertions)]
pub(crate) fn wire() -> specta::Types {
    specta::Types::default()
        .register::<worker::Pass>()
        .register::<worker::Invite>()
        .register::<worker::Shares>()
        .register::<room::Heard>()
        .register::<room::Said>()
}

#[cfg(test)]
#[path = "support.test.rs"]
mod support;

#[cfg(test)]
#[path = "session.test.rs"]
mod session_tests;

#[cfg(test)]
#[path = "sim.test.rs"]
mod sim_tests;
