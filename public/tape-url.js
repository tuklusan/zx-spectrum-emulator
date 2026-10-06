export function normalizeRemoteFileUrl(value, baseUrl = globalThis.location?.href ?? "https://localhost/", label = "File") {
  const input = String(value ?? "").trim();
  if (!input) throw new Error(label + " URL is empty");
  const url = new URL(input, baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Unsupported " + label.toLowerCase() + " URL scheme: " + url.protocol);
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "github.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 5 && parts[2] === "blob") {
      return "https://raw.githubusercontent.com/" + parts[0] + "/" + parts[1] + "/" + parts[3] + "/" + parts.slice(4).join("/");
    }
  }
  return url.href;
}

export function normalizeTapeUrl(value, baseUrl = globalThis.location?.href ?? "https://localhost/") {
  return normalizeRemoteFileUrl(value, baseUrl, "Tape");
}

export function spectrumComputingPublisherUrl(value) {
  const target = new URL(String(value ?? "").trim());
  const hostname = target.hostname.toLowerCase();
  if ((hostname === "spectrumcomputing.co.uk" || hostname === "www.spectrumcomputing.co.uk")
      && target.pathname === "/zxdb/sinclair/entries/0030084/DreamWalker(48K).tzx.zip") {
    return "https://www.retrosouls.net/zx/dreamwalker.zip";
  }
  return null;
}

export function spectrumComputingMirrorUrl(value) {
  const target = new URL(String(value ?? "").trim());
  const hostname = target.hostname.toLowerCase();
  if ((hostname === "spectrumcomputing.co.uk" || hostname === "www.spectrumcomputing.co.uk")
      && target.pathname.startsWith("/zxdb/")) {
    return "https://zxinfo.dk/media" + target.pathname + target.search + target.hash;
  }
  return null;
}

export function corsDevUrl(value) {
  const target = new URL(String(value ?? "").trim());
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error("CORS bridge only supports HTTP(S) URLs");
  }
  return "https://proxy.cors.dev/" + target.href;
}

export function allOriginsRawUrl(value) {
  const target = new URL(String(value ?? "").trim());
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error("CORS bridge only supports HTTP(S) URLs");
  }
  const proxy = new URL("https://api.allorigins.win/raw");
  proxy.searchParams.set("url", target.href);
  return proxy.href;
}
