import { describe, expect, it } from 'vitest';
import * as limits from '../../src/artifact/limits';

describe('limits', () => {
  it('holds the numbers the design was tested at', () => {
    expect(limits).toMatchObject({
      HEARTBEAT_MS: 250,
      SILENCE_KILL_MS: 1500,
      FIRST_CONTACT_MS: 5000,
      SETTLE_MS: 1200,
      CHECK_TIMEOUT_MS: 5000,
      MESSAGES_PER_SECOND: 200,
      ERROR_CHARS: 500,
      ERRORS_KEPT: 20,
      LOG_CHARS: 200,
      LOGS_KEPT: 20,
      REPORT_TEXT_CHARS: 300,
      HEIGHT_MIN: 120,
      HEIGHT_MAX: 4000,
      MAX_DATA_CHARS: 1_000_000,
      TOOL_RESULT_CHARS: 4000,
    });
  });

  it('lets the check finish inside its own timeout', () => {
    expect(limits.SETTLE_MS).toBeLessThan(limits.CHECK_TIMEOUT_MS);
    expect(limits.HEARTBEAT_MS * 2).toBeLessThan(limits.SILENCE_KILL_MS);
  });
});
