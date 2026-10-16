/**
 * The limits both ends hold to: the server's schemas refuse a call past
 * them, and the page checks again for a caller that skips the server.
 */

/** The most instances one set_instances call lays out. */
export const MAX_INSTANCES = 100

/** The most boxes one set_boxes call outlines. */
export const MAX_BOXES = 1000

/**
 * The longest transition an animate call may ask for, in milliseconds:
 * with the page's grace for a stalled transition it stays inside the
 * bridge's 15 second wait for an answer.
 */
export const MAX_ANIMATION_MS = 10000
