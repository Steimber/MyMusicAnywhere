import fs from 'fs';
import path from 'path';
import { test, expect } from '@playwright/test';

const TEST_USER = process.env.E2E_TEST_USERNAME || 'e2e_user';
const TEST_PASS = process.env.E2E_TEST_PASSWORD || 'e2e_pass_123';
const DATA_DIR = process.env.E2E_DATA_DIR || '';
const DOWNLOADS_DIR = process.env.E2E_DOWNLOADS_DIR || '';
const YTDLP_LOG_PATH = process.env.E2E_YTDLP_LOG_PATH || '';

function createValidPcmWavBuffer(durationSec = 1, sampleRate = 8000) {
  const numSamples = durationSec * sampleRate;
  const dataBytes = numSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // Mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000);
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}

test('E2E offline suite: auth, empty Para ti, search & simulated download, playback, own upload cleanup, playlist & favorite', async ({
  page,
  context
}) => {
  // Block any accidental external network calls from the browser as well
  await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/i, async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ resultCount: 0, results: [] })
    });
  });

  // Verify temporary directories are isolated from real project directories
  expect(DATA_DIR).toBeTruthy();
  expect(DOWNLOADS_DIR).toBeTruthy();
  expect(path.resolve(DATA_DIR)).not.toBe(path.resolve(process.cwd(), 'data'));
  expect(path.resolve(DOWNLOADS_DIR)).not.toBe(path.resolve(process.cwd(), 'downloads'));

  // 1. Login incorrecto y correcto
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();

  await page.locator('#signin-username').fill(TEST_USER);
  await page.locator('#current-password').fill('wrong_password_999');
  await page.getByRole('button', { name: /Entrar a mineral music/i }).click();
  await expect(page.locator('.alert.err')).toContainText(/incorrectos/i);

  await page.locator('#current-password').fill(TEST_PASS);
  await page.getByRole('button', { name: /Entrar a mineral music/i }).click();

  const mainNav = page.getByRole('navigation', { name: 'Principal' });
  await expect(mainNav).toBeVisible();

  // 6. Abrir "Para ti" con historial vacío (0 reproducciones)
  await mainNav.getByRole('button', { name: 'Para ti' }).click();
  await expect(page.locator('#foryou-heading')).toHaveText('Para ti');
  await expect(page.locator('.foryou-notice-text')).toContainText(
    'Escucha un poco más y tus playlists irán apareciendo'
  );
  await expect(page.locator('.foryou-notice-meta')).toContainText('0 / 20 reproducciones');
  await expect(page.locator('.foryou-card-title', { hasText: 'Descubre' })).toBeVisible();

  // 2. Buscar y pedir una descarga (usando yt-dlp y SoundCloud simulados sin red)
  await mainNav.getByRole('button', { name: 'Explorar' }).click();
  const searchInput = page.locator('.search-input').first();
  await searchInput.fill('Aurora Borealis');
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();

  const targetRow = page.locator('.track-row', { hasText: 'Aurora Borealis' }).first();
  await expect(targetRow).toBeVisible();

  await targetRow
    .getByRole('button', { name: 'Descargar para escuchar sin internet' })
    .click();

  await expect(
    targetRow.getByRole('button', { name: 'Opciones de pista offline' })
  ).toBeVisible({ timeout: 25000 });

  if (YTDLP_LOG_PATH) {
    const logLines = fs
      .readFileSync(YTDLP_LOG_PATH, 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(l => JSON.parse(l));
    expect(logLines.some(e => e.mode === 'flat-playlist')).toBe(true);
    expect(logLines.some(e => e.mode === 'download')).toBe(true);
  }

  // 3. Reproducir una canción
  await targetRow.locator('.track-row-main').click();
  const playerDock = page.locator('.player-dock');
  await expect(playerDock).toBeVisible();
  await expect(playerDock.locator('.player-track-title')).toHaveText('Aurora Borealis');

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const audio = document.querySelector('audio');
          if (!audio) return { ok: false };
          return {
            ok:
              Boolean(audio.src) &&
              audio.readyState >= 2 &&
              (!audio.paused || audio.currentTime > 0),
            src: audio.src,
            currentTime: audio.currentTime
          };
        }),
      { timeout: 15000 }
    )
    .toMatchObject({ ok: true });

  // Pause so we don't cross 30s if tests run slowly
  await playerDock.getByRole('button', { name: 'Pausar' }).click();

  // 5 (parte A). Marcar un favorito desde la pista
  await targetRow.getByRole('button', { name: 'Guardar en Favoritos' }).click();
  await expect(
    targetRow.getByRole('button', { name: 'Quitar de Favoritos' })
  ).toBeVisible();

  // 4. Subir un audio propio y comprobar que se borra del servidor tras guardarse en el dispositivo
  const wavBuffer = createValidPcmWavBuffer(1, 8000);
  await page.locator('#upload-own-music-exp').setInputFiles({
    name: 'Mi Demo Propia - Artista Local.wav',
    mimeType: 'audio/wav',
    buffer: wavBuffer
  });

  await expect(page.locator('.own-upload-status-text')).toContainText(
    'Canción guardada en tu biblioteca y en el teléfono',
    { timeout: 25000 }
  );

  // Confirmar en disco que el archivo upl_*.m4a fue eliminado de DOWNLOADS_DIR y marcado fileDeleted en store.json
  await expect
    .poll(() => {
      const remainingUploads = fs
        .readdirSync(DOWNLOADS_DIR)
        .filter(f => /^upl_[a-f0-9]{32}\.m4a$/i.test(f));
      const storeRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'store.json'), 'utf8'));
      const ownRec = (storeRaw.uploads || [])[0];
      return {
        remainingCount: remainingUploads.length,
        hasRecord: Boolean(ownRec),
        fileDeleted: Boolean(ownRec?.fileDeleted)
      };
    })
    .toEqual({
      remainingCount: 0,
      hasRecord: true,
      fileDeleted: true
    });

  // 5 (parte B). Verificar favorito en Biblioteca y crear una playlist nueva
  await mainNav.getByRole('button', { name: /Biblioteca/i }).click();
  const libSwitcher = page.getByRole('tablist', { name: 'Tus librerías' });
  await libSwitcher.getByRole('button', { name: /Favoritos/i }).click();
  await expect(page.locator('.track-row', { hasText: 'Aurora Borealis' }).first()).toBeVisible();

  await libSwitcher.getByRole('button', { name: /Nueva/i }).click();
  await page
    .getByPlaceholder(/Nombre de la librería/i)
    .fill('Mi Mix E2E');
  await page.getByRole('button', { name: 'Crear', exact: true }).click();

  await expect(libSwitcher.getByRole('button', { name: /Mi Mix E2E/i })).toBeVisible();
  await expect(page.locator('.playlist-header-title')).toHaveText('Mi Mix E2E');

  // Re-verificar "Para ti" con historial vacío pero con pistas guardadas ("Descubre" + "Joyas sin escuchar")
  await mainNav.getByRole('button', { name: 'Para ti' }).click();
  await expect(page.locator('.foryou-notice-meta')).toContainText('0 / 20 reproducciones');
  await expect(page.locator('.foryou-card-title', { hasText: 'Descubre' })).toBeVisible();
  await expect(page.locator('.foryou-card-title', { hasText: 'Joyas sin escuchar' })).toBeVisible();
});
