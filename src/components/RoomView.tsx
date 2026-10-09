import { useEffect, useState, useRef, useCallback } from "react";
import Peer, { MediaConnection } from "peerjs";
import { copyToClipboard, API_URL } from "../utils";

interface RoomViewProps {
  roomName: string;
  displayName: string;
  password?: string;
  isCreator: boolean;
  onLeave: () => void;
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
  
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  // Ouve evento do Main Process pedindo para selecionar tela (Electron)
  useEffect(() => {
    if (window.electronAPI?.onShowDesktopSourceSelector) {
      window.electronAPI.onShowDesktopSourceSelector((sources) => {
        setDesktopSources(sources);
      });
    }
  }, []);

  useEffect(() => {
    // Configuração do PeerJS
    const hostId = `ct-desktop-${roomName}-host`;
    const myId = isCreator ? hostId : undefined; // Se não for criador, gera ID aleatório
    
    setConnectionStatus("Conectando ao servidor...");
    const newPeer = new Peer(myId as string, {
      debug: 2
    });

    newPeer.on("open", (id) => {
      setConnectionStatus(isCreator ? "Sala criada. Aguardando espectadores..." : "Conectado. Chamando anfitrião...");
      console.log("Meu Peer ID:", id);
      
      if (!isCreator) {
        // Sou espectador, ligo para o anfitrião
        const call = newPeer.call(hostId, new MediaStream()); // Manda stream vazia
        setupCall(call);
      }
    });

    newPeer.on("call", (call) => {
      // Recebendo ligação (Geralmente o anfitrião recebe ligações dos espectadores)
      if (isCreator) {
        // Se eu estiver compartilhando, atendo com minha stream, senão com vazia
        call.answer(localStream || new MediaStream());
      } else {
        call.answer();
      }
      setupCall(call);
    });

    newPeer.on("error", (err) => {
      console.error("PeerJS Error:", err);
      setConnectionStatus("Erro: " + err.message);
    });

    setPeer(newPeer);

    return () => {
      newPeer.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomName, isCreator]);

  // Atualiza stream no anfitrião quando ele começa a compartilhar
  useEffect(() => {
    if (isCreator && peer && localStream) {
      // Atualiza as ligações existentes com a nova stream
      Object.values(peer.connections).forEach((conns: any) => {
        conns.forEach((conn: any) => {
          if (conn instanceof MediaConnection && conn.peerConnection) {
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

  const setupCall = (call: MediaConnection) => {
    call.on("stream", (stream) => {
      console.log("Recebeu stream remota", stream.getTracks());
      if (stream.getTracks().length > 0) {
        setRemoteStream(stream);
        setConnectionStatus("Assistindo transmissão");
      }
    });
    call.on("close", () => {
      if (!isCreator) {
        setRemoteStream(null);
        setConnectionStatus("Transmissão encerrada.");
      }
    });
  };

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
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
      });
      
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

  const viewerUrl = `${API_URL}?sala=${encodeURIComponent(roomName)}`;

  const handleCopyLink = async () => {
    await copyToClipboard(`${roomName}\n${viewerUrl}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div className="room-layout" style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0f172a', color: '#f8fafc' }}>
      {/* Topbar */}
      <header style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 20px', background: '#1e293b', borderBottom: '1px solid #334155' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <b style={{ color: '#0ea5e9' }}>{roomName}</b>
          <span style={{ fontSize: '0.85rem', color: '#94a3b8' }}>Status: {connectionStatus}</span>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn btn-secondary btn-sm" onClick={handleCopyLink}>
            {copied ? "Copiado!" : "Copiar Link"}
          </button>
          <button className="btn btn-danger btn-sm" onClick={onLeave}>Sair</button>
        </div>
      </header>

      {/* Content */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', overflow: 'hidden' }}>
        {shareError && <div style={{ color: '#ef4444', marginBottom: 16 }}>{shareError}</div>}
        
        {isCreator ? (
          localStream ? (
             <video ref={localVideoRef} autoPlay muted style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000', borderRadius: 8 }} />
          ) : (
            <div style={{ textAlign: 'center', color: '#94a3b8' }}>
              <h2>Sua Sala de Transmissão</h2>
              <p>Clique abaixo para começar a compartilhar sua tela via P2P.</p>
            </div>
          )
        ) : (
          remoteStream ? (
            <video ref={remoteVideoRef} autoPlay style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000', borderRadius: 8 }} />
          ) : (
            <div style={{ textAlign: 'center', color: '#94a3b8' }}>
              <h2>Aguardando anfitrião...</h2>
              <p>O anfitrião ainda não iniciou o compartilhamento ou você está conectando.</p>
            </div>
          )
        )}
      </div>

      {/* Footer Controls */}
      {isCreator && (
        <footer style={{ padding: '16px', background: '#1e293b', borderTop: '1px solid #334155', display: 'flex', justifyContent: 'center' }}>
          {isSharing ? (
            <button className="btn btn-danger" onClick={handleStopShare} style={{ background: '#ef4444', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold' }}>
              Parar Transmissão
            </button>
          ) : (
            <button className="btn btn-primary" onClick={handleStartShare} style={{ background: '#0ea5e9', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold' }}>
              Compartilhar Tela
            </button>
          )}
        </footer>
      )}

      {/* Fonte de Tela (Modal do Electron) */}
      {desktopSources.length > 0 && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div style={{ background: '#1e293b', padding: 24, borderRadius: 8, width: '80%', maxWidth: 800, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ marginTop: 0 }}>Selecione o que compartilhar</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 16, overflowY: 'auto' }}>
              {desktopSources.map(s => (
                <div key={s.id} onClick={() => {
                  window.electronAPI?.sendDesktopSourceSelected(s.id);
                  setDesktopSources([]);
                }} style={{ cursor: 'pointer', position: 'relative' }}>
                  <img src={s.thumbnail} alt={s.name} style={{ width: '100%', aspectRatio: '16/10', objectFit: 'cover' }} />
                  <span style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(0,0,0,0.8)', padding: 4, fontSize: '0.8rem', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                </div>
              ))}
            </div>
            <button style={{ marginTop: 16, padding: '10px' }} onClick={() => { window.electronAPI?.sendDesktopSourceSelected(null); setDesktopSources([]); }}>Cancelar</button>
          </div>
        </div>
      )}
    </div>
  );
}
