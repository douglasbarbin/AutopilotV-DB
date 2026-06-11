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
/**
 * A live session that has produced NO output this long after starting never
 * booted (crashed binary, login wall on a black screen, hung launcher). The
 * watchdog kills it so the owning lane can surface an error instead of the
 * session sitting "running" forever.
 */
export const HARNESS_BOOT_TIMEOUT_SECONDS = 180
