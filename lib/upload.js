import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import {
  getDownloadsDir,
  enforceStorageQuota,
  registerActiveUpload,
  unregisterActiveUpload,
  addUserUploadRecord,
  purgeExpiredUploads
} from './store.js';
import { enqueueCpuJob } from './download/queue.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB hard ceiling
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MB max per chunk (client sends 3.5 MB)
export const UPLOAD_ID_REGEX = /^upl_[a-f0-9]{32}$/;
const UPLOAD_SESSION_REGEX = /^ups_[a-f0-9]{32}$/;
const MULTIPART_ENVELOPE_SLACK_BYTES = 512 * 1024;
const CHUNK_SESSION_TTL_MS = 30 * 60 * 1000;
const UPLOAD_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

const ALLOWED_CONTAINER_RE = /\b(mp3|m4a|mp4|mov|wav|flac|aac|ogg|opus|aiff|asf|matroska|webm)\b/i;
const FORBIDDEN_CONTAINER_RE = /\b(image2|tty|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|svg_pipe|gif|srt|webvtt|ass|pdf)\b/i;
const ATTACHED_COVER_CODECS = new Set(['mjpeg', 'png', 'bmp', 'webp', 'gif']);

if (!global.__uploadChunkSessions) {
  global.__uploadChunkSessions = new Map();
}
const chunkSessions = global.__uploadChunkSessions;

export function generateUploadId() {
  return `upl_${crypto.randomBytes(16).toString('hex')}`;
}

function generateUploadSessionId() {
  return `ups_${crypto.randomBytes(16).toString('hex')}`;
}

export function formatDurationSeconds(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const rounded = Math.max(1, Math.round(n));
  const mins = Math.floor(rounded / 60);
  const secs = String(rounded % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

export function sanitizeDisplayMetadataFromName(rawName) {
  const raw = String(rawName || '');
  const leaf = raw.split(/[\\/]/).pop() || '';
  const cleaned = leaf
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\.(mp3|m4a|wav|flac|aac|ogg|opus|mp4|avi|mkv|mov|webm)$/i, '')
    .replace(
      /^(?:www\.)?(?:y2mate|ytmp3\w*|yt1s|spotifydown|savetube|ssyoutube|loader|cnvmp3|snapinsta|cobalt)(?:\.[a-z]{2,8})?\s*[-–—_:]+\s*/i,
      ''
    )
    .replace(/_/g, ' ')
    .replace(/\s*[\(\[]\s*\d{2,4}\s*k(?:bps)?\s*[\)\]]/gi, '')
    .replace(/\b\d{2,4}\s*kbps\b/gi, '')
    .replace(
      /\s*[\(\[]\s*(?:official\s*(?:music\s*)?(?:video|audio|lyric\s*video)|video\s*oficial|audio\s*oficial|lyrics?|letra)\s*[\)\]]/gi,
      ''
    )
    .replace(/(?<=[\p{L}\p{N}]{3})(avi|mp4|mkv|webm|flv|mov|wmv)$/iu, '')
    .replace(/^\d{1,3}\s*[.)]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);

  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return { fallbackTitle: 'Audio subido', fallbackArtist: 'Archivo propio' };
  }

  if (/\s+[-–—]\s+/.test(cleaned)) {
    const parts = cleaned.split(/\s+[-–—]\s+/);
    const artistCandidate = parts[0].trim();
    const titleCandidate = parts.slice(1).join(' - ').trim();
    if (artistCandidate.length >= 2 && titleCandidate.length >= 1) {
      return {
        fallbackTitle: titleCandidate.slice(0, 100),
        fallbackArtist: artistCandidate.slice(0, 80)
      };
    }
  }

  return { fallbackTitle: cleaned.slice(0, 100), fallbackArtist: 'Archivo propio' };
}

