import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import Icons from "unplugin-icons/vite";
import Components from "unplugin-vue-components/vite";
import IconsResolver from "unplugin-icons/resolver";
import legacy from "@vitejs/plugin-legacy";
import VueI18nPlugin from "@intlify/unplugin-vue-i18n/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";
import eslintPlugin from "vite-plugin-eslint";

// https://vitejs.dev/config/
function castServerPlugin() {
    const clients = new Set();
    let lastCast = null;

    function broadcast(payload) {
        for (const client of [...clients]) {
            try {
                if (!client.writableEnded) {
                    client.write(payload);
                } else {
                    clients.delete(client);
                }
            } catch {
                clients.delete(client);
            }
        }
    }

    function broadcastStatus() {
        const payload = `data: ${JSON.stringify({ type: "connected", clients: clients.size })}\n\n`;
        broadcast(payload);
    }

    const middleware = (req, res, next) => {
        const url = new URL(req.url, "http://localhost");

        // Handle CORS preflight for all /api/cast/* endpoints
        if (req.method === "OPTIONS" && url.pathname.startsWith("/api/cast/")) {
            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
            });
            res.end();
            return;
        }

        if (url.pathname === "/api/cast/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "Access-Control-Allow-Origin": "*",
            });

            clients.add(res);
            broadcastStatus();

            const keepAlive = setInterval(() => {
                try {
                    if (!res.writableEnded) {
                        res.write(": keep-alive\n\n");
                    } else {
                        clearInterval(keepAlive);
                        clients.delete(res);
                        broadcastStatus();
                    }
                } catch {
                    clearInterval(keepAlive);
                    clients.delete(res);
                    broadcastStatus();
                }
            }, 15000);

            req.on("close", () => {
                clearInterval(keepAlive);
                clients.delete(res);
                broadcastStatus();
            });
            return;
        }

        if (url.pathname === "/api/cast/push" && req.method === "POST") {
            let body = "";
            req.on("data", chunk => {
                body += chunk;
            });
            req.on("end", () => {
                try {
                    const data = JSON.parse(body || "{}");
                    lastCast = { ...data, timestamp: Date.now() };

                    const payload = `data: ${JSON.stringify({ type: "play", ...data })}\n\n`;
                    broadcast(payload);

                    res.writeHead(200, {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*",
                    });
                    res.end(JSON.stringify({ success: true, clients: clients.size, data }));
                } catch (err) {
                    res.writeHead(400, {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*",
                    });
                    res.end(JSON.stringify({ error: err.message }));
                }
            });
            return;
        }

        if (url.pathname === "/api/cast/status") {
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
            });
            res.end(JSON.stringify({ clients: clients.size, lastCast }));
            return;
        }

        next();
    };

    return {
        name: "piped-cast-server",
        configureServer(server) {
            server.middlewares.use(middleware);
        },
        configurePreviewServer(server) {
            server.middlewares.use(middleware);
        },
    };
}

export default defineConfig({
    plugins: [
        castServerPlugin(),
        vue(),
        tailwindcss(),
        Icons({ compiler: "vue3", scale: 1 }),
        Components({
            resolvers: [IconsResolver()],
            dts: false,
        }),
        VueI18nPlugin({
            include: path.resolve(__dirname, "./src/locales/**"),
        }),
        legacy({
            targets: ["defaults", "not IE 11"],
        }),
        VitePWA({
            registerType: "autoUpdate",
            devOptions: {
                enabled: true,
                type: "module",
            },
            workbox: {
                globPatterns: [
                    "**/*.{css,html}",
                    "**/[A-Z]*.js",
                    "**/index*.js",
                    "**/shaka-player*.js",
                    "manifest.webmanifest",
                ],
                globIgnores: ["**/*-legacy-*.js"],
                runtimeCaching: [
                    {
                        urlPattern: /https:\/\/[a-zA-Z./0-9_]*\.(?:otf|ttf)/i,
                        handler: "CacheFirst",
                        options: {
                            cacheName: "fonts-cache",
                            expiration: {
                                maxEntries: 10,
                                maxAgeSeconds: 60 * 60 * 24 * 365, // <== 365 days
                            },
                            cacheableResponse: {
                                statuses: [0, 200],
                            },
                        },
                    },
                ],
            },
            manifest: {
                id: "/",
                start_url: "/",
                scope: "/",
                display: "standalone",
                name: "Piped",
                short_name: "Piped",
                background_color: "#000000",
                theme_color: "#fa4b4b",
                share_target: {
                    action: "/share-target",
                    method: "GET",
                    enctype: "application/x-www-form-urlencoded",
                    params: {
                        title: "title",
                        text: "text",
                        url: "url",
                    },
                },
                icons: [
                    {
                        src: "/img/icons/android-chrome-192x192.png",
                        sizes: "192x192",
                        type: "image/png",
                        purpose: "any",
                    },
                    {
                        src: "/img/icons/android-chrome-512x512.png",
                        sizes: "512x512",
                        type: "image/png",
                        purpose: "any",
                    },
                    {
                        src: "/img/icons/android-chrome-maskable-192x192.png",
                        sizes: "192x192",
                        type: "image/png",
                        purpose: "maskable",
                    },
                    {
                        src: "/img/icons/android-chrome-maskable-512x512.png",
                        sizes: "512x512",
                        type: "image/png",
                        purpose: "maskable",
                    },
                ],
            },
        }),
        eslintPlugin({
            exclude: ["**/node_modules/**", "**/dev-sw*", "**/virtual:*"],
        }),
    ],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    build: {
        sourcemap: true,
        cssMinify: "lightningcss",
    },
});
