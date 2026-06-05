/**
 * Timing used by the session kickoff in SessionManager.spawn.
 *
 * Kept in its own module so tests can import the values without pulling in
 * the Electron `app` dependency that the SessionManager constructor requires.
 */

/** Time the spawn() kickoff waits for the harness's TUI to spin up before typing the prompt. */
export const HARNESS_STARTUP_DELAY_MS = 2000
/** Time the kickoff waits between typing the prompt and pressing submit. */
export const HARNESS_SUBMIT_DELAY_MS = 1000
