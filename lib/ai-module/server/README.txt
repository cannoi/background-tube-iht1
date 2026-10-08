# Universal AI Server Module

`ai-service.js` is the only AI gateway to mount.
`provider-engine.js` contains provider-specific calls, model discovery, health testing and stale-model recovery.
`routes.js` mounts the API into the host app's existing server.

Do NOT mount a second AI gateway or copy an older provider implementation into the host app.
Do NOT pass API keys or action definitions from browser to the AI gateway.
