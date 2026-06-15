import { describe, expect, it } from "vitest";
import {
  AUTO_RECOVER_BACKOFF_MS,
  autoRecoverBackoffMs,
  isAutoRecoverable,
  MAX_AUTO_RECOVER_ATTEMPTS,
} from "./uploadRecovery";

describe("isAutoRecoverable", () => {
  it("recovers the payload-crash / connection-drop class", () => {
    // The whole point: the multistream-crash bug report's signature.
    expect(isAutoRecoverable(null, "connect to 192.168.1.60:9113 ... refused"))
      .toBe(true);
    expect(isAutoRecoverable(null, "write frame split: Broken pipe")).toBe(true);
    expect(isAutoRecoverable(null, "Connection reset by peer")).toBe(true);
    expect(isAutoRecoverable(null, "timed out")).toBe(true);
    expect(isAutoRecoverable(null, "unexpected end of file")).toBe(true);
    // Payload went to rest mode mid-apply → re-deploy + resume fixes it.
    expect(isAutoRecoverable("spool_apply_failed", "rest mode")).toBe(true);
    // Old payload rejecting packed shards → re-deploy sends the current ELF.
    expect(isAutoRecoverable("packed_unsupported", "")).toBe(true);
  });

  it("does NOT recover fatal payload reasons (retry can't help)", () => {
    expect(isAutoRecoverable("fs_write_failed_errno_28", "")).toBe(false); // ENOSPC
    expect(isAutoRecoverable("fs_write_failed_errno_27", "")).toBe(false); // EFBIG
    expect(isAutoRecoverable("preflight_insufficient_space", "")).toBe(false);
    expect(isAutoRecoverable("direct_writer_io_error", "")).toBe(false);
    expect(isAutoRecoverable("fs_open_path_not_allowed", "")).toBe(false);
    expect(isAutoRecoverable("tx_table_full", "")).toBe(false);
    expect(isAutoRecoverable("direct_tx_corrupt", "")).toBe(false);
  });

  it("does NOT recover fatal LOCAL errors (no payload reason)", () => {
    expect(isAutoRecoverable(null, "No such file or directory (os error 2)"))
      .toBe(false);
    expect(isAutoRecoverable(null, "permission denied")).toBe(false);
    expect(isAutoRecoverable(null, "No space left on device")).toBe(false);
  });

  it("ignores fatal-looking words in a payload detail when a non-fatal reason is present", () => {
    // A transport reason whose detail incidentally mentions a file path
    // containing 'not found' must still recover — we trust the structured
    // reason over the free-text message.
    expect(
      isAutoRecoverable(
        "spool_apply_failed",
        "could not find spool entry; file not found in tmp",
      ),
    ).toBe(true);
  });

  it("defaults unknown reasons to recoverable (bounded by the attempt cap)", () => {
    expect(isAutoRecoverable("some_brand_new_reason", "")).toBe(true);
    expect(isAutoRecoverable(null, "an unclassified transient blip")).toBe(true);
  });

  // Real failure strings captured from a payload crash mid-upload on a Fat PS5
  // (192.168.86.99) — both surface with error_reason=null, so they MUST be
  // classified via the message and MUST be recoverable, or the auto-resume
  // feature is useless for the exact case it exists to handle.
  it("recovers the actual hardware crash signatures (regression)", () => {
    expect(
      isAutoRecoverable(
        null,
        "transfer_file_list gave up after 2 retries. Prior: attempt 0: write frame split | attempt 1: read frame header: connect to 192.168.86.99:9113: Connection refused (os error 61)",
      ),
    ).toBe(true);
    // Crash landed during a stream's commit phase.
    expect(isAutoRecoverable(null, "CommitTx rejected (Error): tx_not_active")).toBe(
      true,
    );
  });
});

describe("autoRecoverBackoffMs", () => {
  it("escalates then clamps to the last step", () => {
    expect(autoRecoverBackoffMs(0)).toBe(AUTO_RECOVER_BACKOFF_MS[0]);
    expect(autoRecoverBackoffMs(1)).toBe(AUTO_RECOVER_BACKOFF_MS[1]);
    expect(autoRecoverBackoffMs(2)).toBe(AUTO_RECOVER_BACKOFF_MS[2]);
    // Past the array → clamp to last (defensive; the loop never exceeds the cap).
    expect(autoRecoverBackoffMs(99)).toBe(
      AUTO_RECOVER_BACKOFF_MS[AUTO_RECOVER_BACKOFF_MS.length - 1],
    );
    expect(autoRecoverBackoffMs(-5)).toBe(AUTO_RECOVER_BACKOFF_MS[0]);
  });

  it("has a backoff entry for every recovery attempt", () => {
    expect(AUTO_RECOVER_BACKOFF_MS.length).toBe(MAX_AUTO_RECOVER_ATTEMPTS);
  });
});