function spawnBinaryCapture(bin, args, timeoutMs = 15000) {
  return new Promise(resolve => {
    let stdoutText = '';
    let stderrText = '';
    let settled = false;
    let child;

    try {
      child = spawn(/*turbopackIgnore: true*/ bin, args, {
        shell: false,
        windowsHide: true
      });
    } catch (err) {
      return resolve({ ok: false, code: -1, stdout: '', stderr: err.message });
    }

    const finish = res => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({ ok: false, code: -1, stdout: stdoutText, stderr: 'Process timeout exceeded' });
    }, timeoutMs);

    child.stdout?.on('data', chunk => {
      if (stdoutText.length < 256 * 1024) {
        stdoutText += chunk.toString('utf8');
      }
    });

    child.stderr?.on('data', chunk => {
      if (stderrText.length < 64 * 1024) {
        stderrText += chunk.toString('utf8');
      }
    });

    child.on('error', err => {
      finish({ ok: false, code: -1, stdout: stdoutText, stderr: err.message });
    });

    child.on('close', code => {
      finish({ ok: code === 0, code, stdout: stdoutText, stderr: stderrText });
    });
  });
}

export async function probeAudioFile(filePath) {
  const ffprobeBin = process.env.FFPROBE_BIN?.trim() || 'ffprobe';
  const args = [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,codec_name,sample_rate,channels,duration:format=format_name,duration:format_tags=title,artist,album,TITLE,ARTIST,ALBUM',
    '-of',
    'json',
    '-i',
    filePath
  ];

  const res = await spawnBinaryCapture(ffprobeBin, args, 15000);
  if (!res.ok || !res.stdout) {
    return { ok: false, error: 'ffprobe rejected input file' };
  }

  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { ok: false, error: 'Invalid ffprobe JSON output' };
  }

  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const format = parsed?.format || {};
  const formatName = String(format.format_name || '').trim();

  if (!formatName || FORBIDDEN_CONTAINER_RE.test(formatName) || !ALLOWED_CONTAINER_RE.test(formatName)) {
    return { ok: false, error: `Unsupported container: ${formatName || 'unknown'}` };
  }

  const hasMotionVideo = streams.some(s => {
    if (!s || s.codec_type !== 'video') return false;
    const vcodec = String(s.codec_name || '').trim().toLowerCase();
    return !ATTACHED_COVER_CODECS.has(vcodec);
  });
  if (hasMotionVideo) {
    return { ok: false, error: 'Video files are not allowed' };
  }

  const hasAttachedCover = streams.some(s => {
    if (!s || s.codec_type !== 'video') return false;
    const vcodec = String(s.codec_name || '').trim().toLowerCase();
    return ATTACHED_COVER_CODECS.has(vcodec);
  });

  const audioStream = streams.find(s => s && s.codec_type === 'audio');
  if (!audioStream) {
    return { ok: false, error: 'No audio stream found' };
  }

  const acodec = String(audioStream.codec_name || '').trim().toLowerCase();
  const sampleRate = Number(audioStream.sample_rate || 0);
  const channels = Number(audioStream.channels || 0);
  if (!acodec || !Number.isFinite(sampleRate) || sampleRate < 8000 || !Number.isFinite(channels) || channels < 1) {
    return { ok: false, error: 'Invalid audio stream parameters' };
  }

  const rawDuration = Number(format.duration) || Number(audioStream.duration) || 0;
  const isRawAacAdts = formatName.toLowerCase() === 'aac';
  if (!isRawAacAdts && (!Number.isFinite(rawDuration) || rawDuration <= 0.05)) {
    return { ok: false, error: 'Audio duration is zero or unreadable' };
  }

  const rawTags = format.tags || {};
  const cleanTag = val =>
    String(val || '')
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  return {
    ok: true,
    acodec,
    formatName,
    sampleRate,
    channels,
    hasAttachedCover,
    durationSec: rawDuration > 0 ? Math.round(rawDuration) : null,
    duration: rawDuration > 0 ? formatDurationSeconds(rawDuration) : '—',
    tags: {
      title: cleanTag(rawTags.title || rawTags.TITLE).slice(0, 120),
      artist: cleanTag(rawTags.artist || rawTags.ARTIST).slice(0, 100),
      album: cleanTag(rawTags.album || rawTags.ALBUM).slice(0, 100)
    }
  };
}

