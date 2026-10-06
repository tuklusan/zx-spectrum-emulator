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

export function spectrumComputingPublisherEntry(value) {
  const target = new URL(String(value ?? "").trim());
  const hostname = target.hostname.toLowerCase();
  if ((hostname === "spectrumcomputing.co.uk" || hostname === "www.spectrumcomputing.co.uk")
      && target.pathname === "/zxdb/sinclair/entries/0030084/DreamWalker(48K).tzx.zip") {
    return "dreamwalker/v1.0/Spectrum-48/DreamWalker48.tzx";
  }
  return null;
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

export function worldOfSpectrumCompatibilityUrl(value) {
  const target = new URL(String(value ?? "").trim());
  const hostname = target.hostname.toLowerCase();
  if ((hostname === "worldofspectrum.org" || hostname === "www.worldofspectrum.org")
      && target.pathname.replace(/\/{2,}/g, "/") === "/pub/sinclair/games/h/H.A.T.E..tzx.zip") {
    target.pathname = "/pub/sinclair/games/h/H.A.T.E.(ErbeSoftwareS.A.).tap.zip";
    return target.href;
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

export function mediaRelayUrl(value) {
  const target = new URL(String(value ?? "").trim());
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error("Media relay only supports HTTP(S) URLs");
  }
  const relay = new URL("https://zx-spectrum-emulator.vagabondcouple.workers.dev/media");
  relay.searchParams.set("url", target.href);
  return relay.href;
}
