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
  if ((hostname === "spectrumcomputing.co.uk" || hostname === "www.spectrumcomputing.co.uk")
      && url.pathname.startsWith("/zxdb/")) {
    return "https://zxinfo.dk/media" + url.pathname + url.search + url.hash;
  }
  return url.href;
}

export function normalizeTapeUrl(value, baseUrl = globalThis.location?.href ?? "https://localhost/") {
  return normalizeRemoteFileUrl(value, baseUrl, "Tape");
}
