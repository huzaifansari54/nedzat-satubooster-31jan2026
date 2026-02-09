const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const OpenAI = require('openai');

// Base directory for uploads
const UPLOAD_DIR = path.join(__dirname, '..', '..', '..', 'uploads');

/**
 * Transcodes any audio format to OGG/Opus (optimized for WhatsApp).
 * @param {string} inPath 
 * @returns {Promise<string>} Path to generated .ogg file
 */
async function transcodeToOpusOgg(inPath) {
    return new Promise((resolve, reject) => {
        const outPath = inPath.replace(/\.[^.]+$/i, '') + '.ogg';
        execFile(
            process.env.FFMPEG_BIN || 'ffmpeg',
            [
                '-y', '-hide_banner', '-loglevel', 'error',
                '-i', inPath,
                '-map', '0:a:0',
                '-vn',
                '-ac', '1',          // Mono
                '-ar', '16000',      // 16 kHz - target phone compatibility
                '-c:a', 'libopus',
                '-b:a', '24k',
                '-application', 'voip',
                '-f', 'ogg',
                outPath
            ],
            { timeout: 40000 },
            (err) => err ? reject(err) : resolve(outPath)
        );
    });
}

/**
 * Normalizes audio specifically for WhatsApp PTT (Voice Message) appearance.
 * @param {string} absPath 
 * @returns {Promise<{abs: string, mime: string, ptt: boolean}>}
 */
async function normalizeAudioForWA(absPath) {
    try {
        const ogg = await transcodeToOpusOgg(absPath);
        return { abs: ogg, mime: 'audio/ogg; codecs=opus', ptt: true };
    } catch (err) {
        console.warn('[MEDIA] transcode failed, using original:', err?.message || err);
        const ext = path.extname(absPath).toLowerCase();
        const mime = ext === '.webm' ? 'audio/webm' :
            ext === '.ogg' ? 'audio/ogg' :
                ext === '.mp3' ? 'audio/mpeg' :
                    ext === '.m4a' ? 'audio/mp4' :
                        'audio/ogg';
        return { abs: absPath, mime, ptt: true };
    }
}

/**
 * Creates an M4A preview of an audio file for web playback compat (iOS Safari).
 * @param {string} inPath 
 * @returns {Promise<string>}
 */
async function makePreviewM4A(inPath) {
    return new Promise((resolve, reject) => {
        const outPath = inPath.replace(/\.[^.]+$/i, '') + '.m4a';
        execFile(
            process.env.FFMPEG_BIN || 'ffmpeg',
            [
                '-y', '-hide_banner', '-loglevel', 'error',
                '-i', inPath,
                '-map', '0:a:0',
                '-vn',
                '-ac', '1',
                '-ar', '44100',
                '-c:a', 'aac',
                '-b:a', '64k',
                '-movflags', '+faststart',
                outPath
            ],
            { timeout: 40000 },
            (err) => err ? reject(err) : resolve(outPath)
        );
    });
}

async function safeMakePreviewM4A(inPath) {
    try {
        return await makePreviewM4A(inPath);
    } catch (e) {
        console.warn('[MEDIA][M4A] preview failed:', e?.message || e);
        return inPath;
    }
}

/**
 * Grabs a frame from a video file and saves it as JPG.
 * @param {string} absVideoPath 
 * @returns {Promise<string|null>}
 */
async function videoFirstFrameToJpg(absVideoPath) {
    return new Promise((resolve) => {
        try {
            const outJpg = path.join(UPLOAD_DIR, path.basename(absVideoPath).replace(/\.[^.]+$/i, '') + '-frame1.jpg');
            execFile(process.env.FFMPEG_BIN || 'ffmpeg',
                ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '00:00:01', '-i', absVideoPath, '-frames:v', '1', '-q:v', '2', outJpg],
                { timeout: 15000 },
                (err) => {
                    if (err) return resolve(null);
                    fs.access(outJpg, fs.constants.R_OK, (e) => resolve(e ? null : outJpg));
                }
            );
        } catch (_) {
            resolve(null);
        }
    });
}

/**
 * Transcribes audio using Whisper, with a fallback that re-encodes to WAV.
 * @param {string} absPath 
 * @param {string} openaiKey 
 * @returns {Promise<string>}
 */
async function transcribeWithFallback(absPath, openaiKey) {
    const openai = new OpenAI({ apiKey: openaiKey });

    // Attempt 1: Direct transcription
    try {
        const r1 = await openai.audio.transcriptions.create({
            file: fs.createReadStream(absPath),
            model: 'whisper-1',
            response_format: 'text',
            temperature: 0
        });
        const t1 = String(r1 || '').trim();
        if (t1) return t1;
    } catch (e) {
        console.warn('[ASR] Whisper direct fail:', e?.message || e);
    }

    // Attempt 2: Re-encode to WAV 16k mono and retry
    try {
        const tmpWav = absPath.replace(/\.[^.]+$/i, '') + '.wav';
        await new Promise((res, rej) => {
            execFile(process.env.FFMPEG_BIN || 'ffmpeg',
                ['-y', '-hide_banner', '-loglevel', 'error', '-i', absPath, '-ac', '1', '-ar', '16000', tmpWav],
                { timeout: 30000 },
                (err) => err ? rej(err) : res()
            );
        });
        const r2 = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tmpWav),
            model: 'whisper-1',
            response_format: 'text',
            temperature: 0
        });
        const t2 = String(r2 || '').trim();
        if (t2) return t2;
    } catch (e) {
        console.warn('[ASR] Whisper fallback fail:', e?.message || e);
    }

    return '';
}

module.exports = {
    transcodeToOpusOgg,
    normalizeAudioForWA,
    makePreviewM4A,
    safeMakePreviewM4A,
    videoFirstFrameToJpg,
    transcribeWithFallback
};
