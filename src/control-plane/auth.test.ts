import test from "node:test";
import assert from "node:assert/strict";

import { checkControlToken } from "./auth";

const TOKEN = "s3cr3t-control-token";

test("accepts a matching Bearer token", () => {
  assert.equal(
    checkControlToken(
      `Bearer ${TOKEN}`,
      TOKEN,
    ),
    "OK",
  );
});

test("reports MISSING for an absent or malformed header", () => {
  assert.equal(
    checkControlToken(undefined, TOKEN),
    "MISSING",
  );
  assert.equal(
    checkControlToken("", TOKEN),
    "MISSING",
  );
  assert.equal(
    checkControlToken(TOKEN, TOKEN),
    "MISSING",
  );
  assert.equal(
    checkControlToken(
      `Basic ${TOKEN}`,
      TOKEN,
    ),
    "MISSING",
  );
});

test("reports INVALID for a wrong token of any length", () => {
  assert.equal(
    checkControlToken(
      "Bearer wrong-token",
      TOKEN,
    ),
    "INVALID",
  );
  assert.equal(
    checkControlToken(
      "Bearer short",
      TOKEN,
    ),
    "INVALID",
  );
  assert.equal(
    checkControlToken(
      `Bearer ${TOKEN}-extra-long-suffix`,
      TOKEN,
    ),
    "INVALID",
  );
});
