const relay = new URL("https://zx-spectrum-emulator.vagabondcouple.workers.dev/media");
relay.searchParams.set(
  "url",
  "https://raw.githubusercontent.com/tuklusan/ZX-Carrom/main/dist/zxcarrom.tzx"
);

let lastError;
for (let attempt = 1; attempt <= 12; attempt += 1) {
  try {
    const response = await fetch(relay, {
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const signature = new TextDecoder("ascii").decode(bytes.subarray(0, 7));
    if (signature !== "ZXTape!") throw new Error("response is not a TZX file");
    console.log(`Production media relay: PASS (${bytes.length} bytes)`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < 12) await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

throw new Error("Production media relay did not become ready: " + (lastError?.message ?? "unknown error"));
