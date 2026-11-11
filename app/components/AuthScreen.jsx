'use client';

import { BrandMark, Icon } from './Icons';

export default function AuthScreen({
  authChecked,
  authMode,
  setAuthMode,
  authError,
  setAuthError,
  isOffline,
  username,
  setUsername,
  password,
  setPassword,
  inviteCode,
  setInviteCode,
  showPassword,
  setShowPassword,
  authBusy,
  onSubmit,
  offlineCount,
  onEnterOfflineMode
}) {
  if (!authChecked) {
    return (
      <main className="app-shell">
        <div className="empty" style={{ marginTop: 48 }}>
          <div className="empty-title">mineral music</div>
          <div>Abriendo tu biblioteca…</div>
        </div>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <BrandMark />
          <span className="brand-word">
            mineral<small className="brand-sub">music</small>
          </span>
        </div>
        <span className="badge lavender">Por invitación</span>
      </header>

      <div className="auth-wrap">
        <div style={{ marginBottom: 16 }}>
          <h1 className="section-bar-title" style={{ fontSize: '1.65rem' }}>
            {authMode === 'login' ? 'Iniciar sesión' : 'Activar invitación'}
          </h1>
          <p className="section-bar-sub">
            {authMode === 'login'
              ? 'Tu música, librerías y descargas offline en cualquier dispositivo.'
              : 'Creá tu cuenta con un código de invitación.'}
          </p>
        </div>

        <div className="card">
          <div className="auth-tabs" role="tablist">
            <button
              type="button"
              className={authMode === 'login' ? 'active' : ''}
              onClick={() => {
                setAuthMode('login');
                setAuthError('');
              }}
            >
              Entrar
            </button>
            <button
              type="button"
              className={authMode === 'register' ? 'active' : ''}
              onClick={() => {
                setAuthMode('register');
                setAuthError('');
              }}
            >
              Código de invitación
            </button>
          </div>

          {authError && <div className="alert err">{authError}</div>}

          <div className={isOffline ? 'offline-section-disabled' : ''}>
            {authMode === 'login' ? (
              <form className="form" onSubmit={onSubmit}>
                <div className="field">
                  <label htmlFor="signin-username">Usuario</label>
                  <input
                    id="signin-username"
                    name="username"
                    type="text"
                    autoComplete="username"
                    enterKeyHint="next"
                    required
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    placeholder="tu_usuario"
                  />
                </div>

                <div className="field">
                  <label htmlFor="current-password">Contraseña</label>
                  <div className="input-row">
                    <input
                      id="current-password"
                      name="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      enterKeyHint="done"
                      required
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="••••••••"
                    />
                    <button
                      type="button"
                      className="btn secondary sm"
                      onClick={() => setShowPassword(v => !v)}
                    >
                      {showPassword ? 'Ocultar' : 'Ver'}
                    </button>
                  </div>
                </div>

                <button type="submit" className="btn" disabled={authBusy || isOffline}>
                  {authBusy ? 'Entrando…' : 'Entrar a mineral music'}
                </button>
              </form>
            ) : (
              <form className="form" onSubmit={onSubmit}>
                <div className="field">
                  <label htmlFor="invite-code">Código de invitación</label>
                  <input
                    id="invite-code"
                    name="inviteCode"
                    type="text"
                    autoCapitalize="characters"
                    enterKeyHint="next"
                    required
                    value={inviteCode}
                    onChange={e => setInviteCode(e.target.value.toUpperCase())}
                    placeholder="MMA-XXXX-XXXX"
                  />
                </div>

                <div className="field">
                  <label htmlFor="signup-username">Usuario</label>
                  <input
                    id="signup-username"
                    name="username"
                    type="text"
                    autoComplete="username"
                    enterKeyHint="next"
                    minLength={3}
                    maxLength={32}
                    required
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    placeholder="nuevo_usuario"
                  />
                </div>

                <div className="field">
                  <label htmlFor="new-password">Contraseña (mín. 6 caracteres)</label>
                  <div className="input-row">
                    <input
                      id="new-password"
                      name="new-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      enterKeyHint="done"
                      minLength={6}
                      required
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="••••••••"
                    />
                    <button
                      type="button"
                      className="btn secondary sm"
                      onClick={() => setShowPassword(v => !v)}
                    >
                      {showPassword ? 'Ocultar' : 'Ver'}
                    </button>
                  </div>
                </div>

                <button type="submit" className="btn" disabled={authBusy || isOffline}>
                  {authBusy ? 'Activando…' : 'Crear cuenta'}
                </button>
              </form>
            )}
          </div>

          {offlineCount > 0 && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <button
                type="button"
                className="btn secondary"
                style={{ width: '100%' }}
                onClick={onEnterOfflineMode}
              >
                <Icon name="headphones" size={16} /> Escuchar mis canciones Offline ({offlineCount})
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
