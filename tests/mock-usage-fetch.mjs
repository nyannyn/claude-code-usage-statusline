// Preloaded via NODE_OPTIONS="--import <file-url>" by test-dash.sh so the
// dashboard's SUCCESSFUL live path can run fully offline: any request to the
// OAuth usage endpoint gets a canned 200, everything else passes through.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes("api.anthropic.com/api/oauth/usage")) {
    const iso = (ms) => new Date(Date.now() + ms).toISOString();
    return new Response(
      JSON.stringify({
        five_hour: { utilization: 93, resets_at: iso(3.6e6) },
        seven_day: { utilization: 21, resets_at: iso(5 * 86400e3) },
        limits: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  return realFetch(url, opts);
};