export function extractEmbeddedCoverDataUrl(filePath, maxBinaryBytes = 16384) {
  const ffmpegBin = process.env.FFMPEG_BIN?.trim() || 'ffmpeg';
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    filePath,
    '-an',
    '-sn',
    '-dn',
    '-vframes',
    '1',
    '-vf',
    "scale='min(96,iw)':'min(96,ih)':force_original_aspect_ratio=decrease",
    '-q:v',
    '9',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    'pipe:1'
  ];

  return new Promise(resolve => {
    const chunks = [];
    let totalBytes = 0;
    let overflowed = false;
    let settled = false;
    let child;

    try {
      child = spawn(/*turbopackIgnore: true*/ ffmpegBin, args, {
        shell: false,
        windowsHide: true
      });
    } catch {
      return resolve(null);
    }

    const finish = val => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish(null);
    }, 10000);

    child.stdout?.on('data', chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes <= maxBinaryBytes) {
        chunks.push(buf);
      } else {
        overflowed = true;
      }
    });

    child.on('error', () => finish(null));
    child.on('close', code => {
      if (code !== 0 || overflowed || totalBytes < 32) {
        return finish(null);
      }
      const combined = Buffer.concat(chunks, totalBytes);
      // Verify JPEG SOI marker (0xFF 0xD8)
      if (combined[0] !== 0xff || combined[1] !== 0xd8) {
        return finish(null);
      }
      finish(`data:image/jpeg;base64,${combined.toString('base64')}`);
    });
  });
}

export async function convertUploadToM4a(userId, rawFilePath, outputM4aPath, options = {}) {
  const { acodec = '', title = '', artist = '', album = '' } = options;
  const ffmpegBin = process.env.FFMPEG_BIN?.trim() || 'ffmpeg';
  const isNativeAac = /^(aac|mp4a)/i.test(String(acodec || '').trim());

  const buildFfmpegArgs = useStreamCopy => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', rawFilePath, '-vn', '-sn', '-dn'];
    if (useStreamCopy) {
      args.push('-c:a', 'copy', '-bsf:a', 'aac_adtstoasc');
    } else {
      args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '44100');
    }
    args.push('-map_metadata', '0');
    if (title) args.push('-metadata', `title=${String(title)}`);
    if (artist) args.push('-metadata', `artist=${String(artist)}`);
    if (album) args.push('-metadata', `album=${String(album)}`);
    args.push('-movflags', '+faststart', outputM4aPath);
    return args;
  };

  return enqueueCpuJob(userId, async () => {
    if (isNativeAac) {
      const copyRes = await spawnBinaryCapture(ffmpegBin, buildFfmpegArgs(true), 90000);
      if (copyRes.ok && fs.existsSync(outputM4aPath) && fs.statSync(outputM4aPath).size > 256) {
        return copyRes;
      }
      try {
        if (fs.existsSync(outputM4aPath)) fs.unlinkSync(outputM4aPath);
      } catch {}
    }

    return spawnBinaryCapture(ffmpegBin, buildFfmpegArgs(false), 90000);
  });
}

