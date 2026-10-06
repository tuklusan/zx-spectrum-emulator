import assert from "node:assert/strict";
import test from "node:test";
import { handleMediaRelay } from "../worker/media-relay.js";

test("media relay exposes a tiny health response", async () => {
  const response = await handleMediaRelay(new Request("https://relay.example/"));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ZX Spectrum media relay");
});

test("media relay rejects unsafe or unrelated targets", async () => {
  const local = await handleMediaRelay(new Request(
    "https://relay.example/media?url=" + encodeURIComponent("http://127.0.0.1/game.tzx")
  ));
  assert.equal(local.status, 400);

  const html = await handleMediaRelay(new Request(
    "https://relay.example/media?url=" + encodeURIComponent("https://example.com/index.html")
  ));
  assert.equal(html.status, 400);
});

test("media relay streams supported public media with browser CORS", async () => {
  let fetched = null;
  const response = await handleMediaRelay(
    new Request("https://relay.example/media?url=" + encodeURIComponent("https://example.com/game.tzx")),
    async (url, options) => {
      fetched = { url, options };
      return new Response(new Uint8Array([90, 88, 84, 97, 112, 101]), {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "6"
        }
      });
    }
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("content-length"), "6");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([90, 88, 84, 97, 112, 101]));
  assert.equal(fetched.url, "https://example.com/game.tzx");
  assert.equal(fetched.options.method, "GET");
});
