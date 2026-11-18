import { useState, useEffect, useCallback, useRef } from "react";
import {
  generateRoomName,
  sanitizeRoomName,
  toRoomSlug,
  validateDisplayName,
  copyToClipboard,
  hashPassword,
  extractRoomFromText,
  API_URL,
} from "../utils";
import { roomRegistry, type ActiveRoom } from "../roomRegistry";
import GamepadConfigModal from "./GamepadConfigModal";

type Tab = "create" | "join";

interface RoomInfo {
  exists: boolean;
  hasPassword: boolean;
  passwordHash?: string;
  numParticipants?: number;
}

interface LobbyProps {
  onEnter: (params: { roomName: string; displayName: string; password?: string; isCreator: boolean }) => void;
}

export default function Lobby({ onEnter }: LobbyProps) {
  const [tab, setTab] = useState<Tab>("create");

  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [newRoomName, setNewRoomName] = useState("");
  const [roomPassword, setRoomPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const [joinRoomName, setJoinRoomName] = useState("");
  const [joinPassword, setJoinPassword] = useState("");
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [checkingRoom, setCheckingRoom] = useState(false);

  // Lista de salas abertas na esquerda + gaveta de senha
  const [activeRooms, setActiveRooms] = useState<ActiveRoom[]>([]);
  const [expandedRoomSlug, setExpandedRoomSlug] = useState<string | null>(null);
  const [drawerPassword, setDrawerPassword] = useState("");
  const [drawerError, setDrawerError] = useState("");

  const [showGamepadModal, setShowGamepadModal] = useState(false);

  const [appVersion, setAppVersion] = useState("");
  const [isUpdating, setIsUpdating] = useState(false);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const lastConsumedClipboardRef = useRef<string>("");

  // Inscreve no serviço de descoberta de salas (tempo real P2P + refresh de 5s)
  useEffect(() => {
    const unsubscribe = roomRegistry.subscribe((rooms) => {
      setActiveRooms(rooms);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem("ss_display_name");
    if (saved) setDisplayName(saved);
    setNewRoomName(generateRoomName());

    if (window.electronAPI) {
      window.electronAPI.getVersion().then(setAppVersion);
      if (window.electronAPI.onDeepLink) {
        window.electronAPI.onDeepLink((url: string) => {
          const match = url.match(/room\/([^/?#]+)/);
          if (match && match[1]) {
            const room = sanitizeRoomName(decodeURIComponent(match[1]));
            const savedName = validateDisplayName(localStorage.getItem("ss_display_name") || displayName);
            if (room && savedName) {
              onEnter({ roomName: room, displayName: savedName, isCreator: false });
            } else if (room) {
              setTab("join");
              setJoinRoomName(room);
            }
          }
        });
      }
      if (window.electronAPI.onUpdateAvailable) {
        window.electronAPI.onUpdateAvailable(() => setIsUpdating(true));
      }
      if (window.electronAPI.onUpdateProgress) {
        window.electronAPI.onUpdateProgress(() => setIsUpdating(true));
      }
      if (window.electronAPI.onUpdateError) {
        window.electronAPI.onUpdateError(() => setIsUpdating(false));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Detecta se o usuário copiou um link de sala no Discord/WhatsApp ao focar a janela (opcional sem abrir navegador)
  useEffect(() => {
    const checkClipboardForRoomLink = async () => {
      try {
        const text = await window.electronAPI?.readClipboard?.();
        if (!text || text === lastConsumedClipboardRef.current) return;
        const detectedRoom = extractRoomFromText(text);
        if (detectedRoom) {
          lastConsumedClipboardRef.current = text;
          setJoinRoomName(detectedRoom);
        }
      } catch {}
    };
    window.addEventListener("focus", checkClipboardForRoomLink);
    return () => window.removeEventListener("focus", checkClipboardForRoomLink);
  }, []);

  useEffect(() => {
    if (displayName) localStorage.setItem("ss_display_name", displayName);
  }, [displayName]);

  const checkRoom = useCallback(async (name: string) => {
    const safe = sanitizeRoomName(name);
    const slug = toRoomSlug(safe);
    if (!safe || safe.length < 2) {
      setRoomInfo(null);
      return;
    }

    // Checa primeiro na lista P2P local instantânea
    const localMatch = roomRegistry.getRooms().find((r) => r.slug === slug);
    if (localMatch) {
      setRoomInfo({
        exists: true,
        hasPassword: localMatch.hasPassword,
        passwordHash: localMatch.passwordHash,
        numParticipants: localMatch.numParticipants,
      });
      return;
    }

    setCheckingRoom(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/api/rooms?name=${encodeURIComponent(slug)}`);
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
    const t = setTimeout(() => checkRoom(joinRoomName), 400);
    return () => clearTimeout(t);
  }, [joinRoomName, tab, checkRoom]);

  const requireDisplayName = (): string | null => {
    const name = validateDisplayName(displayName);
    if (!name) {
      setError("Informe seu nome primeiro para entrar.");
      nameInputRef.current?.focus();
      return null;
    }
    return name;
  };

  const handleCreate = async () => {
    setError("");
    const name = requireDisplayName();
    if (!name) return;
    const room = sanitizeRoomName(newRoomName);
    if (!room) {
      setError("Nome de sala inválido.");
      return;
    }

    onEnter({
      roomName: room,
      displayName: name,
      password: roomPassword.trim() || undefined,
      isCreator: true,
    });
  };

  const handleJoin = async () => {
    setError("");
    const name = requireDisplayName();
    if (!name) return;
    const room = sanitizeRoomName(joinRoomName);
    if (!room) {
      setError("Nome de sala inválido.");
      return;
    }

    const slug = toRoomSlug(room);
    const targetRoom = activeRooms.find((r) => r.slug === slug) || roomInfo;
    if (targetRoom?.hasPassword) {
      if (!joinPassword.trim()) {
        setError("Esta sala requer senha.");
        return;
      }
      if (targetRoom.passwordHash && hashPassword(joinPassword) !== targetRoom.passwordHash) {
        setError("Senha incorreta.");
        return;
      }
    }

    onEnter({
      roomName: room,
      displayName: name,
      password: joinPassword.trim() || undefined,
      isCreator: false,
    });
  };

  // Botão "Copiar Link": já copia o convite e abre/entra na sala imediatamente!
  const handleCopyLinkAndOpen = async () => {
    setError("");
    const room = sanitizeRoomName(newRoomName);
    if (!room) {
      setError("Nome de sala inválido.");
      return;
    }
    const slug = toRoomSlug(room);
    const url = `${API_URL}?sala=${encodeURIComponent(slug)}`;
    const textToCopy = `${room}\n${url}`;
    await copyToClipboard(textToCopy);
    lastConsumedClipboardRef.current = textToCopy;
    setCopiedLink(true);

    const name = validateDisplayName(displayName);
    if (name) {
      // Já entra direto na sala após copiar o link
      onEnter({
        roomName: room,
        displayName: name,
        password: roomPassword.trim() || undefined,
        isCreator: true,
      });
    } else {
      setError("Link copiado! Digite seu nome para abrir a sala.");
      nameInputRef.current?.focus();
      setTimeout(() => setCopiedLink(false), 2500);
    }
  };

  // Clicar numa sala da lista lateral esquerda
  const handleRoomCardClick = (room: ActiveRoom) => {
    setError("");
    setDrawerError("");

    if (!room.hasPassword) {
      const name = requireDisplayName();
      if (!name) return;
      onEnter({
        roomName: room.name,
        displayName: name,
        isCreator: false,
      });
      return;
    }

    // Sala com senha: abre/fecha a gaveta inline embaixo da sala clicada
    if (expandedRoomSlug === room.slug) {
      setExpandedRoomSlug(null);
      setDrawerPassword("");
      setDrawerError("");
    } else {
      setExpandedRoomSlug(room.slug);
      setDrawerPassword("");
      setDrawerError("");
    }
  };

  const handleDrawerPasswordSubmit = (room: ActiveRoom) => {
    setDrawerError("");
    const name = requireDisplayName();
    if (!name) return;

    if (!drawerPassword.trim()) {
      setDrawerError("Digite a senha.");
      return;
    }

    if (room.passwordHash && hashPassword(drawerPassword) !== room.passwordHash) {
      setDrawerError("Senha incorreta.");
      return;
    }

    onEnter({
      roomName: room.name,
      displayName: name,
      password: drawerPassword.trim(),
      isCreator: false,
    });
  };

  const onKey = (e: React.KeyboardEvent, action: () => void) => {
    if (e.key === "Enter") action();
  };

  const RoomStatusBadge = () => {
    if (!joinRoomName || joinRoomName.length < 2) return null;
    if (checkingRoom)
      return (
        <span className="room-status room-status--checking">
          <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
          Verificando...
        </span>
      );
    if (!roomInfo) return null;
    if (!roomInfo.exists) return <span className="room-status room-status--notfound">Sala não encontrada</span>;
    return (
      <span className={`room-status ${roomInfo.hasPassword ? "room-status--locked" : "room-status--open"}`}>
        {roomInfo.hasPassword ? (
          <>
            <LockIcon /> Com senha
          </>
        ) : (
          <>
            <UnlockIcon /> Aberta{roomInfo.numParticipants ? ` · ${roomInfo.numParticipants} online` : ""}
          </>
        )}
      </span>
    );
  };

  return (
    <main className="lobby-page">
      <div className="lobby-shell">
        {/* Logo no topo */}
        <div className="lobby-logo animate-fade-in-up" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="lobby-logo-icon">
              <MonitorIcon size={22} />
            </div>
            <div className="lobby-logo-text-wrap">
              <span className="lobby-logo-text">Compartilhar Tela</span>
              <span className="desktop-badge">Desktop</span>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setShowGamepadModal(true)}
            title="Configurar Controle USB / Bluetooth (Coop Remoto)"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "0.82rem" }}
          >
            <GamepadIcon size={15} /> Configurar Controle
          </button>
        </div>

        {/* Layout 2 colunas: Salas Abertas (Esquerda) + Criar/Entrar (Direita) */}
        <div className="lobby-grid animate-fade-in-up anim-delay-100">
          {/* ── COLUNA ESQUERDA: SALAS ABERTAS ── */}
          <aside className="glass-card rooms-panel">
            <div className="rooms-panel-header">
              <div className="rooms-panel-title-wrap">
                <span className="live-pulse-dot" />
                <h2 className="rooms-panel-title">Salas Abertas</h2>
              </div>
              <span className="rooms-count-pill">{activeRooms.length}</span>
            </div>

            {activeRooms.length === 0 ? (
              <div className="rooms-empty">
                <div className="rooms-empty-icon">
                  <MonitorIcon size={24} />
                </div>
                <p className="rooms-empty-title">Nenhuma sala aberta</p>
              </div>
            ) : (
              <ul className="rooms-list">
                {activeRooms.map((room) => {
                  const isExpanded = expandedRoomSlug === room.slug;
                  return (
                    <li
                      key={room.slug}
                      className={`room-list-item ${isExpanded ? "room-list-item--expanded" : ""}`}
                    >
                      <button
                        type="button"
                        className="room-list-row"
                        onClick={() => handleRoomCardClick(room)}
                        title={
                          room.hasPassword
                            ? "Clique para digitar a senha"
                            : `Entrar direto em "${room.name}"`
                        }
                      >
                        <div className="room-list-left">
                          <div className="room-list-name-row">
                            <span className="room-list-name">{room.name}</span>
                            {room.isSharing && (
                              <span className="room-live-tag" title="Transmitindo tela agora">
                                AO VIVO
                              </span>
                            )}
                          </div>
                          {room.hostName && (
                            <span className="room-list-host">por {room.hostName}</span>
                          )}
                        </div>

                        <div className="room-list-right">
                          {room.hasPassword && (
                            <span className="room-lock-badge" title="Sala protegida por senha">
                              <LockIcon size={13} />
                            </span>
                          )}
                          <span className="room-users-badge" title={`${room.numParticipants} pessoa(s) na sala`}>
                            <UsersIcon size={12} />
                            <span>{room.numParticipants}</span>
                          </span>
                        </div>
                      </button>

                      {/* Gaveta (Accordion) de senha sem modal */}
                      {room.hasPassword && isExpanded && (
                        <div className="room-password-drawer">
                          <div className="drawer-input-row">
                            <div className="field-wrap" style={{ flex: 1 }}>
                              <LockIcon size={13} />
                              <input
                                type="password"
                                className="input field-input drawer-password-input"
                                placeholder="Senha da sala..."
                                value={drawerPassword}
                                onChange={(e) => {
                                  setDrawerPassword(e.target.value);
                                  setDrawerError("");
                                }}
                                onKeyDown={(e) => onKey(e, () => handleDrawerPasswordSubmit(room))}
                                autoFocus
                              />
                            </div>
                            <button
                              type="button"
                              className="btn btn-primary btn-sm drawer-submit-btn"
                              onClick={() => handleDrawerPasswordSubmit(room)}
                            >
                              Entrar
                            </button>
                          </div>
                          {drawerError && <span className="drawer-error">{drawerError}</span>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>

          {/* ── COLUNA DIREITA: CARD CRIAR / ENTRAR ── */}
          <div className="glass-card lobby-card">
            {/* Tabs */}
            <div className="lobby-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={tab === "create"}
                className={`lobby-tab ${tab === "create" ? "lobby-tab--active" : ""}`}
                onClick={() => {
                  setTab("create");
                  setError("");
                }}
              >
                <PlusIcon /> Criar Sala
              </button>
              <button
                role="tab"
                aria-selected={tab === "join"}
                className={`lobby-tab ${tab === "join" ? "lobby-tab--active" : ""}`}
                onClick={() => {
                  setTab("join");
                  setError("");
                }}
              >
                <EnterIcon /> Entrar
              </button>
            </div>

            <div className="lobby-fields">
              {/* Nome */}
              <div className="field">
                <label className="field-label" htmlFor="display-name">
                  Seu nome
                </label>
                <div className="field-wrap">
                  <UserIcon />
                  <input
                    ref={nameInputRef}
                    id="display-name"
                    type="text"
                    className="input field-input"
                    placeholder="Como seus amigos te chamam"
                    value={displayName}
                    maxLength={30}
                    onChange={(e) => {
                      setDisplayName(e.target.value);
                      if (error) setError("");
                    }}
                    onKeyDown={(e) => onKey(e, tab === "create" ? handleCreate : handleJoin)}
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
                          placeholder="ex: pato agil"
                          value={newRoomName}
                          onChange={(e) => setNewRoomName(e.target.value)}
                          onKeyDown={(e) => onKey(e, handleCreate)}
                        />
                      </div>
                      <button
                        className="btn btn-ghost btn-icon"
                        onClick={() => setNewRoomName(generateRoomName())}
                        title="Gerar outro nome"
                      >
                        <RefreshIcon />
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={handleCopyLinkAndOpen}
                        title="Copia o link de convite e já abre a sala"
                      >
                        {copiedLink ? (
                          <>
                            <CheckIcon /> Copiado!
                          </>
                        ) : (
                          <>
                            <LinkIcon /> Copiar Link
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="field animate-fade-in">
                    <button
                      type="button"
                      className="password-toggle"
                      onClick={() => {
                        setShowPassword((v) => !v);
                        if (showPassword) setRoomPassword("");
                      }}
                    >
                      {showPassword ? <LockIcon /> : <UnlockIcon />}
                      {showPassword ? "Remover senha da sala" : "Adicionar senha à sala"}
                      <ChevronIcon
                        style={{
                          marginLeft: "auto",
                          transform: showPassword ? "rotate(180deg)" : "none",
                          transition: "transform .2s",
                        }}
                      />
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
                          onChange={(e) => setRoomPassword(e.target.value)}
                          onKeyDown={(e) => onKey(e, handleCreate)}
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
                      <label className="field-label" htmlFor="join-room-name">
                        Nome da sala
                      </label>
                      <RoomStatusBadge />
                    </div>
                    <div className="field-wrap">
                      <MonitorIcon />
                      <input
                        id="join-room-name"
                        type="text"
                        className="input field-input"
                        placeholder="ex: pato agil"
                        value={joinRoomName}
                        onChange={(e) => setJoinRoomName(e.target.value)}
                        onKeyDown={(e) => onKey(e, handleJoin)}
                      />
                    </div>
                  </div>

                  {roomInfo?.hasPassword && (
                    <div className="field animate-fade-in-up">
                      <label className="field-label" htmlFor="join-password">
                        Senha da sala
                        <span className="field-hint">
                          <LockIcon size={11} /> Esta sala requer senha
                        </span>
                      </label>
                      <div className="field-wrap">
                        <LockIcon />
                        <input
                          id="join-password"
                          type="password"
                          className="input field-input"
                          placeholder="Digite a senha"
                          value={joinPassword}
                          onChange={(e) => setJoinPassword(e.target.value)}
                          onKeyDown={(e) => onKey(e, handleJoin)}
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
                  disabled={loading || !displayName.trim() || isUpdating}
                >
                  {loading ? (
                    <>
                      <span className="spinner" /> Criando...
                    </>
                  ) : (
                    <>
                      <MonitorIcon size={17} /> Criar e Entrar
                    </>
                  )}
                </button>
              ) : (
                <button
                  className="btn btn-primary btn-lg lobby-cta"
                  onClick={handleJoin}
                  disabled={loading || !displayName.trim() || checkingRoom || isUpdating}
                >
                  {loading ? (
                    <>
                      <span className="spinner" /> Entrando...
                    </>
                  ) : (
                    <>
                      <EnterIcon size={17} /> Entrar na Sala
                    </>
                  )}
                </button>
              )}
            </div>
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

      <GamepadConfigModal isOpen={showGamepadModal} onClose={() => setShowGamepadModal(false)} />

      <style>{lobbyStyles}</style>
    </main>
  );
}

// ─── Icons ───────────────────────────────────────────────────────────────────
function GamepadIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="12" x2="10" y2="12" />
      <line x1="8" y1="10" x2="8" y2="14" />
      <line x1="15" y1="13" x2="15.01" y2="13" strokeWidth="3" />
      <line x1="18" y1="11" x2="18.01" y2="11" strokeWidth="3" />
      <rect x="2" y="6" width="20" height="12" rx="6" />
    </svg>
  );
}
function MonitorIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}
function UserIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  );
}
function UsersIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function LockIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
function UnlockIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11V7a5 5 0 0 1 9.9-1" />
      <rect x="3" y="11" width="18" height="11" rx="2" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function EnterIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <polyline points="10 17 15 12 10 7" />
      <line x1="15" y1="12" x2="3" y2="12" />
    </svg>
  );
}
function RefreshIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 4v6h-6" />
      <path d="M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}
function LinkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function AlertIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
function ChevronIcon(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" {...p}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const lobbyStyles = `
  .lobby-page {
    height: 100%; display: flex; align-items: center; justify-content: center;
    padding: 20px 24px; position: relative; overflow-y: auto;
  }
  .lobby-shell {
    width: 100%; max-width: 780px; display: flex; flex-direction: column;
    gap: 18px; position: relative; z-index: 1;
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

  .lobby-grid {
    display: grid;
    grid-template-columns: 295px 1fr;
    gap: 18px;
    align-items: stretch;
  }

  /* ── Painel de Salas Abertas (Esquerda) ── */
  .rooms-panel {
    padding: 20px 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: 360px;
    max-height: 460px;
  }
  .rooms-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px 10px 4px;
    border-bottom: 1px solid var(--color-border);
  }
  .rooms-panel-title-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .live-pulse-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-accent);
    box-shadow: 0 0 10px var(--color-accent);
    animation: pulse-dot 2s infinite ease-in-out;
  }
  @keyframes pulse-dot {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.45; transform: scale(0.85); }
  }
  .rooms-panel-title {
    font-size: 0.9rem;
    font-weight: 700;
    color: var(--color-text-primary);
    margin: 0;
  }
  .rooms-count-pill {
    font-size: 0.73rem;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: var(--radius-full);
    background: var(--color-accent-dim);
    color: var(--color-accent);
    border: 1px solid rgba(0,212,184,0.25);
  }

  .rooms-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 20px 12px;
    gap: 8px;
  }
  .rooms-empty-icon {
    width: 46px;
    height: 46px;
    border-radius: 12px;
    background: rgba(255,255,255,0.03);
    border: 1px dashed var(--color-border);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-muted);
    margin-bottom: 4px;
  }
  .rooms-empty-title {
    font-size: 0.86rem;
    font-weight: 600;
    color: var(--color-text-secondary);
    margin: 0;
  }
  .rooms-empty-sub {
    font-size: 0.76rem;
    color: var(--color-text-muted);
    line-height: 1.45;
    margin: 0;
  }

  .rooms-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow-y: auto;
    flex: 1;
    padding-right: 2px;
  }
  .room-list-item {
    border-radius: var(--radius-md);
    background: rgba(0, 0, 0, 0.28);
    border: 1px solid rgba(255, 255, 255, 0.06);
    transition: border-color 0.18s ease, background 0.18s ease;
    overflow: hidden;
  }
  .room-list-item:hover {
    border-color: rgba(0, 212, 184, 0.35);
    background: rgba(0, 212, 184, 0.05);
  }
  .room-list-item--expanded {
    border-color: rgba(0, 212, 184, 0.5);
    background: rgba(0, 0, 0, 0.42);
  }
  .room-list-row {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 11px 12px;
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    text-align: left;
    font-family: var(--font-sans);
  }
  .room-list-left {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .room-list-name-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .room-list-name {
    font-size: 0.9rem;
    font-weight: 700;
    color: var(--color-text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .room-live-tag {
    font-size: 0.6rem;
    font-weight: 800;
    padding: 1px 5px;
    border-radius: 4px;
    background: rgba(248, 113, 113, 0.18);
    color: #f87171;
    border: 1px solid rgba(248, 113, 113, 0.35);
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }
  .room-list-host {
    font-size: 0.73rem;
    color: var(--color-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .room-list-right {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .room-lock-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.06);
    color: var(--color-text-secondary);
  }
  .room-users-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border-radius: var(--radius-full);
    background: var(--color-accent-dim);
    color: var(--color-accent);
    font-size: 0.75rem;
    font-weight: 700;
  }

  /* Gaveta de senha inline (sem modal) */
  .room-password-drawer {
    padding: 0 12px 11px 12px;
    border-top: 1px dashed rgba(255, 255, 255, 0.08);
    padding-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    animation: drawerSlideDown 0.16s ease-out;
  }
  @keyframes drawerSlideDown {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .drawer-input-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .drawer-password-input {
    height: 34px !important;
    font-size: 0.82rem !important;
    padding-left: 34px !important;
  }
  .drawer-submit-btn {
    height: 34px;
    padding: 0 12px;
    flex-shrink: 0;
  }
  .drawer-error {
    font-size: 0.74rem;
    color: var(--color-danger);
    font-weight: 500;
  }

  /* ── Card Principal (Direita) ── */
  .lobby-card { padding: 26px; display: flex; flex-direction: column; gap: 22px; }
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
    position: absolute; left: 12px; top: 50%; transform: translateY(-50%);
    color: var(--color-text-muted); pointer-events: none; width: 15px; height: 15px;
  }
  .field-input { padding-left: 38px !important; }
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

  @media (max-width: 720px) {
    .lobby-grid {
      grid-template-columns: 1fr;
    }
    .rooms-panel {
      min-height: 200px;
      max-height: 260px;
    }
  }
`;