function safeUnlink(targetPath) {
  try {
    if (targetPath && fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
  } catch {}
}

export async function processUploadedTempFile({
  userId,
  tempPath,
  originalDisplayName = '',
  uploadId = null
}) {
  const id = uploadId && UPLOAD_ID_REGEX.test(uploadId) ? uploadId : generateUploadId();
  const downloadsDir = getDownloadsDir();
  const filename = `${id}.m4a`;
  const outputM4aPath = path.join(downloadsDir, filename);

  registerActiveUpload(id);
  try {
    if (!tempPath || !fs.existsSync(tempPath)) {
      return { ok: false, status: 400, error: 'No se recibió ningún archivo.' };
    }

    const rawStat = fs.statSync(tempPath);
    if (rawStat.size <= 0) {
      return { ok: false, status: 400, error: 'El archivo recibido está vacío.' };
    }
    if (rawStat.size > MAX_UPLOAD_BYTES) {
      return {
        ok: false,
        status: 413,
        error: 'El archivo supera el límite máximo permitido de 50 MB.'
      };
    }

    const probe = await probeAudioFile(tempPath);
    if (!probe.ok) {
      return {
        ok: false,
        status: 400,
        error: 'El archivo no es un audio válido compatible (.mp3, .m4a, .wav o .flac).'
      };
    }

    const { fallbackTitle, fallbackArtist } = sanitizeDisplayMetadataFromName(originalDisplayName);
    const title = probe.tags.title || fallbackTitle;
    const artist = probe.tags.artist || fallbackArtist;
    const album = probe.tags.album || 'Mi música';
    const embeddedArtwork = probe.hasAttachedCover
      ? await extractEmbeddedCoverDataUrl(tempPath)
      : null;

    const conv = await convertUploadToM4a(userId, tempPath, outputM4aPath, {
      acodec: probe.acodec,
      title,
      artist,
      album
    });

    if (!conv.ok || !fs.existsSync(outputM4aPath)) {
      safeUnlink(outputM4aPath);
      return {
        ok: false,
        status: 400,
        error: 'No se pudo convertir el archivo de audio a formato m4a.'
      };
    }

    const outProbe = await probeAudioFile(outputM4aPath);
    if (!outProbe.ok) {
      safeUnlink(outputM4aPath);
      return {
        ok: false,
        status: 500,
        error: 'La conversión de audio generó un archivo inválido.'
      };
    }

    const streamUrl = `/api/stream?file=${encodeURIComponent(filename)}`;
    const record = addUserUploadRecord({
      id,
      userId,
      title,
      artist,
      album,
      duration: outProbe.duration !== '—' ? outProbe.duration : probe.duration,
      durationSec: outProbe.durationSec ?? probe.durationSec,
      filename,
      streamUrl,
      artwork: embeddedArtwork || '/icon.svg?v=3',
      source: 'own',
      fileDeleted: false,
      createdAt: Date.now(),
      deletedAt: null
    });

    enforceStorageQuota();

    return {
      ok: true,
      status: 200,
      id,
      filename,
      streamUrl,
      track: record
    };
  } finally {
    safeUnlink(tempPath);
    unregisterActiveUpload(id);
  }
}

export async function streamWebReadableToFile(
  readableStream,
  destPath,
  { maxBytes = MAX_UPLOAD_BYTES, append = false, initialBytes = 0 } = {}
) {
  if (!readableStream) {
    return { ok: false, tooLarge: false, bytesWritten: 0, error: 'Empty body stream' };
  }

  const reader = readableStream.getReader();
  const ws = fs.createWriteStream(destPath, {
    flags: append ? 'a' : 'w',
    mode: 0o600
  });

  let streamError = null;
  ws.on('error', err => {
    streamError = err;
  });

  let chunkBytesWritten = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      chunkBytesWritten += value.byteLength;
      if (initialBytes + chunkBytesWritten > maxBytes) {
        try {
          await reader.cancel();
        } catch {}
        ws.destroy();
        safeUnlink(destPath);
        return {
          ok: false,
          tooLarge: true,
          bytesWritten: chunkBytesWritten
        };
      }

      if (streamError) {
        throw streamError;
      }

      const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (!ws.write(buf)) {
        await new Promise((resolve, reject) => {
          ws.once('drain', resolve);
          ws.once('error', reject);
        });
      }
    }

    await new Promise((resolve, reject) => {
      ws.end(() => {
        if (streamError) reject(streamError);
        else resolve();
      });
      ws.once('error', reject);
    });

    return { ok: true, tooLarge: false, bytesWritten: chunkBytesWritten };
  } catch (err) {
    try {
      await reader.cancel();
    } catch {}
    ws.destroy();
    safeUnlink(destPath);
    return {
      ok: false,
      tooLarge: false,
      bytesWritten: chunkBytesWritten,
      error: err?.message || 'Write failed'
    };
  }
}

export function purgeStaleChunkSessions(now = Date.now()) {
  for (const [sessionId, session] of chunkSessions.entries()) {
    if (!session || now - session.updatedAt > CHUNK_SESSION_TTL_MS) {
      chunkSessions.delete(sessionId);
      safeUnlink(session?.partPath);
      if (session?.uploadId) {
        unregisterActiveUpload(session.uploadId);
      }
    }
  }
}

