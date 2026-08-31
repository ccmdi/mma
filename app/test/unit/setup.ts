// React's act() only runs its queue when this is set, and every React spec needs it.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
