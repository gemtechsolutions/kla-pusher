/**
 * Cloudflare Worker for Instantcast VG2 HLS Stream Proxy
 *
 * Deploy this to Cloudflare Workers to proxy the vg2 instantcast stream.
 *
 * Setup:
 * 1. Go to https://dash.cloudflare.com
 * 2. Workers & Pages > Create Worker
 * 3. Name it something like "stream-instantcast-vg2"
 * 4. Paste this code
 * 5. Deploy
 * 6. Get your worker URL and add to .env.local
 *
 * Deployed at: https://ancient-bonus-b251.mauricetjmurphy.workers.dev/
 */

const UPSTREAM_HOST = "vg2.instantcast.live:5443";
const UPSTREAM_BASE = "https://vg2.instantcast.live:5443/wcc";

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // Only allow GET requests
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Determine the upstream path
  const path = url.pathname;
  let upstreamUrl;

  if (path.endsWith(".m3u8") || path.endsWith(".ts")) {
    // Extract just the filename
    const filename = path.split("/").pop();
    upstreamUrl = `${UPSTREAM_BASE}/${filename}`;
  } else {
    return new Response("Not found", { status: 404 });
  }

  // Fetch from upstream with required headers matching the browser
  const upstreamHeaders = {
    "Referer": "https://instantcast.live/",
    "Origin": "https://instantcast.live",
    "User-Agent":
      request.headers.get("User-Agent") ||
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:148.0) Gecko/20100101 Firefox/148.0",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  };

  try {
    const response = await fetch(upstreamUrl, {
      headers: upstreamHeaders,
      cf: {
        // Cloudflare-specific options
        cacheTtl: path.endsWith(".m3u8") ? 1 : 10, // Cache playlists 1s, segments 10s
        cacheEverything: true,
      },
    });

    // Clone the response to modify headers
    const modifiedResponse = new Response(response.body, response);

    // Add CORS headers
    modifiedResponse.headers.set("Access-Control-Allow-Origin", "*");
    modifiedResponse.headers.set(
      "Access-Control-Allow-Methods",
      "GET, OPTIONS",
    );
    modifiedResponse.headers.set("Access-Control-Allow-Headers", "*");

    // Cache control
    if (path.endsWith(".ts")) {
      modifiedResponse.headers.set("Cache-Control", "public, max-age=10");
    } else {
      modifiedResponse.headers.set("Cache-Control", "public, max-age=1");
    }

    return modifiedResponse;
  } catch (error) {
    return new Response(`Upstream error: ${error.message}`, {
      status: 502,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}
