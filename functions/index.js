const { onRequest } = require("firebase-functions/v2/https");

let handlerModulePromise = null;

exports.api = onRequest(
  {
    region: "asia-northeast3",
    cors: true
  },
  async (req, res) => {
    try {
      handlerModulePromise ||= import("./server.mjs");
      const mod = await handlerModulePromise;
      return await mod.handleRequest(req, res);
    } catch (e) {
      // best-effort JSON error
      try {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: false, error: "functions_handler_failed", details: String(e?.message || e) }));
      } catch {
        // ignore
      }
    }
  }
);