export async function handleChunkedUploadRequest(request, user) {
  purgeStaleChunkSessions();

  const chunkIndex = parseInt(request.headers.get('x-chunk-index') || '', 10);
  const totalChunks = parseInt(request.headers.get('x-total-chunks') || '', 10);
  const declaredTotalSize = parseInt(request.headers.get('x-total-size') || '0', 10);
  const rawSessionHeader = (request.headers.get('x-upload-session') || '').trim();
  const rawNameHeader = request.headers.get('x-file-name') || '';

  let decodedDisplayName = '';
  try {
    decodedDisplayName = decodeURIComponent(rawNameHeader);
  } catch {
    decodedDisplayName = rawNameHeader;
  }

  if (
    !Number.isInteger(chunkIndex) ||
    chunkIndex < 0 ||
    !Number.isInteger(totalChunks) ||
    totalChunks < 1 ||
    totalChunks > 64 ||
    chunkIndex >= totalChunks
  ) {
    return { ok: false, status: 400, error: 'Parámetros de fragmentación inválidos.' };
  }

  if (Number.isFinite(declaredTotalSize) && declaredTotalSize > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      status: 413,
      error: 'El archivo supera el límite máximo permitido de 50 MB.'
    };
  }

  const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_CHUNK_BYTES) {
    return {
      ok: false,
      status: 413,
      error: 'El fragmento enviado excede el tamaño máximo permitido.'
    };
  }

  const downloadsDir = getDownloadsDir();
  let session = null;
  let sessionId = rawSessionHeader;

  if (chunkIndex === 0) {
    sessionId = generateUploadSessionId();
    const uploadId = generateUploadId();
    const partPath = path.join(downloadsDir, `${uploadId}.part`);
    registerActiveUpload(uploadId);
    session = {
      sessionId,
      uploadId,
      userId: user.id,
      partPath,
      totalChunks,
      nextChunkIndex: 0,
      bytesWritten: 0,
      displayName: decodedDisplayName,
      updatedAt: Date.now()
    };
    chunkSessions.set(sessionId, session);
  } else {
    if (!UPLOAD_SESSION_REGEX.test(sessionId)) {
      return { ok: false, status: 400, error: 'Sesión de subida inválida.' };
    }
    session = chunkSessions.get(sessionId);
    if (!session) {
      return { ok: false, status: 404, error: 'La sesión de subida expiró o no existe.' };
    }
    if (session.userId !== user.id) {
      return { ok: false, status: 403, error: 'No autorizado para esta sesión de subida.' };
    }
    if (chunkIndex !== session.nextChunkIndex || totalChunks !== session.totalChunks) {
      chunkSessions.delete(sessionId);
      safeUnlink(session.partPath);
      unregisterActiveUpload(session.uploadId);
      return { ok: false, status: 400, error: 'Orden de fragmentos inválido.' };
    }
  }

  const chunkLimit = Math.min(session.bytesWritten + MAX_CHUNK_BYTES, MAX_UPLOAD_BYTES);
  const writeRes = await streamWebReadableToFile(request.body, session.partPath, {
    maxBytes: chunkLimit,
    append: chunkIndex > 0,
    initialBytes: session.bytesWritten
  });

  if (!writeRes.ok) {
    chunkSessions.delete(sessionId);
    safeUnlink(session.partPath);
    unregisterActiveUpload(session.uploadId);
    if (writeRes.tooLarge) {
      return {
        ok: false,
        status: 413,
        error: 'El archivo supera el límite máximo permitido de 50 MB.'
      };
    }
    return { ok: false, status: 400, error: 'Error al recibir los datos del archivo.' };
  }

  session.bytesWritten += writeRes.bytesWritten;
  session.nextChunkIndex = chunkIndex + 1;
  session.updatedAt = Date.now();
  if (decodedDisplayName && !session.displayName) {
    session.displayName = decodedDisplayName;
  }

  if (chunkIndex < totalChunks - 1) {
    return {
      ok: true,
      status: 200,
      partial: true,
      uploadSession: sessionId,
      receivedChunks: session.nextChunkIndex,
      totalChunks
    };
  }

  chunkSessions.delete(sessionId);
  return processUploadedTempFile({
    userId: user.id,
    tempPath: session.partPath,
    originalDisplayName: session.displayName,
    uploadId: session.uploadId
  });
}

