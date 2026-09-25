import test from "node:test";
import assert from "node:assert/strict";

import {
  isExpectedGitHubRemote,
} from "./GitHubClient";

test(
  "validates GitHub origin before credentialed push",
  () => {
    assert.equal(
      isExpectedGitHubRemote(
        "https://github.com/gunminiho/oquestador.git",
        "gunminiho",
        "oquestador",
      ),
      true,
    );

    assert.equal(
      isExpectedGitHubRemote(
        "git@github.com:gunminiho/oquestador.git",
        "gunminiho",
        "oquestador",
      ),
      true,
    );

    assert.equal(
      isExpectedGitHubRemote(
        "https://evil.example/gunminiho/oquestador.git",
        "gunminiho",
        "oquestador",
      ),
      false,
    );
  },
);
