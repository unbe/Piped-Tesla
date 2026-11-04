import * as MP4Box from "mp4box";

/**
 * Rewrites GoogleVideo or LBRY URLs through the Piped Proxy to avoid CORS and range restrictions.
 */
export function rewriteStreamUrl(rawUrl, proxyUrl) {
    if (!proxyUrl) return rawUrl;
    try {
        const url = new URL(rawUrl);
        const proxy = new URL(proxyUrl);
        let proxyPath = proxy.pathname;
        if (proxyPath.endsWith("/")) {
            proxyPath = proxyPath.slice(0, -1);
        }
        if (url.host.endsWith(".googlevideo.com") || url.host.endsWith(".lbryplayer.xyz")) {
            url.searchParams.set("host", url.host);
            url.protocol = proxy.protocol;
            url.host = proxy.host;
            url.pathname = proxyPath + url.pathname;
            return url.toString();
        }
        return rawUrl;
    } catch {
        return rawUrl;
    }
}

/**
 * CanvasPlayerEngine
 *
 * Renders MP4 video streams onto an HTML5 <canvas> element using the browser's
 * hardware-accelerated WebCodecs VideoDecoder API, synchronized to an HTMLAudioElement.
 * Completely eliminates any <video> tag in the DOM to bypass vehicle/browser restrictions in Drive mode.
 */
export class CanvasPlayerEngine {
    constructor(canvas, mediaClock) {
        this.canvas = canvas;
        this.ctx = canvas?.getContext("2d");
        this.mediaClock = mediaClock; // HTMLAudioElement serving as the master clock

        this.decoder = null;
        this.mp4box = null;
        this.frameQueue = [];
        this.animFrameId = null;
        this.abortController = null;

        this.videoTrack = null;
        this.timescale = 1;
        this.duration = 0;
        this.isReady = false;
        this.isDestroyed = false;

        this.chunkSize = 1024 * 1024 * 2; // 2MB fetch chunks
        this.currentByteOffset = 0;
        this.totalBytes = null;
        this.isFetching = false;
        this.isSeeking = false;
        this.needsKeyframe = true;
        this.seekEpoch = 0;
        this.maxBufferAheadSeconds = 12; // Buffer up to 12s ahead of mediaClock.currentTime
        this.maxQueuedFrames = 25; // Strict cap on open GPU VideoFrame allocations

        // Event listener references for clean removal
        this._onPlay = this.onPlay.bind(this);
        this._onPause = this.onPause.bind(this);
        this._onSeeking = this.onSeeking.bind(this);
        this._onSeeked = this.onSeeked.bind(this);
        this._onRateChange = this.onRateChange.bind(this);

        this.bindClockEvents();
    }

    bindClockEvents() {
        if (!this.mediaClock) return;
        this.mediaClock.addEventListener("play", this._onPlay);
        this.mediaClock.addEventListener("pause", this._onPause);
        this.mediaClock.addEventListener("seeking", this._onSeeking);
        this.mediaClock.addEventListener("seeked", this._onSeeked);
        this.mediaClock.addEventListener("ratechange", this._onRateChange);
    }

    unbindClockEvents() {
        if (!this.mediaClock) return;
        this.mediaClock.removeEventListener("play", this._onPlay);
        this.mediaClock.removeEventListener("pause", this._onPause);
        this.mediaClock.removeEventListener("seeking", this._onSeeking);
        this.mediaClock.removeEventListener("seeked", this._onSeeked);
        this.mediaClock.removeEventListener("ratechange", this._onRateChange);
    }

    /**
     * Extracts AVCDecoderConfigurationRecord / HEVCDecoderConfigurationRecord
     * from MP4Box sample entry box to supply to VideoDecoder.configure({ description }).
     * Accurately slices the buffer to avoid trailing garbage bytes that cause TypeError.
     */
    getCodecDescription(trak) {
        if (!trak?.mdia?.minf?.stbl?.stsd?.entries?.length) return null;
        const entry = trak.mdia.minf.stbl.stsd.entries[0];
        const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
        if (!box) return null;

        try {
            const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
            box.write(stream);
            const length = stream.position - 8;
            if (length <= 0) return null;
            // Slicing 8 bytes skips the 4-byte box size + 4-byte box name header.
            // Explicit length ensures no uninitialized trailing memory is passed to WebCodecs.
            return new Uint8Array(stream.buffer, 8, length);
        } catch (e) {
            console.warn("Failed to serialize codec description box:", e);
            return null;
        }
    }

