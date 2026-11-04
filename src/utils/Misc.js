export const isEmail = input => {
    // Taken from https://emailregex.com
    const result = input.match(
        //eslint-disable-next-line
        /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
    );
    return result;
};

export const parseTimeParam = time => {
    let start = 0;
    if (/^\d+$/.test(time)) {
        start = time;
    } else {
        const hours = /([\d]+)h/i.exec(time)?.[1];
        const minutes = /([\d]+)m/i.exec(time)?.[1];
        const seconds = /([\d]+)s/i.exec(time)?.[1];
        if (hours) {
            start += parseInt(hours) * 60 * 60;
        }
        if (minutes) {
            start += parseInt(minutes) * 60;
        }
        if (seconds) {
            start += parseInt(seconds);
        }
    }
    return start;
};

export const extractVideoInfo = input => {
    if (!input || typeof input !== "string") return null;

    const trimmed = input.trim();

    // 1. Direct 11-char YouTube video ID
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
        return { videoId: trimmed, time: 0 };
    }

    // 2. YouTube & Piped URL pattern (matches youtu.be, youtube.com watch/shorts/embed/live/v, piped watch, or any /watch?v=)
    const urlPattern =
        /(?:(?:https?:\/\/)?(?:[\w-]+\.)*(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|embed\/|v\/|shorts\/|live\/)|youtu\.be\/|piped\.[a-z.]+\/watch\?v=)|(?:\/watch\?(?:[^#\s]*&)?v=))([a-zA-Z0-9_-]{11})(?![a-zA-Z0-9_-])/i;

    const match = trimmed.match(urlPattern);
    if (!match) return null;

    const videoId = match[1];

    // 3. Extract timestamp parameter (?t=... or &t=... or #t=... or ?start=...)
    let time = 0;
    const timeMatch = trimmed.match(/[?&#](?:t|start)=([0-9a-zA-Z]+)/);
    if (timeMatch?.[1]) {
        time = Number(parseTimeParam(timeMatch[1])) || 0;
    }

    return { videoId, time };
};