function createBoundedBodyStream(sourceStream, maxBytes) {
  if (!sourceStream) return { stream: null, wasExceeded: () => false };
  const reader = sourceStream.getReader();
  let total = 0;
  let exceeded = false;

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        exceeded = true;
        try {
          await reader.cancel();
        } catch {}
        controller.error(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      controller.enqueue(value);
    },
    async cancel() {
      try {
        await reader.cancel();
      } catch {}
    }
  });

  return { stream, wasExceeded: () => exceeded };
}

export async function handleMultipartUploadRequest(request, user) {
  const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_UPLOAD_BYTES + MULTIPART_ENVELOPE_SLACK_BYTES
  ) {
    return {
      ok: false,
      status: 413,
      error: 'El archivo supera el límite máximo permitido de 50 MB.'
    };
  }

  const contentType = String(request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('multipart/form-data')) {
    return {
      ok: false,
      status: 400,
      error: 'Se esperaba un archivo en formato multipart/form-data.'
    };
  }

  const { stream, wasExceeded } = createBoundedBodyStream(
    request.body,
    MAX_UPLOAD_BYTES + MULTIPART_ENVELOPE_SLACK_BYTES
  );

  if (!stream) {
    return { ok: false, status: 400, error: 'No se recibió ningún archivo.' };
  }

  let formData;
  try {
    const wrappedRequest = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: stream,
      duplex: 'half'
    });
    formData = await wrappedRequest.formData();
  } catch (err) {
    if (wasExceeded() || String(err?.message || '').includes('PAYLOAD_TOO_LARGE')) {
      return {
        ok: false,
        status: 413,
        error: 'El archivo supera el límite máximo permitido de 50 MB.'
      };
    }
    return { ok: false, status: 400, error: 'Formulario de subida inválido.' };
  }

  const file = formData.get('file');
  if (!file || typeof file === 'string' || typeof file.stream !== 'function') {
    return { ok: false, status: 400, error: 'Falta el campo de archivo "file".' };
  }

  if (Number(file.size) <= 0) {
    return { ok: false, status: 400, error: 'El archivo seleccionado está vacío.' };
  }

  if (Number(file.size) > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      status: 413,
      error: 'El archivo supera el límite máximo permitido de 50 MB.'
    };
  }

  const uploadId = generateUploadId();
  const downloadsDir = getDownloadsDir();
  const tempPath = path.join(downloadsDir, `${uploadId}.raw.bin`);

  registerActiveUpload(uploadId);
  const writeRes = await streamWebReadableToFile(file.stream(), tempPath, {
    maxBytes: MAX_UPLOAD_BYTES,
    append: false,
    initialBytes: 0
  });

  if (!writeRes.ok) {
    safeUnlink(tempPath);
    unregisterActiveUpload(uploadId);
    if (writeRes.tooLarge) {
      return {
        ok: false,
        status: 413,
        error: 'El archivo supera el límite máximo permitido de 50 MB.'
      };
    }
    return { ok: false, status: 400, error: 'No se pudo almacenar temporalmente el archivo.' };
  }

  return processUploadedTempFile({
    userId: user.id,
    tempPath,
    originalDisplayName: typeof file.name === 'string' ? file.name : '',
    uploadId
  });
}

export function ensureUploadCleanupScheduler() {
  try {
    purgeExpiredUploads();
    purgeStaleChunkSessions();
  } catch {}

  if (!global.__uploadCleanupInterval) {
    const timer = setInterval(() => {
      try {
        purgeExpiredUploads();
        purgeStaleChunkSessions();
      } catch {}
    }, UPLOAD_SWEEP_INTERVAL_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    global.__uploadCleanupInterval = timer;
  }
}
