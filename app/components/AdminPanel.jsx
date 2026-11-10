'use client';

export default function AdminPanel({
  isOffline,
  adminData,
  adminMsg,
  inviteLabel,
  setInviteLabel,
  inviteMaxUses,
  setInviteMaxUses,
  copiedCode,
  onCreateInvite,
  onCopyInviteCode,
  onAdminAction,
  Icon
}) {
  const users = Array.isArray(adminData?.users) ? adminData.users : [];
  const invites = Array.isArray(adminData?.invites) ? adminData.invites : [];
  const storage = adminData?.storage || null;

  return (
    <section className={isOffline ? 'offline-section-disabled' : ''}>
      <div className="section-bar">
        <div>
          <h1 className="section-bar-title">Administración</h1>
          <p className="section-bar-sub">
            Códigos de invitación, usuarios y estado del servidor.
          </p>
        </div>
      </div>

      <div className="grid three" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="stat-label">Usuarios</div>
          <div className="stat-value tabular-nums">{users.length}</div>
          <div className="stat-hint tabular-nums">
            {users.filter(u => u.active).length} activos
          </div>
        </div>

        <div className="stat">
          <div className="stat-label">Invitaciones</div>
          <div className="stat-value tabular-nums">
            {invites.filter(i => !i.revoked && i.used_count < i.max_uses).length}
          </div>
          <div className="stat-hint">Disponibles</div>
        </div>

        <div className="stat full-mobile">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap'
            }}
          >
            <div>
              <div className="stat-label">Disco VPS (Puente temporal)</div>
              <div className="stat-value tabular-nums">
                {storage ? `${storage.usedMB} / ${storage.maxMB} MB` : '—'}
              </div>
            </div>
            <div className="stat-hint tabular-nums" style={{ fontWeight: 700 }}>
              {storage ? `${storage.fileCount} archivos en cola` : 'Calculando…'}
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="track-title" style={{ fontSize: '1rem', marginBottom: 10 }}>
          Crear código de invitación
        </div>
        {adminMsg && <div className="alert ok">{adminMsg}</div>}
        <form className="form" onSubmit={onCreateInvite}>
          <div className="grid two">
            <div className="field">
              <label htmlFor="invite-label">Etiqueta</label>
              <input
                id="invite-label"
                name="label"
                type="text"
                placeholder="Ej. Amigos, Móvil…"
                value={inviteLabel}
                onChange={e => setInviteLabel(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="invite-uses">Usos permitidos</label>
              <input
                id="invite-uses"
                name="maxUses"
                type="number"
                min={1}
                max={100}
                value={inviteMaxUses}
                onChange={e => setInviteMaxUses(e.target.value)}
              />
            </div>
          </div>
          <div>
            <button type="submit" className="btn sm">
              <Icon name="plus" size={14} /> Generar código
            </button>
          </div>
        </form>
      </div>

      <div className="track-list" style={{ marginBottom: 16 }}>
        {invites.map(inv => {
          const exhausted = inv.used_count >= inv.max_uses;
          return (
            <div key={inv.code} className="track-row">
              <div className="track-text">
                <div className="track-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="code-pill">{inv.code}</span>
                  <span>{inv.label}</span>
                </div>
                <div className="track-sub tabular-nums">
                  Usos: {inv.used_count}/{inv.max_uses} ·{' '}
                  {inv.revoked ? 'Revocado' : exhausted ? 'Agotado' : 'Activo'}
                </div>
              </div>
              <div className="track-actions">
                <button
                  type="button"
                  className="btn secondary sm"
                  onClick={() => onCopyInviteCode(inv.code)}
                >
                  {copiedCode === inv.code ? 'Copiado' : 'Copiar'}
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => onAdminAction({ action: 'delete_invite', code: inv.code })}
                  aria-label={`Eliminar invitación ${inv.code}`}
                  title="Eliminar invitación"
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
