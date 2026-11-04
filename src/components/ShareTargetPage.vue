<template>
    <div class="flex min-h-[70vh] flex-col items-center justify-center p-6 text-center">
        <!-- Success State: Sent to Tesla -->
        <div
            v-if="castSuccess"
            class="max-w-md rounded-2xl bg-gray-100 p-8 shadow-xl backdrop-blur-md dark:bg-white/5 dark:shadow-2xl"
        >
            <div
                class="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-green-500/20 text-green-500 dark:text-green-400"
            >
                <i-fa6-solid-circle-check class="size-10" />
            </div>
            <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Sent to Tesla!</h1>
            <p class="mt-2 text-sm text-gray-600 dark:text-gray-300">
                Playing on your car screen right now without a video element.
            </p>

            <div
                v-if="parsedVideoId && !imgFailed"
                class="my-6 overflow-hidden rounded-xl bg-gray-200 shadow-inner dark:bg-black/40"
            >
                <img
                    :src="`https://i.ytimg.com/vi/${parsedVideoId}/hqdefault.jpg`"
                    alt="Video thumbnail"
                    class="aspect-video w-full object-cover"
                    @error="imgFailed = true"
                />
            </div>

            <div class="flex flex-col gap-3">
                <button
                    type="button"
                    class="cursor-pointer rounded-lg bg-red-600 px-4 py-2.5 font-medium text-white transition hover:bg-red-700"
                    @click="watchLocally"
                >
                    Watch on this phone instead
                </button>
                <button
                    type="button"
                    class="cursor-pointer rounded-lg bg-gray-200 px-4 py-2.5 text-sm text-gray-700 transition hover:bg-gray-300 dark:bg-white/10 dark:text-gray-300 dark:hover:bg-white/20"
                    @click="resetForm"
                >
                    Send another video
                </button>
            </div>
        </div>

        <!-- Loading State -->
        <div v-else-if="isSending" class="max-w-md rounded-2xl bg-gray-100 p-8 backdrop-blur-md dark:bg-white/5">
            <div class="mx-auto mb-4 size-10 animate-spin rounded-full border-4 border-red-500 border-t-transparent" />
            <h2 class="text-lg font-semibold text-gray-900 dark:text-white">Sending to your Tesla...</h2>
            <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">Transmitting to car browser queue</p>
        </div>

        <!-- Manual Input / Pairing State -->
        <div
            v-else
            class="w-full max-w-lg rounded-2xl bg-gray-100 p-8 shadow-xl backdrop-blur-md dark:bg-white/5 dark:shadow-2xl"
        >
            <div class="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-red-500/20 text-red-500">
                <i-fa6-solid-tower-broadcast class="size-8" />
            </div>
            <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Cast to Tesla</h1>
            <p class="mt-2 text-sm text-gray-600 dark:text-gray-300">
                Paste any YouTube URL below to instantly push it to your Tesla screen.
            </p>

            <div class="mt-6 flex flex-col gap-3">
                <input
                    v-model="manualUrl"
                    type="text"
                    placeholder="https://youtu.be/... or paste share text"
                    class="w-full rounded-lg bg-white px-4 py-3 text-gray-900 placeholder-gray-500 ring-1 ring-gray-300 outline-none focus:ring-2 focus:ring-red-500 dark:bg-black/40 dark:text-white dark:ring-white/10"
                    @keyup.enter="handleManualSend"
                />
                <button
                    type="button"
                    :disabled="!manualUrl.trim()"
                    class="cursor-pointer rounded-lg bg-red-600 py-3 font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
                    @click="handleManualSend"
                >
                    Cast Video to Car
                </button>
            </div>

            <div v-if="errorMessage" class="mt-4 rounded-lg bg-red-500/20 p-3 text-sm text-red-700 dark:text-red-300">
                {{ errorMessage }}
            </div>

            <div class="mt-8 border-t border-gray-200 pt-6 text-left dark:border-white/10">
                <h3 class="font-medium text-gray-900 dark:text-white">How it works:</h3>
                <ul class="mt-2 space-y-2 text-xs text-gray-600 dark:text-gray-400">
                    <li>1. Open this website on your Tesla browser and keep it open.</li>
                    <li>2. In Chrome on Android, tap <strong>Menu ➔ Add to Home screen</strong>.</li>
                    <li>3. From the YouTube app, tap <strong>Share</strong> and select <strong>Piped</strong>!</li>
                </ul>
            </div>
        </div>
    </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useCast } from "@/composables/useCast.js";
import { extractVideoInfo } from "@/utils/Misc.js";

const route = useRoute();
const router = useRouter();
const { sendCast } = useCast();

const isSending = ref(false);
const castSuccess = ref(false);
const imgFailed = ref(false);
const parsedVideoId = ref("");
const manualUrl = ref("");
const errorMessage = ref("");

async function processShare(rawText) {
    errorMessage.value = "";
    imgFailed.value = false;
    const parsed = extractVideoInfo(rawText);

    if (!parsed) {
        errorMessage.value = "Could not find a valid YouTube video link in the shared text.";
        return;
    }

    parsedVideoId.value = parsed.videoId;
    isSending.value = true;

    try {
        await sendCast(parsed);
        castSuccess.value = true;
    } catch (e) {
        console.error("Cast failed:", e);
        errorMessage.value = "Failed to transmit video to car: " + (e.message || "Network error");
    } finally {
        isSending.value = false;
    }
}

function handleManualSend() {
    if (!manualUrl.value.trim()) return;
    processShare(manualUrl.value.trim());
}

function watchLocally() {
    if (parsedVideoId.value) {
        router.push({
            path: "/watch",
            query: {
                v: parsedVideoId.value,
            },
        });
    }
}

function resetForm() {
    castSuccess.value = false;
    imgFailed.value = false;
    parsedVideoId.value = "";
    manualUrl.value = "";
    errorMessage.value = "";
}

onMounted(() => {
    // Check if opened via Android Web Share Target (title, text, or url query params)
    const shareQuery = [route.query.url, route.query.text, route.query.title].filter(Boolean).join(" ");
    if (shareQuery.trim()) {
        processShare(shareQuery);
    }
});
</script>
