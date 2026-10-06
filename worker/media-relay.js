const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
const MEDIA_PATH = /\.(?:tap|tzx|sna|z80|rzx|zip)$/i;

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400"
  };
}

function textResponse(message, status = 200) {
  return new Response(message, {
    status,
    headers: {
      ...corsHeaders(),
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff"
    }
  });
}

function isPrivateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
      || host.endsWith(".internal") || host.endsWith(".home.arpa") || host.includes(":")) {
    return true;
  }

  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const bytes = parts.map(Number);
  if (bytes.some((byte) => byte < 0 || byte > 255)) return true;
  const [a, b] = bytes;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function mediaTarget(requestUrl) {
  const raw = requestUrl.searchParams.get("url");
  if (!raw) throw new Error("Missing media URL");

  const target = new URL(raw);
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error("Only HTTP(S) media URLs are supported");
  }
  if (isPrivateHost(target.hostname)) throw new Error("Local and private network URLs are not allowed");
  if (!MEDIA_PATH.test(target.pathname)) throw new Error("URL does not look like supported Spectrum media");
  return target;
}

export async function handleMediaRelay(request, fetchImpl = fetch) {
  const requestUrl = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (requestUrl.pathname === "/") return textResponse("ZX Spectrum media relay");
  if (requestUrl.pathname !== "/media") return textResponse("Not found", 404);
  if (request.method !== "GET" && request.method !== "HEAD") return textResponse("Method not allowed", 405);

  let target;
  try {
    target = mediaTarget(requestUrl);
  } catch (error) {
    return textResponse(error.message, 400);
  }

  let upstream;
  try {
    upstream = await fetchImpl(target.href, {
      method: request.method,
      redirect: "follow"
    });
  } catch {
    return textResponse("Upstream fetch failed", 502);
  }

  if (!upstream.ok) return textResponse("Upstream returned HTTP " + upstream.status, 502);
  const declaredLength = Number(upstream.headers.get("content-length") || 0);
  if (declaredLength > MAX_MEDIA_BYTES) return textResponse("Media file is too large", 413);

  const headers = new Headers(corsHeaders());
  for (const name of ["content-type", "content-length", "content-disposition", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cache-control", "public, max-age=3600");
  headers.set("x-content-type-options", "nosniff");

  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: 200,
    headers
  });
}

export default {
  fetch(request) {
    return handleMediaRelay(request);
  }
};
