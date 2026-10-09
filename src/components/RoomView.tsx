import { useEffect, useState, useRef, useCallback } from "react";
import Peer from "peerjs";
import { copyToClipboard, API_URL } from "../utils";

type Quality = "720p30" | "1080p30" | "1080p60" | "1440p60" | "2160p60";

const QUALITY_LABELS: Record<Quality, string> = {
  "720p30":  "720p · 30fps",
  "1080p30": "1080p · 30fps",
  "1080p60": "1080p · 60fps",
  "1440p60": "1440p · 60fps",
  "2160p60": "4K · 60fps",
};

const QUALITY_CONSTRAINTS: Record<Quality, { width: number; height: number; frameRate: number }> = {
  "720p30":  { width: 1280, height: 720,  frameRate: 30 },
  "1080p30": { width: 1920, height: 1080, frameRate: 30 },
  "1080p60": { width: 1920, height: 1080, frameRate: 60 },
  "1440p60": { width: 2560, height: 1440, frameRate: 60 },
  "2160p60": { width: 3840, height: 2160, frameRate: 60 },
};

interface RoomViewProps {
  roomName: string;
  displayName: string;
  password?: string;
  isCreator: boolean;
  onLeave: () => void;
}

interface Participant {
  id: string;
  name: string;
  isLocal: boolean;
  isSharing: boolean;
}

