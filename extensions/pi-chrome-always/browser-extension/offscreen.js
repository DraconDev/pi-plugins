// Offscreen keepalive for Pi Chrome Connector — Always.
// MV3 service workers suspend after ~30s idle; the long-poll /next loop usually
// keeps them alive, but an offscreen document provides a second wakeup path
// and survives service-worker restarts. This document polls bridge /status
// every 30s and messages the service worker to re-arm the poll loop.
// Reasons used: none of the OFFSCREEN_REASONS require user gesture here;
// we use BLOBS purely as a keepalive anchor (no Blob payloads exchanged).

const BRIDGE_URL = "http://127.0.0.1:17318";

async function ping() {
  try {
    await fetch(`${BRIDGE_URL}/status`, { cache: "no-store" });
    chrome.runtime.sendMessage({ type: "pi-always-keepalive" }).catch(() => {});
  } catch {
    // Bridge down (Pi not running, daemon not started). Service worker will
    // retry via alarms; nothing to do here.
  }
}

setInterval(ping, 30_000);
ping();
