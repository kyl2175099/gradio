import http from "node:http";
import process from "node:process";
import httpProxy from "http-proxy";
import { handler } from "./handler.js";

const host = process.env.HOST || "0.0.0.0";
const port = parseInt(process.env.PORT || "7860", 10);

const pythonHost = process.env.GRADIO_PYTHON_HOST || "127.0.0.1";
const pythonPort = parseInt(process.env.GRADIO_PYTHON_PORT || "7861", 10);
const serverModeEnabled = process.env.GRADIO_SERVER_MODE_ENABLED;

const staticWorkerPorts = process.env.GRADIO_STATIC_WORKER_PORTS
	? process.env.GRADIO_STATIC_WORKER_PORTS.split(",")
			.map((p) => parseInt(p.trim(), 10))
			.filter((p) => !isNaN(p))
	: [];

let workerIndex = 0;

// Routes that must go to the Python server (FastAPI).
// /gradio_api covers the API router (queue, call, upload, file, info, etc.)
// The rest are routes mounted directly on the FastAPI app.
const PYTHON_ROUTE_PREFIXES = [
	"/gradio_api",
	"/config",
	"/login",
	"/logout",
	"/theme.css",
	"/robots.txt",
	"/pwa_icon",
	"/manifest.json",
	"/monitoring"
];

// Routes that can be offloaded to static workers.
// Workers serve both /upload and /gradio_api/upload (same handler).
// Checked BEFORE the /gradio_api Python catch-all.
const STATIC_ROUTE_PREFIXES = [
	"/gradio_api/upload",
	"/gradio_api/file=",
	"/gradio_api/file/",
	"/upload",
	"/file=",
	"/file/",
	"/static/",
	"/assets/",
	"/svelte/",
	"/favicon.ico",
	"/custom_component/"
];

function matchesPrefix(path, prefixes) {
	for (const prefix of prefixes) {
		if (path === prefix || path.startsWith(prefix)) {
			return true;
		}
	}
	return false;
}

const pythonTarget = `http://${pythonHost}:${pythonPort}`;

const proxy = httpProxy.createProxyServer({
	// Don't modify the path
	ignorePath: false,
	// Forward the original host header
	changeOrigin: false
});

proxy.on("error", (err, req, res) => {
	console.error(`[gradio-proxy] Proxy error for ${req.url}:`, err.message);
	if (res.writeHead && !res.headersSent) {
		res.writeHead(502, { "Content-Type": "text/plain" });
		res.end("Bad Gateway");
	}
});

const server = http.createServer((req, res) => {
	const url = req.url || "/";
	const path = url.split("?")[0];

	// 1. Static routes -> workers (round-robin) or Python fallback.
	//    Checked FIRST so /gradio_api/upload isn't caught by the
	//    /gradio_api Python catch-all below.
	if (matchesPrefix(path, STATIC_ROUTE_PREFIXES)) {
		if (staticWorkerPorts.length > 0) {
			const workerPort =
				staticWorkerPorts[workerIndex % staticWorkerPorts.length];
			workerIndex = (workerIndex + 1) % staticWorkerPorts.length;
			console.log(`[node-proxy] ${path} -> worker :${workerPort}`);
			proxy.web(req, res, {
				target: `http://${pythonHost}:${workerPort}`
			});
		} else {
			proxy.web(req, res, { target: pythonTarget });
		}
		return;
	}

	// 2. Python routes (API, config, auth, etc.)
	if (matchesPrefix(path, PYTHON_ROUTE_PREFIXES) || serverModeEnabled) {
		console.log(`[node-proxy] ${path} -> ${pythonTarget}`);
		proxy.web(req, res, { target: pythonTarget });
		return;
	}

	// 3. Everything else -> SvelteKit handler (SSR + immutable assets)
	// Inject headers that SvelteKit's page.server.ts expects to find the Python backend.
	// x-gradio-server is for internal Node->Python fetches (always http).
	// x-gradio-original-url is the public-facing URL the browser uses,
	// so it must respect x-forwarded-proto (e.g. https on HF Spaces).
	const publicScheme = (req.headers["x-forwarded-proto"] || "http")
		.split(",")[0]
		.trim();
	const publicHost =
		req.headers["x-forwarded-host"] || req.headers.host || `${host}:${port}`;
	req.headers["x-gradio-server"] = pythonTarget;
	req.headers["x-gradio-port"] = String(pythonPort);
	req.headers["x-gradio-mounted-path"] = "/";
	req.headers["x-gradio-original-url"] = `${publicScheme}://${publicHost}`;
	handler(req, res);
});

server.listen({ host, port }, () => {
	console.log(`[gradio-proxy] Listening on http://${host}:${port}`);
	console.log(`[gradio-proxy] Python backend: ${pythonTarget}`);
	if (staticWorkerPorts.length > 0) {
		console.log(
			`[gradio-proxy] Static workers: ${staticWorkerPorts.join(", ")}`
		);
	}
});

function graceful_shutdown() {
	server.closeIdleConnections();
	server.close(() => {
		proxy.close();
		process.exit(0);
	});
	setTimeout(() => server.closeAllConnections(), 30000);
}

process.on("SIGTERM", graceful_shutdown);
process.on("SIGINT", graceful_shutdown);

export { host, port, server };
