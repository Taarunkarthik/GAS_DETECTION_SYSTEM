// Set this to the public backend origin when the Vercel site uses a separate backend.
// Example: window.EMBERWATCH_API_BASE = "https://your-backend.example.com";
window.EMBERWATCH_API_BASE = "https://adopt-nascar-springer-examining.trycloudflare.com";
// Quick tunnel URLs do not carry SSE streams; polling keeps the demo dashboard current.
window.EMBERWATCH_POLLING = true;
window.EMBERWATCH_POLL_INTERVAL_MS = 2500;
