import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publicConfirmUrl, publicOrigin, publicVerifyUrl } from "../src/public-url.js";

function withoutPublicUrl(fn: () => void) {
  const previous = process.env.LIVECHECK_PUBLIC_URL;
  const previousFly = process.env.FLY_APP_NAME;
  delete process.env.LIVECHECK_PUBLIC_URL;
  delete process.env.FLY_APP_NAME;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
    else process.env.LIVECHECK_PUBLIC_URL = previous;
    if (previousFly === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = previousFly;
  }
}

describe("public verify URL", () => {
  it("defaults to local http when unset", () => {
    withoutPublicUrl(() => {
      assert.equal(publicOrigin("http://127.0.0.1:43127/v1/verify"), "http://127.0.0.1:43127");
      assert.equal(publicVerifyUrl("http://127.0.0.1:43127/"), "http://127.0.0.1:43127/v1/verify");
      assert.equal(publicConfirmUrl("http://127.0.0.1:43127/"), "http://127.0.0.1:43127/v1/confirm");
    });
  });

  it("uses LIVECHECK_PUBLIC_URL and always produces https verify on Fly", () => {
    const previous = process.env.LIVECHECK_PUBLIC_URL;
    process.env.LIVECHECK_PUBLIC_URL = "https://livecheck.fly.dev";
    try {
      assert.equal(publicVerifyUrl("http://livecheck.fly.dev/v1/verify"), "https://livecheck.fly.dev/v1/verify");
    } finally {
      if (previous === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
      else process.env.LIVECHECK_PUBLIC_URL = previous;
    }
  });

  it("upgrades livecheck.fly.dev request origins to https when env is unset", () => {
    const previous = process.env.LIVECHECK_PUBLIC_URL;
    const previousFly = process.env.FLY_APP_NAME;
    delete process.env.LIVECHECK_PUBLIC_URL;
    delete process.env.FLY_APP_NAME;
    try {
      assert.equal(
        publicVerifyUrl("http://livecheck.fly.dev/v1/verify"),
        "https://livecheck.fly.dev/v1/verify",
      );
    } finally {
      if (previous === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
      else process.env.LIVECHECK_PUBLIC_URL = previous;
      if (previousFly === undefined) delete process.env.FLY_APP_NAME;
      else process.env.FLY_APP_NAME = previousFly;
    }
  });

  it("upgrades an http LIVECHECK_PUBLIC_URL on fly.dev to https", () => {
    const previous = process.env.LIVECHECK_PUBLIC_URL;
    process.env.LIVECHECK_PUBLIC_URL = "http://livecheck.fly.dev";
    try {
      assert.equal(publicVerifyUrl(), "https://livecheck.fly.dev/v1/verify");
    } finally {
      if (previous === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
      else process.env.LIVECHECK_PUBLIC_URL = previous;
    }
  });

  it("uses the Host header for *.fly.dev when env is unset", () => {
    withoutPublicUrl(() => {
      assert.equal(
        publicVerifyUrl("http://127.0.0.1:43127/v1/verify", "livecheck.fly.dev"),
        "https://livecheck.fly.dev/v1/verify",
      );
    });
  });

  it("uses FLY_APP_NAME when LIVECHECK_PUBLIC_URL is unset", () => {
    const previous = process.env.LIVECHECK_PUBLIC_URL;
    const previousFly = process.env.FLY_APP_NAME;
    delete process.env.LIVECHECK_PUBLIC_URL;
    process.env.FLY_APP_NAME = "livecheck";
    try {
      assert.equal(publicVerifyUrl(), "https://livecheck.fly.dev/v1/verify");
    } finally {
      if (previous === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
      else process.env.LIVECHECK_PUBLIC_URL = previous;
      if (previousFly === undefined) delete process.env.FLY_APP_NAME;
      else process.env.FLY_APP_NAME = previousFly;
    }
  });
});
