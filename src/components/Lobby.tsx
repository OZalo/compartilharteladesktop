import { useState, useEffect, useCallback } from "react";
import { generateRoomName, sanitizeRoomName, validateDisplayName, copyToClipboard, API_URL } from "../utils";

type Tab = "create" | "join";

interface RoomInfo {
  exists: boolean;
  hasPassword: boolean;
  numParticipants?: number;
}

interface LobbyProps {
  onEnter: (params: { roomName: string; displayName: string; password?: string; isCreator: boolean }) => void;
}

export default function Lobby({ onEnter }: LobbyProps) {
  const [tab, setTab] = useState<Tab>("create");

  const [displayName,   setDisplayName]   = useState("");
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState("");

  const [newRoomName,   setNewRoomName]   = useState("");
  const [roomPassword,  setRoomPassword]  = useState("");
  const [showPassword,  setShowPassword]  = useState(false);
  const [copiedLink,    setCopiedLink]    = useState(false);

  const [joinRoomName,  setJoinRoomName]  = useState("");
  const [joinPassword,  setJoinPassword]  = useState("");
  const [roomInfo,      setRoomInfo]      = useState<RoomInfo | null>(null);
  const [checkingRoom,  setCheckingRoom]  = useState(false);

  const [appVersion,    setAppVersion]    = useState("");

  useEffect(() => {
    const saved = localStorage.getItem("ss_display_name");
    if (saved) setDisplayName(saved);
    setNewRoomName(generateRoomName());
    // Versão do app e Deep Linking
    if (window.electronAPI) {
      window.electronAPI.getVersion().then(setAppVersion);
      if (window.electronAPI.onDeepLink) {
        window.electronAPI.onDeepLink((url: string) => {
          const match = url.match(/room\/([^\/\?]+)/);
          if (match && match[1]) {
            setTab("join");
            setJoinRoomName(match[1]);
            // checkRoom(match[1]); não precisa chamar direto pq o useEffect já lida se quiser, ou chamamos
          }
        });
      }
    }
  }, []);

  useEffect(() => {
    if (displayName) localStorage.setItem("ss_display_name", displayName);
  }, [displayName]);

  const checkRoom = useCallback(async (name: string) => {
    const safe = sanitizeRoomName(name);
    if (!safe || safe.length < 2) { setRoomInfo(null); return; }
    setCheckingRoom(true);
    setError("");
    try {
      const res  = await fetch(`${API_URL}/api/rooms?name=${encodeURIComponent(safe)}`);
      const data = await res.json();
      setRoomInfo(data);
    } catch {
      setRoomInfo(null);
    } finally {
      setCheckingRoom(false);
    }
  }, []);

  useEffect(() => {
    if (tab !== "join") return;
    const t = setTimeout(() => checkRoom(joinRoomName), 600);
    return () => clearTimeout(t);
  }, [joinRoomName, tab, checkRoom]);

  const handleCreate = async () => {
    setError("");
    const name = validateDisplayName(displayName);
    if (!name) { setError("Informe seu nome para continuar."); return; }
    const room = sanitizeRoomName(newRoomName);
    if (!room) { setError("Nome de sala inválido."); return; }
    setLoading(true);
    try {
      const res  = await fetch(`${API_URL}/api/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName: room, participantName: name, isCreator: true, password: roomPassword.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Erro ao criar sala."); return; }
      onEnter({ roomName: room, displayName: name, password: roomPassword.trim() || undefined, isCreator: true });
    } catch {
      setError("Não foi possível conectar ao servidor.");
    } finally {
      setLoading(false);
    }
  };

  const handleJoin = async () => {
    setError("");
    const name = validateDisplayName(displayName);
    if (!name) { setError("Informe seu nome para continuar."); return; }
    const room = sanitizeRoomName(joinRoomName);
    if (!room) { setError("Nome de sala inválido."); return; }
    setLoading(true);
    try {
      const res  = await fetch(`${API_URL}/api/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName: room, participantName: name, isCreator: false, password: joinPassword.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Erro ao entrar na sala."); return; }
      onEnter({ roomName: room, displayName: name, password: joinPassword.trim() || undefined, isCreator: false });
    } catch {
      setError("Não foi possível conectar ao servidor.");
    } finally {
      setLoading(false);
    }
  };

  const handleCopyLink = async () => {
    const room = sanitizeRoomName(newRoomName);
    if (!room) return;
    const url = `${API_URL}?sala=${encodeURIComponent(room)}`;
    const textToCopy = `${room}\n${url}`;
    await copyToClipboard(textToCopy);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2500);
  };

  const onKey = (e: React.KeyboardEvent, action: () => void) => {
    if (e.key === "Enter") action();
  };

  const RoomStatusBadge = () => {
    if (!joinRoomName || joinRoomName.length < 2) return null;
    if (checkingRoom) return (
      <span className="room-status room-status--checking">
        <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
        Verificando...
      </span>
    );
    if (!roomInfo) return null;
    if (!roomInfo.exists) return <span className="room-status room-status--notfound">Sala não encontrada</span>;
    return (
      <span className={`room-status ${roomInfo.hasPassword ? "room-status--locked" : "room-status--open"}`}>
        {roomInfo.hasPassword
          ? <><LockIcon /> Com senha</>
          : <><UnlockIcon /> Aberta{roomInfo.numParticipants ? ` · ${roomInfo.numParticipants} online` : ""}</>
        }
      </span>
    );
  };

  return (
    <main className="lobby-page">
      <div className="lobby-wrap">
        {/* Logo */}
        <div className="lobby-logo animate-fade-in-up">
          <div className="lobby-logo-icon">
            <MonitorIcon size={22} />
          </div>
          <div className="lobby-logo-text-wrap">
            <span className="lobby-logo-text">Compartilhar Tela</span>
            <span className="desktop-badge">Desktop</span>
          </div>
        </div>

        {/* Card */}
        <div className="glass-card lobby-card animate-fade-in-up anim-delay-100">
          {/* Tabs */}
          <div className="lobby-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === "create"}
              className={`lobby-tab ${tab === "create" ? "lobby-tab--active" : ""}`}
              onClick={() => { setTab("create"); setError(""); }}
            >
              <PlusIcon /> Criar Sala
            </button>
            <button
              role="tab"
              aria-selected={tab === "join"}
              className={`lobby-tab ${tab === "join" ? "lobby-tab--active" : ""}`}
              onClick={() => { setTab("join"); setError(""); }}
            >
              <EnterIcon /> Entrar
            </button>
          </div>

          <div className="lobby-fields">
            {/* Nome */}
            <div className="field">
              <label className="field-label" htmlFor="display-name">Seu nome</label>
              <div className="field-wrap">
                <UserIcon />
                <input
                  id="display-name"
                  type="text"
                  className="input field-input"
                  value={displayName}
                  maxLength={30}
                  onChange={e => setDisplayName(e.target.value)}
                  onKeyDown={e => onKey(e, tab === "create" ? handleCreate : handleJoin)}
                />
              </div>
            </div>

            {/* ── CRIAR ── */}
            {tab === "create" && (
              <>
                <div className="field animate-fade-in">
                  <label className="field-label" htmlFor="room-name">
                    Nome da sala
                    <span className="field-hint">Gerado automaticamente</span>
                  </label>
                  <div className="field-row">
                    <div className="field-wrap" style={{ flex: 1 }}>
                      <MonitorIcon />
                      <input
                        id="room-name"
                        type="text"
                        className="input field-input"
                        placeholder="nome-da-sala"
                        value={newRoomName}
                        onChange={e => setNewRoomName(e.target.value)}
                        onKeyDown={e => onKey(e, handleCreate)}
                      />
                    </div>
                    <button className="btn btn-ghost btn-icon" onClick={() => setNewRoomName(generateRoomName())} title="Gerar novo nome">
                      <RefreshIcon />
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={handleCopyLink}>
                      {copiedLink ? <><CheckIcon /> Copiado!</> : <><LinkIcon /> Copiar Link</>}
                    </button>
                  </div>
                </div>

                <div className="field animate-fade-in">
                  <button
                    type="button"
                    className="password-toggle"
                    onClick={() => { setShowPassword(v => !v); if (showPassword) setRoomPassword(""); }}
                  >
                    {showPassword ? <LockIcon /> : <UnlockIcon />}
                    {showPassword ? "Remover senha da sala" : "Adicionar senha à sala"}
                    <ChevronIcon style={{ marginLeft: "auto", transform: showPassword ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
                  </button>
                  {showPassword && (
                    <div className="field-wrap animate-fade-in-up" style={{ marginTop: 8 }}>
                      <LockIcon />
                      <input
                        id="room-password"
                        type="password"
                        className="input field-input"
                        placeholder="Senha da sala"
                        value={roomPassword}
                        onChange={e => setRoomPassword(e.target.value)}
                        onKeyDown={e => onKey(e, handleCreate)}
                        autoFocus
                      />
                    </div>
                  )}
                </div>
              </>
            )}

            {/* ── ENTRAR ── */}
            {tab === "join" && (
              <>
                <div className="field animate-fade-in">
                  <div className="field-label-row">
                    <label className="field-label" htmlFor="join-room-name">Nome da sala</label>
                    <RoomStatusBadge />
                  </div>
                  <div className="field-wrap">
                    <MonitorIcon />
                    <input
                      id="join-room-name"
                      type="text"
                      className="input field-input"
                      placeholder="nome-da-sala"
                      value={joinRoomName}
                      onChange={e => setJoinRoomName(e.target.value)}
                      onKeyDown={e => onKey(e, handleJoin)}
                    />
                  </div>
                </div>

                {roomInfo?.hasPassword && (
                  <div className="field animate-fade-in-up">
                    <label className="field-label" htmlFor="join-password">
                      Senha da sala
                      <span className="field-hint"><LockIcon size={11} /> Esta sala requer senha</span>
                    </label>
                    <div className="field-wrap">
                      <LockIcon />
                      <input
                        id="join-password"
                        type="password"
                        className="input field-input"
                        placeholder="Digite a senha"
                        value={joinPassword}
                        onChange={e => setJoinPassword(e.target.value)}
                        onKeyDown={e => onKey(e, handleJoin)}
                        autoFocus
                      />
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Error */}
            {error && (
              <div className="lobby-error animate-scale-in" role="alert">
                <AlertIcon /> {error}
              </div>
            )}

            {/* CTA */}
            {tab === "create" ? (
              <button
                className="btn btn-primary btn-lg lobby-cta"
                onClick={handleCreate}
                disabled={loading || !displayName.trim()}
              >
                {loading ? <><span className="spinner" /> Criando...</> : <><MonitorIcon size={17} /> Criar e Entrar</>}
              </button>
            ) : (
              <button
                className="btn btn-primary btn-lg lobby-cta"
                onClick={handleJoin}
                disabled={loading || !displayName.trim() || checkingRoom}
              >
                {loading ? <><span className="spinner" /> Entrando...</> : <><EnterIcon size={17} /> Entrar na Sala</>}
              </button>
            )}
          </div>
        </div>

        {appVersion && (
          <p style={{ textAlign: "center", fontSize: "0.72rem", color: "var(--color-text-muted)" }}>
            Compartilhar Tela Desktop v{appVersion} · criado por{" "}
            <span
              style={{ color: "var(--color-text-secondary)", textDecoration: "underline", cursor: "pointer" }}
              onClick={() => window.electronAPI?.openExternal("https://github.com/OZalo")}
            >
              Zalo
            </span>
          </p>
        )}
      </div>

      <style>{lobbyStyles}</style>
    </main>
  );
}

// ─── Icons ───────────────────────────────────────────────────────────────────
function MonitorIcon({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>;
}
function UserIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>;
}
function LockIcon({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>;
}
function UnlockIcon({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11V7a5 5 0 0 1 9.9-1"/><rect x="3" y="11" width="18" height="11" rx="2"/></svg>;
}
function PlusIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
}
function EnterIcon({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>;
}
function RefreshIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>;
}
function LinkIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>;
}
function CheckIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>;
}
function AlertIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>;
}
function ChevronIcon(p: React.SVGProps<SVGSVGElement>) {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" {...p}><polyline points="6 9 12 15 18 9"/></svg>;
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const lobbyStyles = `
  .lobby-page {
    height: 100%; display: flex; align-items: center; justify-content: center;
    padding: 24px; position: relative; overflow-y: auto;
  }
  .lobby-wrap {
    width: 100%; max-width: 430px; display: flex; flex-direction: column;
    gap: 20px; position: relative; z-index: 1;
  }
  .lobby-logo { display: flex; align-items: center; gap: 10px; justify-content: center; }
  .lobby-logo-icon {
    width: 38px; height: 38px; background: var(--color-accent); border-radius: 10px;
    display: flex; align-items: center; justify-content: center; color: #fff;
    box-shadow: 0 0 20px var(--color-accent-glow);
  }
  .lobby-logo-text { font-size: 1.25rem; font-weight: 800; color: var(--color-text-primary); letter-spacing: -0.03em; }
  .lobby-logo-text-wrap { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; justify-content: center; }
  .desktop-badge {
    font-size: 0.68rem; font-weight: 700; letter-spacing: 0.08em;
    background: var(--color-accent-dim); color: var(--color-accent);
    border: 1px solid rgba(0,212,184,0.3); border-radius: var(--radius-full);
    padding: 2px 8px; text-transform: uppercase;
  }
  .lobby-card { padding: 28px; display: flex; flex-direction: column; gap: 24px; }
  .lobby-tabs {
    display: grid; grid-template-columns: 1fr 1fr; gap: 5px;
    background: rgba(0,0,0,0.3); border-radius: calc(var(--radius-md) + 2px);
    padding: 5px; border: 1px solid rgba(255,255,255,0.05);
  }
  .lobby-tab {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    padding: 10px; border-radius: var(--radius-md); border: 1px solid transparent;
    background: transparent; color: var(--color-text-muted);
    font-size: 0.88rem; font-weight: 600; cursor: pointer;
    transition: all var(--duration-normal) var(--ease-out);
  }
  .lobby-tab:hover { color: var(--color-text-primary); }
  .lobby-tab--active {
    background: rgba(255,255,255,0.06); color: var(--color-text-primary);
    border-color: rgba(255,255,255,0.1); box-shadow: 0 2px 10px rgba(0,0,0,0.4);
  }
  .lobby-fields { display: flex; flex-direction: column; gap: 18px; }
  .field { display: flex; flex-direction: column; gap: 7px; }
  .field-label {
    font-size: 0.85rem; font-weight: 500; color: var(--color-text-secondary);
    display: flex; align-items: center; justify-content: space-between;
  }
  .field-hint { font-weight: 400; color: var(--color-text-muted); font-size: 0.78rem; display: flex; align-items: center; gap: 4px; }
  .field-label-row { display: flex; align-items: center; justify-content: space-between; }
  .field-wrap { position: relative; }
  .field-wrap > svg:first-child {
    position: absolute; left: 14px; top: 50%; transform: translateY(-50%);
    color: var(--color-text-muted); pointer-events: none; width: 15px; height: 15px;
  }
  .field-input { padding-left: 42px !important; }
  .field-row { display: flex; gap: 8px; align-items: center; }
  .password-toggle {
    display: flex; align-items: center; gap: 9px;
    background: rgba(0,0,0,0.2); border: 1px dashed var(--color-border);
    border-radius: var(--radius-sm); color: var(--color-text-muted);
    font-size: 0.83rem; font-weight: 500; padding: 11px 14px; cursor: pointer;
    transition: all var(--duration-fast); width: 100%; text-align: left; font-family: var(--font-sans);
  }
  .password-toggle:hover { border-color: var(--color-border-focus); color: var(--color-accent); background: var(--color-accent-dim); }
  .room-status {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 0.78rem; font-weight: 500; padding: 3px 10px;
    border-radius: var(--radius-full); border: 1px solid var(--color-border);
  }
  .room-status--checking { color: var(--color-text-muted); }
  .room-status--notfound { color: var(--color-danger); border-color: rgba(248,113,113,0.3); background: rgba(248,113,113,0.05); }
  .room-status--open { color: var(--color-success); border-color: rgba(52,211,153,0.3); background: rgba(52,211,153,0.05); }
  .room-status--locked { color: var(--color-text-primary); background: rgba(255,255,255,0.05); }
  .lobby-error {
    display: flex; align-items: center; gap: 8px; padding: 11px 14px;
    border: 1px solid rgba(248,113,113,0.3); background: rgba(248,113,113,0.05);
    border-radius: var(--radius-sm); color: var(--color-danger); font-size: 0.88rem; font-weight: 500;
  }
  .lobby-cta { width: 100%; margin-top: 4px; }
`;
