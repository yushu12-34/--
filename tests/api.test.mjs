import assert from "node:assert/strict";
import test from "node:test";
import { publicProvider } from "../apps/api/src/utils/http.js";

test("publicProvider hides local secret values and exposes only hasSecret", () => {
  const provider = publicProvider({
    id: "p1",
    name: "provider",
    secretValue: "secret",
    secretStorage: "plain-local-json",
  });
  assert.equal(provider.secretValue, undefined);
  assert.equal(provider.hasSecret, true);
  assert.equal(provider.secretStorage, "plain-local-json");
});