    async load(videoUrl, expectedDuration = 0, startTime = 0, proxyUrl = "") {
        this.videoUrl = rewriteStreamUrl(videoUrl, proxyUrl);
        this.duration = expectedDuration;
        this.isReady = false;
        this.currentByteOffset = 0;
        this.totalBytes = null;
        this.abortController = new AbortController();

        // Probe total content length upfront via HEAD request
        try {
            const headRes = await fetch(this.videoUrl, {
                method: "HEAD",
                signal: this.abortController?.signal,
            });
            const clen = headRes.headers.get("Content-Length");
            if (clen) {
                const parsed = parseInt(clen, 10);
                if (!isNaN(parsed) && parsed > 0) {
                    this.totalBytes = parsed;
                }
            }
        } catch {
            // Non-fatal if HEAD fails; range requests will determine size
        }

        // Initialize MP4Box parser
        this.mp4box = MP4Box.createFile();

        this.mp4box.onError = err => {
            console.error("MP4Box parse error:", err);
        };

        const readyPromise = new Promise((resolve, reject) => {
            this.mp4box.onReady = info => {
                try {
                    this.onFileReady(info);
                    resolve(info);
                } catch (e) {
                    reject(e);
                }
            };
        });

        // Iteratively fetch initial chunks until the MP4 moov box is completely parsed
        let fetchOffset = 0;
        const initChunkSize = 1024 * 1024;
        while (!this.isReady && !this.isDestroyed) {
            await this.fetchChunk(fetchOffset, initChunkSize);
            fetchOffset += initChunkSize;
            if (this.totalBytes && fetchOffset >= this.totalBytes) break;
            await new Promise(r => setTimeout(r, 0));
        }

        await readyPromise;

        // If an initial start time is specified (e.g. from ?t= or watch history), seek immediately
        if (startTime > 0) {
            this.seekToTime(startTime);
        }

        // Start render loop
        this.startRenderLoop();

        // If clock is already playing, start buffering ahead
        if (this.mediaClock && !this.mediaClock.paused) {
            this.bufferAhead();
        }
    }

    onFileReady(info) {
        if (!info.videoTracks?.length) {
            throw new Error("No video track found in stream");
        }

        this.videoTrack = info.videoTracks[0];
        this.timescale = this.videoTrack.timescale || 1;

        if (this.videoTrack.video) {
            this.canvas.width = this.videoTrack.video.width || 1280;
            this.canvas.height = this.videoTrack.video.height || 720;
        }

        // Configure WebCodecs VideoDecoder
        this.initDecoder();

        // Configure sample extraction in batches
        this.mp4box.setExtractionOptions(this.videoTrack.id, null, {
            nbSamples: 30,
        });

        this.mp4box.onSamples = (trackId, ref, samples) => {
            if (this.isDestroyed || trackId !== this.videoTrack.id) return;
            for (const sample of samples) {
                this.decodeSample(sample);
            }
        };

        this.mp4box.start();
        this.isReady = true;
    }

    getDecoderConfig() {
        if (!this.videoTrack || !this.mp4box) return null;
        const trak = this.mp4box.moov?.traks?.find(t => t.tkhd.track_id === this.videoTrack.id);
        const description = this.getCodecDescription(trak);

        const config = {
            codec: this.videoTrack.codec,
            codedWidth: this.videoTrack.video.width,
            codedHeight: this.videoTrack.video.height,
        };

        if (description) {
            config.description = description;
        }
        return config;
    }

    initDecoder() {
        if (typeof VideoDecoder === "undefined") {
            throw new Error("WebCodecs VideoDecoder is not supported in this browser environment");
        }

        if (this.decoder) {
            try {
                this.decoder.close();
            } catch {
                // Ignore cleanup error on closed decoder
            }
        }

        this.decoder = new VideoDecoder({
            output: videoFrame => {
                if (this.isDestroyed) {
                    videoFrame.close();
                    return;
                }
                this.frameQueue.push(videoFrame);
            },
            error: err => {
                console.error("WebCodecs VideoDecoder runtime error:", err);
            },
        });

        const config = this.getDecoderConfig();
        if (config) {
            this.decoder.configure(config);
        }
        this.needsKeyframe = true;
    }

    resetDecoder() {
        if (!this.decoder) return;
        try {
            this.decoder.reset();
            const config = this.getDecoderConfig();
            if (config) {
                this.decoder.configure(config);
            }
        } catch (e) {
            console.warn("Reset decoder error:", e);
        }
        this.needsKeyframe = true;
        this.clearFrameQueue();
    }

