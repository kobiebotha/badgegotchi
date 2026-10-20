import { describe, expect, it, vi } from "vitest";
import { messageFor } from "../src/lib/errors";

describe("messageFor", () => {
  it("preserves native error messages", () => {
    expect(messageFor(new Error("Sync upload failed (503)."))).toBe(
      "Sync upload failed (503).",
    );
  });

  it("shows the message from a PowerSync error relayed through a worker", () => {
    const error = structuredClone({
      __powersyncError: true,
      name: "BackendRequestError",
      message: "Sync upload failed (400). Changes remain queued for retry.",
      status: 400,
      state: "serialized",
      stack: "Internal stack details",
      cause: { request: { Authorization: "Bearer private-token" } },
    });

    expect(error).not.toBeInstanceOf(Error);
    expect(messageFor(error)).toBe(
      "Sync upload failed (400). Changes remain queued for retry.",
    );
  });

  it("accepts plain error messages and string rejections", () => {
    expect(messageFor({ message: "Network unavailable" })).toBe(
      "Network unavailable",
    );
    expect(messageFor("Network unavailable")).toBe("Network unavailable");
  });

  it.each([null, undefined, 503, true, "", "  ", {}, { message: 503 }, new Error("")])(
    "uses the fallback for a rejection without a meaningful message: %j",
    (error) => {
      expect(messageFor(error)).toBe(
        "Something went wrong. Please try again.",
      );
    },
  );

  it("never stringifies arbitrary rejection data", () => {
    const toString = vi.fn(() => "private-token");
    const toJSON = vi.fn(() => ({ token: "private-token" }));

    expect(messageFor({ request: { token: "private-token" }, toString, toJSON }))
      .toBe("Something went wrong. Please try again.");
    expect(toString).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });
});
