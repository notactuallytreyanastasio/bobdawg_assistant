// Every number the sandbox lives by, in one place. The frame's own script keeps copies of
// HEARTBEAT_MS, SETTLE_MS and the kept counts, because it is a raw file with no imports; its
// test holds those copies to these.

export const HEARTBEAT_MS = 250;
// A frame that spends its time between heartbeats fools this, which is why the panel has
// a Stop button of its own.
export const SILENCE_KILL_MS = 1500;
// Long enough for a million characters of data to parse before the first heartbeat.
export const FIRST_CONTACT_MS = 5000;
export const SETTLE_MS = 1200;
export const CHECK_TIMEOUT_MS = 5000;
export const MESSAGES_PER_SECOND = 200;

export const ERROR_CHARS = 500;
export const ERRORS_KEPT = 20;
export const LOG_CHARS = 200;
export const LOGS_KEPT = 20;
export const REPORT_TEXT_CHARS = 300;
export const HEIGHT_MIN = 120;
export const HEIGHT_MAX = 4000;

// The least a chart is told it has. The model writes pixel margins for a chart about 600 wide
// whatever it is told, and at the width of a phone those margins cross and the scale turns
// upside down. Drawn at this size, the viewBox shrinks the whole chart to fit instead.
export const MIN_DRAW_WIDTH = 640;
export const MIN_DRAW_HEIGHT = 416;

// A shared page has no slot to measure, so it is drawn at one size and the viewBox fits it to
// whoever opens it.
export const SHARE_WIDTH = 960;
export const SHARE_HEIGHT = 624;

export const MAX_DATA_CHARS = 1_000_000;
export const TOOL_RESULT_CHARS = 4000;
