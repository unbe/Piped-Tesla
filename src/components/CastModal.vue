<template>
    <ModalComponent @close="$emit('close')">
        <h2 class="text-center text-xl font-bold">Cast to Tesla Screen</h2>

        <div class="my-4 flex items-center justify-center gap-2 text-sm">
            <span class="size-2.5 rounded-full" :class="isConnected ? 'animate-pulse bg-green-500' : 'bg-red-500'" />
            <span class="text-gray-400">
                {{ isConnected ? `Receiver Active (${connectedClients} connected)` : "Reconnecting to receiver..." }}
            </span>
        </div>

        <!-- Scan to Pair on Phone -->
        <div class="my-4 flex flex-col items-center justify-center rounded-xl bg-black/20 p-4">
            <p class="mb-2 text-xs text-gray-400">Scan with your phone to open the Share Target on mobile:</p>
            <QrCode v-if="castUrl" :text="castUrl" />
            <span class="mt-2 font-mono text-xs text-gray-500 select-all">{{ castUrl }}</span>
        </div>

        <!-- Manual URL Input -->
        <div class="mt-4 flex flex-col gap-2">
            <label class="text-xs text-gray-400">Or paste YouTube link directly:</label>
            <div class="flex gap-2">
                <input
                    v-model="inputUrl"
                    type="text"
                    placeholder="https://youtu.be/..."
                    class="h-10 flex-1 rounded-md bg-gray-300 px-3 text-sm text-gray-800 outline-none focus:ring-2 focus:ring-red-500 dark:bg-dark-400 dark:text-gray-200"
                    @keyup.enter="castNow"
                />
                <Button :disabled="!inputUrl.trim()" @click="castNow"> Cast </Button>
            </div>
            <p v-if="castFeedback" class="mt-1 text-xs text-green-400">
                {{ castFeedback }}
            </p>
        </div>

        <div class="mt-6 flex justify-end">
            <Button @click="$emit('close')"> Close </Button>
        </div>
    </ModalComponent>
</template>

<script setup>
import { ref, computed, defineAsyncComponent } from "vue";
import ModalComponent from "./ModalComponent.vue";
import Button from "./ui/Button.vue";
import { useCast } from "@/composables/useCast.js";

defineEmits(["close"]);

const QrCode = defineAsyncComponent(() => import("./QrCode.vue"));
const { isConnected, connectedClients, sendCast } = useCast();

const inputUrl = ref("");
const castFeedback = ref("");

const castUrl = computed(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/share-target`;
});

async function castNow() {
    if (!inputUrl.value.trim()) return;
    try {
        await sendCast({ raw: inputUrl.value.trim() });
        castFeedback.value = "Sent! Playing on screen...";
        inputUrl.value = "";
        setTimeout(() => {
            castFeedback.value = "";
        }, 3000);
    } catch (e) {
        castFeedback.value = "Error: " + e.message;
    }
}
</script>