export default function RoomView({ roomName, displayName, isCreator, onLeave }: RoomViewProps) {
  const [peer, setPeer] = useState<Peer | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<string>("Inicializando...");
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  
  const [isSharing, setIsSharing] = useState(false);
  const [shareError, setShareError] = useState("");
  const [desktopSources, setDesktopSources] = useState<any[]>([]);
  const [copied, setCopied] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  
  const [quality, setQuality] = useState<Quality>("1080p60");
  const [showQuality, setShowQuality] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isCameraEnabled, setIsCameraEnabled] = useState(false); // Apenas visual no P2P atual
  
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const qualityRef = useRef<HTMLDivElement>(null);
  
  const dummyStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext("2d");
      if(ctx) { ctx.fillStyle = "#000"; ctx.fillRect(0,0,640,360); }
      const videoTrack = canvas.captureStream(1).getVideoTracks()[0];
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioCtx();
      const dest = audioCtx.createMediaStreamDestination();
      const audioTrack = dest.stream.getAudioTracks()[0];
      dummyStreamRef.current = new MediaStream([videoTrack, audioTrack]);
    }
  }, []);

  const dataConnectionsRef = useRef<Map<string, any>>(new Map());
  const participantsRef = useRef<Participant[]>([]);

  // Timer
  const [timeActive, setTimeActive] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTimeActive(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  const formatTime = (s: number) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
    return `${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
  };

  // Fecha menu de qualidade ao clicar fora
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (qualityRef.current && !qualityRef.current.contains(e.target as Node)) setShowQuality(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  useEffect(() => {
    if (window.electronAPI?.onShowDesktopSourceSelector) {
      window.electronAPI.onShowDesktopSourceSelector((sources) => {
        setDesktopSources(sources);
      });
    }
  }, []);

  // Mantém a ref sincronizada para a função de broadcast do anfitrião
  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  const broadcastParticipants = useCallback(() => {
    const data = { type: 'sync_participants', participants: participantsRef.current };
    dataConnectionsRef.current.forEach(conn => {
      if (conn.open) conn.send(data);
    });
  }, []);

  // PeerJS Setup
  useEffect(() => {
    const hostId = `ct-desktop-${roomName}-host`;
    const myId = isCreator ? hostId : undefined;
    
    setConnectionStatus("Conectando ao servidor...");
    const newPeer = new Peer(myId as string, { debug: 1 });

    newPeer.on("open", (id) => {
      setConnectionStatus(isCreator ? "Sala criada. Aguardando espectadores..." : "Conectado. Chamando anfitrião...");
      
      const me: Participant = { id, name: displayName, isLocal: true, isSharing: false };
      setParticipants([me]);

      if (!isCreator) {
        // Espectador conecta ao anfitrião
        const dataConn = newPeer.connect(hostId, { metadata: { name: displayName } });
        dataConn.on('data', (data: any) => {
          if (data.type === 'sync_participants') {
            const synced = data.participants.map((p: Participant) => ({ ...p, isLocal: p.id === id }));
            setParticipants(synced);
          }
        });

        const call = newPeer.call(hostId, dummyStreamRef.current || new MediaStream());
        call.on("stream", (stream: any) => {
          if (stream.getTracks().length > 0) {
            setRemoteStream(stream);
            setConnectionStatus("Assistindo transmissão");
          }
        });
        call.on("close", () => {
          setRemoteStream(null);
          setConnectionStatus("Transmissão encerrada.");
        });
      }
    });

    if (isCreator) {
      newPeer.on("connection", (conn: any) => {
        conn.on('open', () => {
          dataConnectionsRef.current.set(conn.peer, conn);
          const newParticipant: Participant = {
            id: conn.peer,
            name: conn.metadata?.name || "Espectador",
            isLocal: false,
            isSharing: false
          };
          setParticipants(prev => [...prev, newParticipant]);
          setTimeout(broadcastParticipants, 500); // Dá um tempo para atualizar e enviar
        });

        conn.on('close', () => {
          dataConnectionsRef.current.delete(conn.peer);
          setParticipants(prev => prev.filter(p => p.id !== conn.peer));
          setTimeout(broadcastParticipants, 500);
        });
      });
    }

    newPeer.on("call", (call: any) => {
      if (isCreator) {
        call.answer(localStream || dummyStreamRef.current || new MediaStream());
      } else {
        call.answer();
      }
      if (isCreator) {
        call.on("stream", () => {}); // Ignora stream do espectador
      }
    });

    newPeer.on("error", (err) => {
      console.error("PeerJS Error:", err);
      setConnectionStatus("Erro: " + err.message);
    });

    setPeer(newPeer);
    return () => newPeer.destroy();
  }, [roomName, isCreator, displayName, broadcastParticipants]);

  // Atualiza a flag isSharing do anfitrião
  useEffect(() => {
    if (isCreator) {
      setParticipants(prev => prev.map(p => p.isLocal ? { ...p, isSharing } : p));
      setTimeout(broadcastParticipants, 200);
    }
  }, [isSharing, isCreator, broadcastParticipants]);

  // Envia a nova stream para os espectadores
  useEffect(() => {
    if (isCreator && peer && localStream) {
      Object.values(peer.connections).forEach((conns: any) => {
        conns.forEach((conn: any) => {
          if (conn.peerConnection) {
            const senders = conn.peerConnection.getSenders();
            localStream.getTracks().forEach(track => {
              const sender = senders.find((s: any) => s.track && s.track.kind === track.kind);
              if (sender) {
                sender.replaceTrack(track);
              } else {
                conn.peerConnection.addTrack(track, localStream);
              }
            });
          }
        });
      });
    }
  }, [localStream, peer, isCreator]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  const handleStartShare = async () => {
    setShareError("");
    try {
      const q = QUALITY_CONSTRAINTS[quality];
      let stream: MediaStream;

      if (window.electronAPI) {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate } },
          audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
        });
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: q.width, height: q.height, frameRate: q.frameRate },
          audio: true,
        });
      }
      
      setLocalStream(stream);
      setIsSharing(true);
      
      stream.getVideoTracks()[0].onended = () => {
        handleStopShare();
      };
    } catch (err: any) {
      if (err?.name !== "NotAllowedError") {
        setShareError("Erro ao iniciar: " + (err?.message || "desconhecido"));
      }
    }
  };

  const handleStopShare = () => {
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
    }
    setLocalStream(null);
    setIsSharing(false);
  };

  const toggleFullscreen = () => {
    const el = document.querySelector(".screen-wrap");
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen().catch(err => console.error(err));
    } else {
      document.exitFullscreen();
    }
  };

  const toggleCamera = () => {
    setIsCameraEnabled(!isCameraEnabled); // Apenas UI visual por enquanto no modo P2P
  };

  const viewerUrl = `${API_URL}?sala=${encodeURIComponent(roomName)}`;

  const handleCopyLink = async () => {
    await copyToClipboard(`${roomName}\n${viewerUrl}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  // Helper para o nome de quem está compartilhando
  const sharingParticipant = participants.find(p => p.isSharing);

  return (
    <div className="room-layout">
      {/* Top bar */}
      <header className="room-topbar">
        <div className="room-topbar-left">
          <div className="room-logo-mini">
            <MonitorIcon size={15} />
          </div>
          <div className="room-name-row">
            <code className="room-name-code">{roomName}</code>
            {sharingParticipant && (
              <span className="badge badge-live">
                <span className="badge-dot" />
                Transmitindo
              </span>
            )}
            <span className="badge" title="Tempo de chamada">
              <ClockIcon /> {formatTime(timeActive)}
            </span>
          </div>
        </div>
        <div className="room-topbar-right">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setShowParticipants(o => !o)}
            title="Participantes"
          >
            <UsersIcon />
            <span className="participants-count">{participants.length}</span>
          </button>
          <button className="btn btn-secondary btn-sm" onClick={handleCopyLink}>
            {copied ? <><CheckIcon /> Copiado!</> : <><LinkIcon /> Link p/ assistir</>}
          </button>
          <button className="btn btn-danger btn-sm" onClick={onLeave}>
            <LeaveIcon /> Sair
          </button>
        </div>
      </header>

      {/* Content */}
      <div className="room-content">
        <div className="room-video-area">
          {shareError && (
            <div style={{
              background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)",
              borderRadius: "var(--radius-sm)", padding: "10px 16px", marginBottom: 8,
              color: "var(--color-danger)", fontSize: "0.85rem", display: "flex", gap: 8,
            }}>
              <AlertIcon /> {shareError}
            </div>
          )}

          {isCreator ? (
            isSharing && localStream ? (
              <div className="screen-wrap">
                <video ref={localVideoRef} autoPlay muted className="screen-video" />
                <div className="screen-label">
                  <MonitorIcon size={11} /> Sua tela (prévia)
                  <button 
                    onClick={(e) => {
                      const videoEl = (e.currentTarget.closest('.screen-wrap') as HTMLElement)?.querySelector('video');
                      if (videoEl) {
                        if (document.pictureInPictureElement) document.exitPictureInPicture();
                        else videoEl.requestPictureInPicture().catch(console.error);
                      }
                    }}
                    style={{ marginLeft: 6, background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 4, color: '#fff', cursor: 'pointer', padding: '2px 6px', display: 'flex', alignItems: 'center', gap: 4 }}
                    title="Tela Flutuante (Janelinha)"
                  >
                    <PiPIcon /> Janelinha
                  </button>
                </div>
              </div>
            ) : (
              <div className="room-empty">
                <div className="room-empty-icon animate-float">
                  <MonitorIcon size={44} />
                </div>
                <h2 className="room-empty-title">Nenhuma tela compartilhada</h2>
                <p className="room-empty-sub">
                  Clique em <strong>Compartilhar Tela</strong> para iniciar a transmissão.<br />
                  Seus amigos acessam pelo link no navegador deles.
                </p>
                <p style={{marginTop: 8, fontSize: '0.8rem', color: 'var(--color-text-muted)'}}>{connectionStatus}</p>
              </div>
            )
          ) : (
            remoteStream ? (
              <div className="screen-wrap">
                <video ref={remoteVideoRef} autoPlay className="screen-video" />
                <div className="screen-label">
                  <MonitorIcon size={11} /> Tela do Anfitrião
                  <button 
                    onClick={(e) => {
                      const videoEl = (e.currentTarget.closest('.screen-wrap') as HTMLElement)?.querySelector('video');
                      if (videoEl) {
                        if (document.pictureInPictureElement) document.exitPictureInPicture();
                        else videoEl.requestPictureInPicture().catch(console.error);
                      }
                    }}
                    style={{ marginLeft: 6, background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 4, color: '#fff', cursor: 'pointer', padding: '2px 6px', display: 'flex', alignItems: 'center', gap: 4 }}
                    title="Tela Flutuante (Janelinha)"
                  >
                    <PiPIcon /> Janelinha
                  </button>
                </div>
              </div>
            ) : (
              <div className="room-empty">
                <div className="room-empty-icon animate-float">
                  <MonitorIcon size={44} />
                </div>
                <h2 className="room-empty-title">Aguardando transmissão</h2>
                <p className="room-empty-sub">
                  O anfitrião ainda não iniciou o compartilhamento de tela ou a conexão está sendo estabelecida.
                </p>
                <p style={{marginTop: 8, fontSize: '0.8rem', color: 'var(--color-text-muted)'}}>{connectionStatus}</p>
              </div>
            )
          )}
        </div>

        {/* Sidebar participantes */}
        {showParticipants && (
          <aside className="room-sidebar animate-scale-in">
            <div className="sidebar-header">
              <h3>Participantes</h3>
              <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setShowParticipants(false)}>
                <XIcon />
              </button>
            </div>
            <ul className="participant-list">
              {participants.map(p => (
                <li key={p.id} className="participant-item">
                  <div className="participant-avatar">{(p.name || "?")[0].toUpperCase()}</div>
                  <div className="participant-info">
                    <span className="participant-name">{p.name}{p.isLocal ? " (você)" : ""}</span>
                    {p.isSharing && <span className="participant-sharing">Transmitindo</span>}
                  </div>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>

      {/* Controls */}
      <footer className="room-controls">
        {/* Quality */}
        {isCreator && (
          <div className="quality-wrap" ref={qualityRef}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setShowQuality(o => !o)}
              disabled={isSharing}
              title={isSharing ? "Pare para mudar a qualidade" : "Qualidade da transmissão"}
            >
              <QualityIcon /> {QUALITY_LABELS[quality]}
            </button>
            {showQuality && (
              <div className="quality-menu animate-scale-in">
                {(Object.keys(QUALITY_LABELS) as Quality[]).map(q => (
                  <button
                    key={q}
                    className={`quality-option ${quality === q ? "quality-option--active" : ""}`}
                    onClick={() => { setQuality(q); setShowQuality(false); }}
                  >
                    {quality === q && <CheckIcon />}
                    {QUALITY_LABELS[q]}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Share button */}
        {isCreator && (
          isSharing ? (
            <button className="btn btn-danger" onClick={handleStopShare}>
              <StopShareIcon /> Parar Transmissão
            </button>
          ) : (
            <button className="btn btn-primary" onClick={handleStartShare}>
              <MonitorIcon size={17} /> Compartilhar Tela
            </button>
          )
        )}

        <button
          className={`btn ${isCameraEnabled ? "btn-secondary" : "btn-ghost"} btn-icon`}
          onClick={toggleCamera}
          title={isCameraEnabled ? "Desativar Câmera" : "Ativar Câmera"}
          style={!isCameraEnabled ? { color: "var(--color-danger)" } : {}}
        >
          {isCameraEnabled ? <CameraIcon size={18} /> : <CameraOffIcon size={18} />}
        </button>

        <button
          className="btn btn-secondary btn-icon"
          onClick={toggleFullscreen}
          title="Tela Cheia"
        >
          <FullscreenIcon />
        </button>

        {/* Volume */}
        <div className="volume-wrap">
          <VolumeIcon />
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={volume}
            onChange={e => {
              const v = parseFloat(e.target.value);
              setVolume(v);
              if (remoteVideoRef.current) remoteVideoRef.current.volume = v;
            }}
            className="volume-slider"
            title="Volume"
          />
        </div>

        <div className="room-status-right">
          <span className="online-count">
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--color-success)", display: "inline-block" }} />
            {participants.length} online
          </span>
        </div>
      </footer>

      {/* Fonte de Tela (Modal do Electron) */}
      {desktopSources.length > 0 && (
        <div className="source-selector-overlay">
          <div className="source-selector-modal">
            <h3>Selecione o que compartilhar</h3>
            <div className="source-list">
              {desktopSources.map(s => (
                <div key={s.id} className="source-item" onClick={() => {
                  window.electronAPI?.sendDesktopSourceSelected(s.id);
                  setDesktopSources([]);
                }}>
                  <img src={s.thumbnail} alt={s.name} />
                  <span>{s.name}</span>
                </div>
              ))}
            </div>
            <button className="btn btn-ghost" style={{ marginTop: 16, width: "100%" }} onClick={() => {
              window.electronAPI?.sendDesktopSourceSelected(null);
              setDesktopSources([]);
            }}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Styles originais re-inseridos para o funcionamento sem LiveKit */}
      <style dangerouslySetInnerHTML={{__html: roomStyles}} />
    </div>
  );
}

// ─── Icons ───────────────────────────────────────────────────────────────────
function MonitorIcon({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>;
}
function ClockIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
}
function UsersIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
}
function LinkIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>;
}
function CheckIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>;
}
function LeaveIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>;
}
function XIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
}
function QualityIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>;
}
function StopShareIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="4" y1="4" x2="20" y2="20"/></svg>;
}
function VolumeIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>;
}
function AlertIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>;
}
function FullscreenIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>;
}
function PiPIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><rect x="12" y="14" width="7" height="5" rx="1" ry="1"/></svg>;
}
function CameraIcon({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>;
}
function CameraOffIcon({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M2 2l20 20M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>;
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const roomStyles = `
  .room-center {
    height: 100%; display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 16px; color: var(--color-text-secondary); font-size: 0.9rem;
  }
  .room-layout {
    display: flex; flex-direction: column;
    height: 100%;
    background: var(--color-bg-base);
    overflow: hidden;
  }
  .room-topbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px;
    background: var(--color-bg-elevated);
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0; gap: 12px; z-index: 10;
  }
  .source-selector-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.8);
    display: flex; align-items: center; justify-content: center;
    z-index: 9999; backdrop-filter: blur(4px);
  }
  .source-selector-modal {
    background: var(--color-bg-elevated); padding: 24px;
    border-radius: var(--radius-lg); width: 80%; max-width: 800px;
    border: 1px solid var(--color-border);
    max-height: 80vh; display: flex; flex-direction: column;
  }
  .source-selector-modal h3 { margin: 0 0 16px 0; font-size: 1.1rem; color: #fff; }
  .source-list {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 16px; overflow-y: auto; padding-right: 8px;
  }
  .source-item {
    background: var(--color-bg-base); border: 2px solid transparent;
    border-radius: var(--radius-md); overflow: hidden; cursor: pointer;
    transition: all 0.2s; display: flex; flex-direction: column; position: relative;
    min-height: 120px;
  }
  .source-item:hover { border-color: var(--color-accent); transform: translateY(-2px); }
  .source-item img { width: 100%; aspect-ratio: 16/10; object-fit: cover; background: #000; }
  .source-item span { 
    position: absolute; bottom: 0; left: 0; right: 0; 
    padding: 8px; font-size: 0.85rem; text-align: center; 
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; 
    background: rgba(0,0,0,0.85); color: #fff; font-weight: bold;
    display: block !important;
  }

  .room-topbar-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .room-logo-mini {
    width: 30px; height: 30px;
    background: var(--color-accent); border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    color: #fff; flex-shrink: 0;
  }
  .room-name-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .room-name-code {
    font-family: var(--font-mono); font-size: 0.82rem;
    color: var(--color-accent); background: var(--color-accent-dim);
    padding: 2px 10px; border-radius: var(--radius-full);
    border: 1px solid rgba(0,212,184,0.2);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px;
  }
  .room-topbar-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .participants-count {
    background: var(--color-accent-dim); color: var(--color-accent);
    border-radius: var(--radius-full); padding: 1px 7px;
    font-size: 0.73rem; font-weight: 700; margin-left: 2px;
  }
  .room-content { flex: 1; display: flex; min-height: 0; position: relative; overflow: hidden; }
  .room-video-area {
    flex: 1; display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    padding: 16px; gap: 12px; overflow: hidden;
    background: var(--color-bg-base);
  }
  .screen-wrap {
    position: relative; width: 100%; flex: 1; min-height: 0;
    border-radius: var(--radius-lg); overflow: hidden;
    background: #000; box-shadow: 0 8px 40px rgba(0,0,0,0.6);
  }
  .screen-video { width: 100% !important; height: 100% !important; object-fit: contain; }
  .screen-label {
    position: absolute; bottom: 12px; left: 12px;
    display: flex; align-items: center; gap: 6px;
    background: rgba(0,0,0,0.65); backdrop-filter: blur(8px);
    color: #fff; font-size: 0.78rem; font-weight: 600;
    padding: 4px 12px; border-radius: var(--radius-full);
    border: 1px solid rgba(255,255,255,0.1);
  }
  .room-empty {
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 16px; text-align: center; padding: 40px;
  }
  .room-empty-icon {
    width: 90px; height: 90px; background: var(--color-accent-dim);
    border: 1px solid rgba(0,212,184,0.2); border-radius: var(--radius-xl);
    display: flex; align-items: center; justify-content: center; color: var(--color-accent);
  }
  .room-empty-title { font-size: 1.3rem; font-weight: 700; }
  .room-empty-sub { color: var(--color-text-secondary); max-width: 360px; font-size: 0.88rem; line-height: 1.6; }
  .room-sidebar {
    width: 250px; background: var(--color-bg-elevated);
    border-left: 1px solid var(--color-border);
    display: flex; flex-direction: column; flex-shrink: 0; overflow: hidden;
  }
  .sidebar-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 13px 14px; border-bottom: 1px solid var(--color-border);
  }
  .sidebar-header h3 { font-size: 0.87rem; font-weight: 600; color: var(--color-text-secondary); }
  .participant-list { padding: 8px 6px; display: flex; flex-direction: column; gap: 3px; overflow-y: auto; }
  .participant-item {
    display: flex; align-items: center; gap: 9px; padding: 8px 9px;
    border-radius: var(--radius-sm); transition: background var(--duration-fast);
  }
  .participant-item:hover { background: rgba(255,255,255,0.04); }
  .participant-avatar {
    width: 32px; height: 32px; border-radius: var(--radius-full);
    background: var(--color-accent); display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 0.82rem; color: #fff; flex-shrink: 0;
  }
  .participant-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .participant-name {
    font-size: 0.85rem; font-weight: 500; color: var(--color-text-primary);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .participant-sharing { font-size: 0.72rem; color: var(--color-success); }
  .room-controls {
    display: flex; align-items: center; justify-content: center; gap: 10px;
    padding: 12px 20px; background: var(--color-bg-elevated);
    border-top: 1px solid var(--color-border);
    flex-shrink: 0; position: relative;
  }
  .room-status-right { position: absolute; right: 20px; display: flex; align-items: center; }
  .online-count { display: flex; align-items: center; gap: 6px; font-size: 0.76rem; color: var(--color-text-muted); }
  .quality-wrap { position: relative; }
  .quality-menu {
    position: absolute; bottom: calc(100% + 8px); left: 0;
    background: var(--color-bg-elevated); border: 1px solid var(--color-border);
    border-radius: var(--radius-md); overflow: hidden;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5); min-width: 155px; z-index: 50;
  }
  .quality-option {
    display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 13px;
    background: transparent; border: none; color: var(--color-text-secondary);
    font-size: 0.83rem; font-weight: 500; cursor: pointer; font-family: var(--font-sans);
    transition: background var(--duration-fast), color var(--duration-fast); text-align: left;
  }
  .quality-option:hover { background: rgba(255,255,255,0.06); color: var(--color-text-primary); }
  .quality-option--active { color: var(--color-accent); }
  .volume-wrap { display: flex; align-items: center; gap: 8px; padding: 0 10px; color: var(--color-text-secondary); }
  .volume-slider { width: 80px; cursor: pointer; accent-color: var(--color-accent); }

  @media (max-width: 768px) {
    .room-topbar { flex-direction: column; align-items: flex-start; gap: 8px; padding: 10px; }
    .room-topbar-right { width: 100%; justify-content: space-between; }
    .room-name-code { max-width: 120px; }
    .room-controls { flex-wrap: wrap; padding: 10px; gap: 8px; justify-content: space-between; }
    #start-share-btn, #stop-share-btn { width: 100%; order: -1; }
    .volume-wrap { display: none; }
    .quality-wrap { flex: 1; }
    #quality-btn { width: 100%; justify-content: center; }
    .room-status-right { position: static; }
    .room-sidebar { position: absolute; top: 0; right: 0; bottom: 0; z-index: 100; box-shadow: -4px 0 20px rgba(0,0,0,0.5); }
    .screen-label { font-size: 0.65rem; padding: 4px 8px; bottom: 8px; left: 8px; }
    .room-empty { padding: 20px; }
    .room-empty-title { font-size: 1.1rem; }
  }
`;
