/** Shared tick counter so reasoning emitted outside Brain (e.g. auto-drive) can
 * be grouped under the current tick. */
export const tickState = { current: 0 }
