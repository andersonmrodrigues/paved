import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { environmentFailure } from "../../cli/lib/test-runner.ts";

describe("environment failures in test output", () => {
  it("recognizes unreachable services, container engines and missing programs", () => {
    const cases: [number | undefined, string, RegExp][] = [
      [1, "Caused by: java.net.ConnectException: Connection refused\n", /refused the connection/],
      [1, "Error: connect ECONNREFUSED 127.0.0.1:5432", /refused the connection.*5432/],
      [1, "java.lang.IllegalStateException: Could not find a valid Docker environment", /container engine/],
      [1, "getaddrinfo ENOTFOUND db.internal", /did not resolve/],
      [127, "", /program is missing/],
      [1, "sh: mvn: command not found", /program is missing/],
      [1, "Error: spawn psql ENOENT", /program is missing/],
    ];
    for (const [exit, output, expected] of cases) assert.match(environmentFailure(exit, output) ?? "", expected, output);
  });

  it("leaves ordinary test failures to count as regressions", () => {
    for (const output of ["AssertionError: expected true to equal false", "Tests run: 12, Failures: 1, Errors: 0", ""]) {
      assert.equal(environmentFailure(1, output), undefined, output);
    }
  });
});
