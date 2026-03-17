const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const ROOT_DIR = __dirname;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webp": "image/webp"
};

function getSafePath(urlPath) {
  const normalizedPath = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[\\/])+/, "");
  return path.join(ROOT_DIR, normalizedPath);
}

function sendResponse(res, statusCode, headers, body) {
  res.writeHead(statusCode, headers);
  res.end(body);
}

function serveFile(filePath, res) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      if (error.code === "ENOENT") {
        sendResponse(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
        return;
      }

      console.error(error);
      sendResponse(res, 500, { "Content-Type": "text/plain; charset=utf-8" }, "Internal server error");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] || "application/octet-stream";
    sendResponse(res, 200, { "Content-Type": contentType }, data);
  });
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    sendResponse(res, 400, { "Content-Type": "text/plain; charset=utf-8" }, "Bad request");
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (requestUrl.pathname === "/healthz") {
    sendResponse(res, 200, { "Content-Type": "application/json; charset=utf-8" }, JSON.stringify({ ok: true }));
    return;
  }

  const relativePath = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
  const filePath = getSafePath(relativePath);

  if (!filePath.startsWith(ROOT_DIR)) {
    sendResponse(res, 403, { "Content-Type": "text/plain; charset=utf-8" }, "Forbidden");
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (!error && stats.isDirectory()) {
      serveFile(path.join(filePath, "index.html"), res);
      return;
    }

    serveFile(filePath, res);
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
