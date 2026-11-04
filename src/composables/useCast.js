import { ref } from "vue";
import { extractVideoInfo } from "@/utils/Misc.js";

const isConnected = ref(false);
const connectedClients = ref(0);
const lastReceivedVideo = ref(null);
let eventSource = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let mySenderId = null;

function getSenderId() {
    if (!mySenderId && typeof window !== "undefined") {
        try {
            mySenderId = sessionStorage.getItem("piped_cast_sender_id");
            if (!mySenderId) {
                mySenderId =
                    typeof crypto !== "undefined" && crypto.randomUUID
                        ? crypto.randomUUID()
                        : Math.random().toString(36).slice(2);
                sessionStorage.setItem("piped_cast_sender_id", mySenderId);
            }
        } catch {
            mySenderId = Math.random().toString(36).slice(2);
        }
    }
    return mySenderId;
}

export function useCast() {
    function disconnectCastReceiver() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
        isConnected.value = false;
    }

    function initCastReceiver(router, onPlayCallback) {
        if (typeof window === "undefined" || !window.EventSource) return;
        if (eventSource) return;

        function connect() {
            try {
                eventSource = new EventSource("/api/cast/events");

                eventSource.onopen = () => {
                    isConnected.value = true;
                    reconnectAttempts = 0;
                };

                eventSource.onmessage = event => {
                    try {
                        const data = JSON.parse(event.data);
                        if (data.type === "connected") {
                            connectedClients.value = data.clients || 1;
                        } else if (data.type === "play" && data.videoId) {
                            // Do not navigate if this client sent the cast
                            if (data.senderId && data.senderId === getSenderId()) {
                                return;
                            }
                            // Do not navigate away if the user is currently on the share/cast management pages
                            const currentPath = router?.currentRoute?.value?.path;
                            if (currentPath === "/share-target" || currentPath === "/cast") {
                                return;
                            }

                            lastReceivedVideo.value = data;
                            if (onPlayCallback) {
                                onPlayCallback(data);
                            } else if (router) {
                                router.push({
                                    path: "/watch",
                                    query: {
                                        v: data.videoId,
                                        t: data.time > 0 ? data.time : undefined,
                                        tesla: "true",
                                    },
                                });
                            }
                        }
                    } catch (e) {
                        console.warn("Error parsing cast SSE event:", e);
                    }
                };

                eventSource.onerror = () => {
                    isConnected.value = false;
                    if (eventSource) {
                        eventSource.close();
                        eventSource = null;
                    }
                    if (!reconnectTimer) {
                        const delay = Math.min(30000, 2000 * Math.pow(1.5, reconnectAttempts++));
                        reconnectTimer = setTimeout(() => {
                            reconnectTimer = null;
                            connect();
                        }, delay);
                    }
                };
            } catch (e) {
                console.warn("Failed to create EventSource for cast receiver:", e);
                if (!reconnectTimer) {
                    reconnectTimer = setTimeout(() => {
                        reconnectTimer = null;
                        connect();
                    }, 5000);
                }
            }
        }

        connect();
    }

    async function sendCast(payload) {
        let videoId = payload.videoId;
        let time = payload.time || 0;

        if (!videoId && (payload.url || payload.text || payload.raw)) {
            const parsed = extractVideoInfo(payload.url || payload.text || payload.raw);
            if (parsed) {
                videoId = parsed.videoId;
                time = parsed.time;
            }
        }

        if (!videoId) {
            throw new Error("Could not parse YouTube video ID from input");
        }

        const res = await fetch("/api/cast/push", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                videoId,
                time,
                title: payload.title || "",
                tesla: true,
                senderId: getSenderId(),
            }),
        });

        if (!res.ok) {
            throw new Error(`Cast push failed: HTTP ${res.status}`);
        }

        return await res.json();
    }

    return {
        isConnected,
        connectedClients,
        lastReceivedVideo,
        initCastReceiver,
        disconnectCastReceiver,
        sendCast,
    };
}