    decodeSample(sample) {
        if (!this.decoder || this.decoder.state !== "configured") return;

        // WebCodecs requires a keyframe after configure() or flush().
        // Drop any delta frames until we receive a keyframe.
        if (this.needsKeyframe) {
            if (!sample.is_sync) {
                return;
            }
            this.needsKeyframe = false;
        }

        const cts = sample.cts ?? sample.dts ?? 0;
        const timestampUs = (cts / this.timescale) * 1_000_000;
        const durationUs = ((sample.duration ?? 0) / this.timescale) * 1_000_000;

        const chunk = new EncodedVideoChunk({
            type: sample.is_sync ? "key" : "delta",
            timestamp: timestampUs,
            duration: durationUs,
            data: sample.data,
        });

        try {
            this.decoder.decode(chunk);
        } catch (e) {
            console.warn("Failed to decode video chunk:", e);
            // If decoding failed, re-assert keyframe requirement for safety
            this.needsKeyframe = true;
        }
    }

    async fetchChunk(startByte, size = this.chunkSize) {
        if (this.isDestroyed || this.isFetching) return;
        if (this.totalBytes && startByte >= this.totalBytes) return;
        this.isFetching = true;
        const currentEpoch = this.seekEpoch;

        try {
            let endByte = startByte + size - 1;
            if (this.totalBytes && endByte >= this.totalBytes) {
                endByte = this.totalBytes - 1;
            }
            if (startByte > endByte) return;

            // Append range query param to support proxies rewriting headers
            const fetchUrl = new URL(this.videoUrl);
            fetchUrl.searchParams.set("range", `${startByte}-${endByte}`);

            const headers = { Range: `bytes=${startByte}-${endByte}` };
            const res = await fetch(fetchUrl.toString(), {
                headers,
                signal: this.abortController?.signal,
            });

            if (currentEpoch !== this.seekEpoch || this.isDestroyed) return;

            // If range is past EOF, server returns 400 or 416
            if (res.status === 416 || (res.status === 400 && startByte > 0)) {
                this.totalBytes = startByte;
                return;
            }

            if (!res.ok && res.status !== 206) {
                throw new Error(`HTTP ${res.status} fetching video range ${startByte}-${endByte}`);
            }

            const contentRange = res.headers.get("Content-Range");
            if (contentRange) {
                const match = contentRange.match(/\/(\d+)$/);
                if (match) this.totalBytes = parseInt(match[1], 10);
            }

            const buf = await res.arrayBuffer();
            if (currentEpoch !== this.seekEpoch || this.isDestroyed) return;

            buf.fileStart = startByte;

            if (this.mp4box && !this.isDestroyed) {
                this.mp4box.appendBuffer(buf);
            }

            if (currentEpoch !== this.seekEpoch || this.isDestroyed) return;

            this.currentByteOffset = startByte + buf.byteLength;

            // If fewer bytes were returned than requested, EOF was reached
            if (buf.byteLength < size) {
                this.totalBytes = this.currentByteOffset;
            }
        } catch (e) {
            if (e.name !== "AbortError") {
                console.warn("CanvasPlayer chunk fetch error:", e);
            }
        } finally {
            this.isFetching = false;
        }
    }

    async bufferAhead() {
        if (this.isDestroyed || this.isFetching || !this.isReady) return;
        if (this.totalBytes && this.currentByteOffset >= this.totalBytes) return;

        // Backpressure check 1: Cap open GPU VideoFrames in queue to prevent GPU RAM exhaustion
        if (this.frameQueue.length >= this.maxQueuedFrames) return;

        // Backpressure check 2: Cap buffer duration ahead of mediaClock
        if (this.frameQueue.length > 0 && this.mediaClock) {
            const lastFrameTimeSec = this.frameQueue[this.frameQueue.length - 1].timestamp / 1_000_000;
            if (lastFrameTimeSec > this.mediaClock.currentTime + this.maxBufferAheadSeconds) {
                return;
            }
        }

        await this.fetchChunk(this.currentByteOffset, this.chunkSize);
    }

    startRenderLoop() {
        if (this.animFrameId) return;

        const render = () => {
            if (this.isDestroyed) return;

            this.renderFrame();

            // Periodic buffer filling while playing (skip if currently seeking)
            if (this.mediaClock && !this.mediaClock.paused && !this.isFetching && !this.isSeeking) {
                this.bufferAhead();
            }

            // Continue animation loop if playing; pause loop if mediaClock is paused
            if (this.mediaClock && !this.mediaClock.paused) {
                this.animFrameId = requestAnimationFrame(render);
            } else {
                this.animFrameId = null;
            }
        };

        this.animFrameId = requestAnimationFrame(render);
    }

    renderFrame() {
        if (!this.mediaClock || !this.ctx || this.frameQueue.length === 0) return;

        const masterTimeUs = this.mediaClock.currentTime * 1_000_000; // Microseconds

        // 1. Drop stale preroll frames older than master clock (with 60ms tolerance)
        while (this.frameQueue.length > 0 && this.frameQueue[0].timestamp < masterTimeUs - 60_000) {
            if (this.frameQueue.length === 1 && (this.mediaClock.paused || this.isSeeking)) {
                break;
            }
            const staleFrame = this.frameQueue.shift();
            staleFrame.close();
        }

        // 2. Render frame closest to current master clock
        if (this.frameQueue.length > 0) {
            const headFrame = this.frameQueue[0];
            const timeDiff = headFrame.timestamp - masterTimeUs;

            // Render strictly if within window (-60ms to +50ms).
            // Past preroll frames are never drawn to prevent the fast-forward visual artifact on seek.
            if (timeDiff >= -60_000 && timeDiff <= 50_000) {
                try {
                    this.ctx.drawImage(headFrame, 0, 0, this.canvas.width, this.canvas.height);
                } catch (e) {
                    console.warn("Canvas drawImage error:", e);
                }

                // If next frame is already due, discard this frame and draw next immediately
                if (this.frameQueue.length > 1 && this.frameQueue[1].timestamp <= masterTimeUs) {
                    const consumed = this.frameQueue.shift();
                    consumed.close();
                    try {
                        this.ctx.drawImage(this.frameQueue[0], 0, 0, this.canvas.width, this.canvas.height);
                    } catch {
                        // Ignore draw error
                    }
                }
            } else if (this.mediaClock.paused && this.frameQueue.length === 1) {
                try {
                    this.ctx.drawImage(headFrame, 0, 0, this.canvas.width, this.canvas.height);
                } catch {
                    // Ignore draw error
                }
            }
        }
    }

    onPlay() {
        this.startRenderLoop();
        this.bufferAhead();
    }

    onPause() {
        // Render current static frame once, then cancel RAF loop
        this.renderFrame();
        if (this.animFrameId) {
            cancelAnimationFrame(this.animFrameId);
            this.animFrameId = null;
        }
    }

    async onSeeking() {
        this.isSeeking = true;
        this.needsKeyframe = true;
        this.seekEpoch = (this.seekEpoch || 0) + 1;
        // Abort in-flight chunk download from prior position
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = new AbortController();
            this.isFetching = false;
        }
        this.clearFrameQueue();
    }

    async onSeeked() {
        const epoch = ++this.seekEpoch;
        this.isSeeking = true;
        this.needsKeyframe = true;

        if (this.abortController) {
            this.abortController.abort();
            this.abortController = new AbortController();
            this.isFetching = false;
        }

        this.clearFrameQueue();
        this.resetDecoder();

        if (epoch !== this.seekEpoch || this.isDestroyed) return;

        const targetTimeSeconds = this.mediaClock?.currentTime || 0;
        this.seekToTime(targetTimeSeconds);
        this.isSeeking = false;
        this.renderFrame();
    }

    seekToTime(targetTimeSeconds) {
        if (this.videoTrack && this.mp4box) {
            const trak = this.mp4box.getTrackById(this.videoTrack.id);
            const seekInfo = trak
                ? this.mp4box.seekTrack(targetTimeSeconds, true, trak)
                : this.mp4box.seek(targetTimeSeconds, true);
            if (seekInfo && typeof seekInfo.offset === "number") {
                this.currentByteOffset = seekInfo.offset;
            }
        }
        this.bufferAhead();
    }

    onRateChange() {
        // Master clock audioEl automatically controls the rate;
        // renderLoop compares to audioEl.currentTime so rate changes apply instantly.
    }

    clearFrameQueue() {
        while (this.frameQueue.length > 0) {
            const frame = this.frameQueue.shift();
            try {
                frame.close();
            } catch {
                // Frame already closed
            }
        }
    }

    destroy() {
        this.isDestroyed = true;
        if (this.animFrameId) {
            cancelAnimationFrame(this.animFrameId);
            this.animFrameId = null;
        }

        this.unbindClockEvents();

        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }

        this.clearFrameQueue();

        if (this.decoder) {
            try {
                this.decoder.close();
            } catch {
                // Ignore close error on destroy
            }
            this.decoder = null;
        }

        if (this.ctx && this.canvas) {
            try {
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            } catch {
                // Ignore clear error
            }
        }

        this.mp4box = null;
        this.ctx = null;
        this.canvas = null;
        this.mediaClock = null;
    }
}
