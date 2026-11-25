import { useEffect, useState, useRef, useCallback } from "react";
import Peer from "peerjs";
import { copyToClipboard, sanitizeRoomName, toRoomSlug, hashPassword, API_URL } from "../utils";
import { roomRegistry } from "../roomRegistry";
import GamepadConfigModal from "./GamepadConfigModal";
import {
  loadGamepadConfig,
  sampleGamepad,
  isGamepadStateDifferent,
  type VirtualGamepadState,
} from "../gamepadManager";

type Quality = "720p30" | "1080p30" | "1080p60" | "1440p60" | "2160p60";
type AudioMode = "exclude-discord" | "window-only" | "all";

const QUALITY_LABELS: Record<Quality, string> = {
  "720p30":  "720p · 30fps",
  "1080p30": "1080p · 30fps",
  "1080p60": "1080p · 60fps",
  "1440p60": "1440p · 60fps",
  "2160p60": "4K · 60fps",
};

const AUDIO_MODE_LABELS: Record<AudioMode, string> = {
  "exclude-discord": "Áudio: Sem Discord (Anti-Eco)",
  "window-only":     "Áudio: Apenas Janela",
  "all":             "Áudio: Tudo (Padrão)",
};

const QUALITY_CONSTRAINTS: Record<Quality, { width: number; height: number; frameRate: number; maxBitrateKbps: number }> = {
  "720p30":  { width: 1280, height: 720,  frameRate: 30, maxBitrateKbps: 10000 },
  "1080p30": { width: 1920, height: 1080, frameRate: 30, maxBitrateKbps: 18000 },
  "1080p60": { width: 1920, height: 1080, frameRate: 60, maxBitrateKbps: 30000 },
  "1440p60": { width: 2560, height: 1440, frameRate: 60, maxBitrateKbps: 45000 },
  "2160p60": { width: 3840, height: 2160, frameRate: 60, maxBitrateKbps: 65000 },
};

// Modifica o SDP do WebRTC para remover compressão agressiva de áudio (Opus 510kbps Estéreo Fullband CBR sem DTX) e liberar alto bitrate de vídeo
function enhanceSdpQuality(sdp: string, maxVideoBitrateKbps: number): string {
  if (!sdp) return sdp;
  const startBitrate = Math.round(maxVideoBitrateKbps * 0.65);
  const minBitrate = Math.min(8000, Math.round(maxVideoBitrateKbps * 0.25));

  const lines = sdp.split(/\r?\n/);
  let opusPt: string | null = null;
  const videoPts = new Set<string>();
  let inVideoSection = false;

  for (const line of lines) {
    if (line.startsWith("m=video")) {
      inVideoSection = true;
    } else if (line.startsWith("m=")) {
      inVideoSection = false;
    }
    const rtpMatch = line.match(/^a=rtpmap:(\d+)\s+([a-zA-Z0-9._-]+)\//i);
    if (rtpMatch) {
      const pt = rtpMatch[1];
      const codec = rtpMatch[2].toLowerCase();
      if (codec === "opus") {
        opusPt = pt;
      } else if (inVideoSection && ["vp8", "vp9", "h264", "av1"].includes(codec)) {
        videoPts.add(pt);
      }
    }
  }

  inVideoSection = false;
  let addedVideoBandwidth = false;
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (line.startsWith("m=video")) {
      inVideoSection = true;
      addedVideoBandwidth = false;
    } else if (line.startsWith("m=")) {
      inVideoSection = false;
    }

    // Força Opus em 510 kbps Estéreo Puro CBR (qualidade transparente de estúdio, sem cortes de silêncio DTX)
    if (opusPt && line.startsWith(`a=fmtp:${opusPt} `)) {
      const params = "stereo=1;sprop-stereo=1;maxaveragebitrate=510000;maxplaybackrate=48000;sprop-maxcapturerate=48000;cbr=1;useinbandfec=1;dtx=0";
      line = `${line};${params}`;
    }

    // Força bitrate alto de vídeo imediato no encoder do Chromium/WebRTC
    const fmtpMatch = line.match(/^a=fmtp:(\d+)\s+(.*)$/);
    if (fmtpMatch && videoPts.has(fmtpMatch[1])) {
      if (!line.includes("x-google-max-bitrate")) {
        line = `${line};x-google-max-bitrate=${maxVideoBitrateKbps};x-google-start-bitrate=${startBitrate};x-google-min-bitrate=${minBitrate}`;
      }
    }

    out.push(line);

    if (inVideoSection && !addedVideoBandwidth && (line.startsWith("c=IN ") || line.startsWith("m=video"))) {
      const nextLine = lines[i + 1] || "";
      if (!nextLine.startsWith("c=IN ") && !nextLine.startsWith("b=AS:")) {
        out.push(`b=AS:${maxVideoBitrateKbps}`);
        out.push(`b=TIAS:${maxVideoBitrateKbps * 1000}`);
        addedVideoBandwidth = true;
      }
    }
  }

  return out.join("\r\n");
}

function enhancePeerConnectionQuality(pc: RTCPeerConnection | undefined | null, maxVideoBitrateKbps: number, maxFramerate: number) {
  if (!pc) return;
  if (!(pc as any).__sdpEnhanced) {
    (pc as any).__sdpEnhanced = true;
    const origSetLocal = pc.setLocalDescription.bind(pc);
    pc.setLocalDescription = async (desc?: RTCLocalSessionDescriptionInit) => {
      if (desc && desc.sdp) {
        desc = { ...desc, sdp: enhanceSdpQuality(desc.sdp, maxVideoBitrateKbps) };
      }
      return origSetLocal(desc);
    };
  }

  const applyParams = () => {
    try {
      pc.getSenders().forEach((sender) => {
        if (!sender.track) return;
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        if (sender.track.kind === "video") {
          (params as any).degradationPreference = "maintain-resolution";
          params.encodings[0].maxBitrate = maxVideoBitrateKbps * 1000;
          params.encodings[0].maxFramerate = maxFramerate;
          params.encodings[0].scaleResolutionDownBy = 1.0;
          (params.encodings[0] as any).priority = "high";
          (params.encodings[0] as any).networkPriority = "high";
          sender.setParameters(params).catch(() => {});
        } else if (sender.track.kind === "audio") {
          params.encodings[0].maxBitrate = 510000;
          (params.encodings[0] as any).priority = "high";
          (params.encodings[0] as any).networkPriority = "high";
          sender.setParameters(params).catch(() => {});
        }
      });
    } catch {}
  };

  applyParams();
  setTimeout(applyParams, 600);
  setTimeout(applyParams, 2000);
}

// AudioWorklet inline para transformar chunks PCM Float32 48kHz do C++ em MediaStreamTrack contínua e sem engasgos
const WORKLET_PROCESSOR_CODE = `
class NativePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 48000 * 2; // 1s estéreo
    this.ringL = new Float32Array(this.capacity);
    this.ringR = new Float32Array(this.capacity);
    this.writePos = 0;
    this.readPos = 0;
    this.available = 0;

    this.port.onmessage = (e) => {
      const data = e.data;
      if (!data || !data.samples) return;
      const samples = data.samples;
      const channels = data.channels || 2;
      const frames = Math.floor(samples.length / channels);

      // Se acumular mais de ~180ms de atraso, descarta o excesso antigo para manter latência baixa
      const maxBufferedFrames = 48000 * 0.18;
      if (this.available + frames > maxBufferedFrames) {
        const drop = (this.available + frames) - Math.floor(48000 * 0.06);
        if (drop > 0 && drop <= this.available) {
          this.readPos = (this.readPos + drop) % this.capacity;
          this.available -= drop;
        } else {
          this.readPos = 0;
          this.writePos = 0;
          this.available = 0;
        }
      }

      for (let i = 0; i < frames; i++) {
        const l = samples[i * channels] || 0;
        const r = channels > 1 ? (samples[i * channels + 1] || 0) : l;
        this.ringL[this.writePos] = l;
        this.ringR[this.writePos] = r;
        this.writePos = (this.writePos + 1) % this.capacity;
      }
      this.available = Math.min(this.capacity, this.available + frames);
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : null;
    const frameCount = outL.length;

    for (let i = 0; i < frameCount; i++) {
      if (this.available > 0) {
        outL[i] = this.ringL[this.readPos];
        if (outR) outR[i] = this.ringR[this.readPos];
        this.readPos = (this.readPos + 1) % this.capacity;
        this.available--;
      } else {
        outL[i] = 0;
        if (outR) outR[i] = 0;
      }
    }
    return true;
  }
}
registerProcessor("native-pcm-processor", NativePcmProcessor);
`;

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

interface RemoteStreamEntry {
  peerId: string;
  name: string;
  stream: MediaStream;
}

interface StreamItem {
  id: string;
  peerId: string;
  name: string;
  stream: MediaStream;
  isLocal: boolean;
}

interface StreamVideoProps {
  stream: MediaStream;
  muted: boolean;
  volume: number;
  className?: string;
  isRemoteControlActive?: boolean;
  videoRefCallback?: (el: HTMLVideoElement | null) => void;
  onMouseMove?: (e: React.MouseEvent<HTMLVideoElement>) => void;
  onMouseDown?: (e: React.MouseEvent<HTMLVideoElement>) => void;
  onMouseUp?: (e: React.MouseEvent<HTMLVideoElement>) => void;
  onWheel?: (e: React.WheelEvent<HTMLVideoElement>) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLVideoElement>) => void;
  onKeyUp?: (e: React.KeyboardEvent<HTMLVideoElement>) => void;
}

function StreamVideo({
  stream,
  muted,
  volume,
  className = "screen-video",
  isRemoteControlActive = false,
  videoRefCallback,
  onMouseMove,
  onMouseDown,
  onMouseUp,
  onWheel,
  onKeyDown,
  onKeyUp,
}: StreamVideoProps) {
  const internalRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = internalRef.current;
    if (el && el.srcObject !== stream) {
      el.srcObject = stream;
    }
  }, [stream]);

  useEffect(() => {
    const el = internalRef.current;
    if (el) {
      el.volume = Math.max(0, Math.min(1, volume));
    }
  }, [volume]);

  return (
    <video
      ref={(el) => {
        internalRef.current = el;
        if (videoRefCallback) videoRefCallback(el);
      }}
      autoPlay
      playsInline
      muted={muted}
      className={className}
      tabIndex={onKeyDown ? 0 : undefined}
      style={{
        cursor: isRemoteControlActive ? "crosshair" : "default",
        outline: isRemoteControlActive ? "2px solid var(--color-primary)" : "none",
      }}
      onMouseMove={onMouseMove}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      onWheel={onWheel}
      onContextMenu={(e) => {
        if (isRemoteControlActive) e.preventDefault();
      }}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    />
  );
}

export default function RoomView({ roomName, displayName, password, isCreator, onLeave }: RoomViewProps) {
  const cleanRoomName = sanitizeRoomName(roomName);
  const roomSlug = toRoomSlug(cleanRoomName);
  const hostId = `ct-desktop-${roomSlug}-host`;

  const [peer, setPeer] = useState<Peer | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<string>("Inicializando...");
  const [remoteStreams, setRemoteStreams] = useState<Record<string, RemoteStreamEntry>>({});
  const [selectedStreamId, setSelectedStreamId] = useState<string | null>(null);
  const [isGridView, setIsGridView] = useState<boolean>(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  const [isSharing, setIsSharing] = useState(false);
  const [shareError, setShareError] = useState("");
  const [desktopSources, setDesktopSources] = useState<any[]>([]);
  const [copied, setCopied] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);

  const [quality, setQuality] = useState<Quality>("1080p60");
  const [showQuality, setShowQuality] = useState(false);
  const qualityRefState = useRef<Quality>(quality);
  qualityRefState.current = quality;

  const [audioMode, setAudioMode] = useState<AudioMode>("exclude-discord");
  const [showAudioMenu, setShowAudioMenu] = useState(false);

  const [volume, setVolume] = useState(1);
  const [isCameraEnabled, setIsCameraEnabled] = useState(false);

  // Controle Remoto & Gamepad Coop (Desativado por padrão - quem compartilha deve aceitar)
  const [showRemoteMenu, setShowRemoteMenu] = useState(false);
  const [showGamepadModal, setShowGamepadModal] = useState(false);
  const [allowRemoteInput, setAllowRemoteInput] = useState(false); // Desativado por padrão!
  const [allowGamepadCoop, setAllowGamepadCoop] = useState(false); // Desativado por padrão!
  const [connectedVirtualGamepadsCount, setConnectedVirtualGamepadsCount] = useState(0);
  const [isRemoteControlActive, setIsRemoteControlActive] = useState(false);
  const [isGamepadPermitted, setIsGamepadPermitted] = useState(false);

  // Pedidos de permissão
  interface RemoteControlRequest {
    peerId: string;
    name: string;
    type: "gamepad" | "mouse_keyboard";
  }
  const [pendingRequest, setPendingRequest] = useState<RemoteControlRequest | null>(null);
  const [requestStatusMsg, setRequestStatusMsg] = useState<string>("");

  const remoteMenuRef = useRef<HTMLDivElement>(null);
  const allowRemoteInputRef = useRef(allowRemoteInput);
  allowRemoteInputRef.current = allowRemoteInput;
  const allowGamepadCoopRef = useRef(allowGamepadCoop);
  allowGamepadCoopRef.current = allowGamepadCoop;

  const connectedVirtualGamepadsRef = useRef<Set<number>>(new Set());
  const peerGamepadSlotsRef = useRef<Map<string, number>>(new Map());
  const lastMouseMoveSentRef = useRef<number>(0);
  const viewerDataConnRef = useRef<any>(null);

  const getOrAssignGamepadSlot = useCallback((peerId: string): number => {
    const existing = peerGamepadSlotsRef.current.get(peerId);
    if (existing !== undefined) return existing;
    const used = new Set(peerGamepadSlotsRef.current.values());
    let slot = 0;
    while (used.has(slot) && slot < 4) slot++;
    peerGamepadSlotsRef.current.set(peerId, slot);
    return slot;
  }, []);

  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const qualityRef = useRef<HTMLDivElement>(null);
  const audioMenuRef = useRef<HTMLDivElement>(null);

  const dummyStreamRef = useRef<MediaStream | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const fallbackSystemAudioTrackRef = useRef<MediaStreamTrack | null>(null);
  const nativeAudioCtxRef = useRef<AudioContext | null>(null);
  const selectedSourceIdRef = useRef<string | null>(null);

  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, 640, 360);
      }
      const videoTrack = canvas.captureStream(1).getVideoTracks()[0];
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioCtx();
      const dest = audioCtx.createMediaStreamDestination();
      const audioTrack = dest.stream.getAudioTracks()[0];
      dummyStreamRef.current = new MediaStream([videoTrack, audioTrack]);
    }
  }, []);

  const dataConnectionsRef = useRef<Map<string, any>>(new Map());
  const mediaCallsRef = useRef<Set<any>>(new Set());
  const outgoingCallsRef = useRef<Map<string, any>>(new Map());
  const participantsRef = useRef<Participant[]>([]);

  // Timer
  const [timeActive, setTimeActive] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTimeActive((t) => t + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  const formatTime = (s: number) => {
    const h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60),
      sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  // Fecha menus ao clicar fora
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (qualityRef.current && !qualityRef.current.contains(e.target as Node)) setShowQuality(false);
      if (audioMenuRef.current && !audioMenuRef.current.contains(e.target as Node)) setShowAudioMenu(false);
      if (remoteMenuRef.current && !remoteMenuRef.current.contains(e.target as Node)) setShowRemoteMenu(false);
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

  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  // Registra/atualiza a sala no RoomRegistry (lista lateral de salas abertas a cada 5s + tempo real)
  useEffect(() => {
    if (!isCreator) return;
    roomRegistry.registerHostedRoom({
      name: cleanRoomName,
      hostName: displayName,
      numParticipants: Math.max(1, participants.length),
      hasPassword: Boolean(password && password.trim()),
      passwordHash: hashPassword(password),
      isSharing,
    });
  }, [isCreator, cleanRoomName, displayName, participants.length, password, isSharing]);

  useEffect(() => {
    return () => {
      if (isCreator) {
        roomRegistry.unregisterHostedRoom();
      }
    };
  }, [isCreator]);

  const broadcastParticipants = useCallback(() => {
    const data = { type: "sync_participants", participants: participantsRef.current };
    dataConnectionsRef.current.forEach((conn) => {
      if (conn.open) conn.send(data);
    });
  }, []);

  // Substitui tracks em todas as conexões P2P ativas (tanto de entrada quanto de saída)
  const replaceTracksForViewers = useCallback((stream: MediaStream) => {
    const q = QUALITY_CONSTRAINTS[qualityRefState.current];
    const updateCall = (call: any) => {
      if (call && call.peerConnection) {
        enhancePeerConnectionQuality(call.peerConnection, q.maxBitrateKbps, q.frameRate);
        const senders = call.peerConnection.getSenders();
        stream.getTracks().forEach((track) => {
          const sender = senders.find((s: any) => s.track && s.track.kind === track.kind);
          if (sender) {
            sender.replaceTrack(track).catch(() => {});
          } else {
            try {
              call.peerConnection.addTrack(track, stream);
            } catch {}
          }
        });
      }
    };
    mediaCallsRef.current.forEach(updateCall);
    outgoingCallsRef.current.forEach(updateCall);
  }, []);

  // Envia mensagem P2P para um participante específico (direto se anfitrião, ou via relay do anfitrião se convidado)
  const sendToPeer = useCallback(
    (targetPeerId: string, payload: any) => {
      if (!targetPeerId) return;
      const msg = { ...payload, fromPeerId: peer?.id, fromName: displayName };
      if (isCreator) {
        const conn = dataConnectionsRef.current.get(targetPeerId);
        if (conn && conn.open) {
          try {
            conn.send(msg);
          } catch {}
        }
      } else {
        const conn = viewerDataConnRef.current;
        if (conn && conn.open) {
          try {
            if (targetPeerId === hostId) {
              conn.send(msg);
            } else {
              conn.send({ type: "relay_to_peer", targetPeerId, payload: msg });
            }
          } catch {}
        }
      }
    },
    [isCreator, peer?.id, displayName, hostId]
  );

  // Processa pacotes de controle remoto/coop recebidos de qualquer participante
  const handleRemoteControlData = useCallback(
    (senderId: string, data: any) => {
      const effectiveSender = data.fromPeerId || senderId;

      if (data.type === "request_remote_permission") {
        const subType = data.subType || "mouse_keyboard";
        // Se o dono do PC já deixou a chave correspondente Ativada manualmente, aprova direto
        if (
          (subType === "mouse_keyboard" && allowRemoteInputRef.current) ||
          (subType === "gamepad" && allowGamepadCoopRef.current)
        ) {
          if (subType === "gamepad" && window.electronAPI?.virtualGamepadConnect) {
            const slot = getOrAssignGamepadSlot(effectiveSender);
            if (!connectedVirtualGamepadsRef.current.has(slot)) {
              window.electronAPI.virtualGamepadConnect(slot);
              connectedVirtualGamepadsRef.current.add(slot);
              setConnectedVirtualGamepadsCount(connectedVirtualGamepadsRef.current.size);
            }
          }
          sendToPeer(effectiveSender, {
            type: "remote_permission_response",
            accepted: true,
            subType,
          });
          return;
        }

        setPendingRequest({
          peerId: effectiveSender,
          name: data.name || data.fromName || "Participante",
          type: subType,
        });
        return;
      }

      if (data.type === "remote_permission_response") {
        if (data.accepted) {
          if (data.subType === "mouse_keyboard") {
            setIsRemoteControlActive(true);
            setTimeout(() => remoteVideoRef.current?.focus(), 100);
            setRequestStatusMsg("✓ Acesso aceito! Modo jogo ativado.");
          } else if (data.subType === "gamepad") {
            setIsGamepadPermitted(true);
            setRequestStatusMsg("✓ Acesso aceito! Seu controle de Xbox (Player 2) está ativo.");
          }
        } else {
          if (data.subType === "mouse_keyboard") {
            setIsRemoteControlActive(false);
          } else if (data.subType === "gamepad") {
            setIsGamepadPermitted(false);
          }
          setRequestStatusMsg(data.revoked ? "Acesso remoto encerrado pelo anfitrião." : "✕ Solicitação de acesso recusada.");
        }
        setTimeout(() => setRequestStatusMsg(""), 4500);
        return;
      }

      if (data.type === "input_mouse") {
        if (allowRemoteInputRef.current && window.electronAPI?.sendMouseInput) {
          window.electronAPI.sendMouseInput(data.mouseEvent);
        }
      } else if (data.type === "input_keyboard") {
        if (allowRemoteInputRef.current && window.electronAPI?.sendKeyboardInput) {
          window.electronAPI.sendKeyboardInput(data.keyEvent);
        }
      } else if (data.type === "input_gamepad") {
        if (allowGamepadCoopRef.current && window.electronAPI?.virtualGamepadUpdate) {
          const pIdx = getOrAssignGamepadSlot(effectiveSender);
          if (!connectedVirtualGamepadsRef.current.has(pIdx)) {
            window.electronAPI.virtualGamepadConnect(pIdx);
            connectedVirtualGamepadsRef.current.add(pIdx);
            setConnectedVirtualGamepadsCount(connectedVirtualGamepadsRef.current.size);
          }
          window.electronAPI.virtualGamepadUpdate(pIdx, data.state);
        }
      } else if (data.type === "input_gamepad_disconnect") {
        const pIdx = peerGamepadSlotsRef.current.get(effectiveSender);
        if (pIdx !== undefined && connectedVirtualGamepadsRef.current.has(pIdx)) {
          window.electronAPI?.virtualGamepadDisconnect?.(pIdx);
          connectedVirtualGamepadsRef.current.delete(pIdx);
          peerGamepadSlotsRef.current.delete(effectiveSender);
          setConnectedVirtualGamepadsCount(connectedVirtualGamepadsRef.current.size);
        }
      }
    },
    [getOrAssignGamepadSlot, sendToPeer]
  );

  // PeerJS Setup
  useEffect(() => {
    const myId = isCreator ? hostId : undefined;
    const expectedHash = hashPassword(password);

    setConnectionStatus("Conectando ao servidor...");
    const newPeer = new Peer(myId as string, { debug: 1 });

    newPeer.on("open", (id) => {
      setConnectionStatus(
        isCreator ? "Sala criada. Pronto para transmitir." : "Conectado à sala."
      );

      const me: Participant = { id, name: displayName, isLocal: true, isSharing: false };
      setParticipants([me]);

      if (!isCreator) {
        const dataConn = newPeer.connect(hostId, {
          metadata: { name: displayName, passwordHash: expectedHash },
        });
        viewerDataConnRef.current = dataConn;

        dataConn.on("data", (data: any) => {
          if (!data || !data.type) return;

          if (data.type === "auth_error") {
            setShareError(data.message || "Senha incorreta.");
            setTimeout(onLeave, 1200);
            return;
          }
          if (data.type === "sync_participants") {
            const synced: Participant[] = data.participants.map((p: Participant) => ({
              ...p,
              isLocal: p.id === id,
            }));
            setParticipants(synced);
            // Remove streams de quem parou de compartilhar ou saiu da sala
            setRemoteStreams((prev) => {
              let changed = false;
              const next = { ...prev };
              Object.keys(next).forEach((pid) => {
                const part = synced.find((sp) => sp.id === pid);
                if (!part || !part.isSharing) {
                  delete next[pid];
                  changed = true;
                }
              });
              return changed ? next : prev;
            });
            return;
          }
          if (data.type === "share_stopped") {
            const stoppedId = data.peerId || hostId;
            setRemoteStreams((prev) => {
              if (!prev[stoppedId]) return prev;
              const next = { ...prev };
              delete next[stoppedId];
              return next;
            });
            setConnectionStatus("Uma transmissão foi encerrada.");
            return;
          }

          handleRemoteControlData(data.fromPeerId || hostId, data);
        });
      }
    });

    if (isCreator) {
      newPeer.on("connection", (conn: any) => {
        conn.on("open", () => {
          if (expectedHash && conn.metadata?.passwordHash !== expectedHash) {
            try {
              conn.send({ type: "auth_error", message: "Senha da sala incorreta." });
              setTimeout(() => conn.close(), 300);
            } catch {}
            return;
          }

          dataConnectionsRef.current.set(conn.peer, conn);
          const newParticipant: Participant = {
            id: conn.peer,
            name: conn.metadata?.name || "Participante",
            isLocal: false,
            isSharing: false,
          };
          setParticipants((prev) => [...prev.filter((p) => p.id !== conn.peer), newParticipant]);
          setTimeout(broadcastParticipants, 250);

          conn.on("data", (data: any) => {
            if (!data || !data.type) return;

            // Relay de mensagens entre dois participantes da sala
            if (data.type === "relay_to_peer" && data.targetPeerId && data.payload) {
              const targetConn = dataConnectionsRef.current.get(data.targetPeerId);
              if (targetConn && targetConn.open) {
                try {
                  targetConn.send({ ...data.payload, fromPeerId: conn.peer });
                } catch {}
              }
              return;
            }

            // Atualização de estado de transmissão de qualquer participante
            if (data.type === "update_sharing_state") {
              const sharingFlag = Boolean(data.isSharing);
              setParticipants((prev) =>
                prev.map((p) => (p.id === conn.peer ? { ...p, isSharing: sharingFlag } : p))
              );
              if (!sharingFlag) {
                setRemoteStreams((prev) => {
                  if (!prev[conn.peer]) return prev;
                  const next = { ...prev };
                  delete next[conn.peer];
                  return next;
                });
              }
              setTimeout(broadcastParticipants, 100);
              return;
            }

            if (data.type === "share_stopped") {
              const stoppedId = data.peerId || conn.peer;
              setRemoteStreams((prev) => {
                if (!prev[stoppedId]) return prev;
                const next = { ...prev };
                delete next[stoppedId];
                return next;
              });
              setParticipants((prev) =>
                prev.map((p) => (p.id === stoppedId ? { ...p, isSharing: false } : p))
              );
              dataConnectionsRef.current.forEach((c, pid) => {
                if (pid !== stoppedId && c && c.open) {
                  try {
                    c.send({ type: "share_stopped", peerId: stoppedId });
                  } catch {}
                }
              });
              setTimeout(broadcastParticipants, 100);
              return;
            }

            handleRemoteControlData(conn.peer, data);
          });
        });

        conn.on("close", () => {
          dataConnectionsRef.current.delete(conn.peer);
          outgoingCallsRef.current.delete(conn.peer);
          setRemoteStreams((prev) => {
            if (!prev[conn.peer]) return prev;
            const next = { ...prev };
            delete next[conn.peer];
            return next;
          });
          setParticipants((prev) => prev.filter((p) => p.id !== conn.peer));
          dataConnectionsRef.current.forEach((c) => {
            if (c && c.open) {
              try {
                c.send({ type: "share_stopped", peerId: conn.peer });
              } catch {}
            }
          });
          setTimeout(broadcastParticipants, 250);
        });
      });
    }

    // Qualquer participante na sala pode receber chamadas de vídeo de quem estiver compartilhando a tela
    newPeer.on("call", (call: any) => {
      if (isCreator && expectedHash && call.metadata?.passwordHash && call.metadata.passwordHash !== expectedHash) {
        call.close();
        return;
      }

      const q = QUALITY_CONSTRAINTS[qualityRefState.current];
      mediaCallsRef.current.add(call);
      call.on("close", () => {
        mediaCallsRef.current.delete(call);
      });

      if (!call.metadata?.sharerId && isCreator) {
        call.answer(localStreamRef.current || dummyStreamRef.current || new MediaStream());
      } else {
        call.answer();
      }
      enhancePeerConnectionQuality(call.peerConnection, q.maxBitrateKbps, q.frameRate);

      call.on("stream", (stream: MediaStream) => {
        if (!stream || stream.getVideoTracks().length === 0) return;
        const sharerId = call.metadata?.sharerId || call.peer;
        const knownParticipant = participantsRef.current.find((p) => p.id === sharerId);
        const sharerName =
          call.metadata?.sharerName || knownParticipant?.name || "Participante";

        setRemoteStreams((prev) => ({
          ...prev,
          [sharerId]: {
            peerId: sharerId,
            name: sharerName,
            stream,
          },
        }));
        setSelectedStreamId((curr) => (curr === null || curr === "local" ? sharerId : curr));
        setConnectionStatus("Assistindo transmissão");
      });
    });

    newPeer.on("error", (err) => {
      console.error("PeerJS Error:", err);
      setConnectionStatus("Erro: " + err.message);
    });

    setPeer(newPeer);
    return () => {
      mediaCallsRef.current.clear();
      outgoingCallsRef.current.forEach((c) => {
        try {
          c.close();
        } catch {}
      });
      outgoingCallsRef.current.clear();
      connectedVirtualGamepadsRef.current.forEach((pIdx) => {
        window.electronAPI?.virtualGamepadDisconnect?.(pIdx);
      });
      connectedVirtualGamepadsRef.current.clear();
      newPeer.destroy();
    };
  }, [roomSlug, hostId, isCreator, displayName, password, broadcastParticipants, handleRemoteControlData, onLeave]);

  // Atualiza a flag isSharing de quem estiver transmitindo (anfitrião ou participante)
  useEffect(() => {
    setParticipants((prev) => prev.map((p) => (p.isLocal ? { ...p, isSharing } : p)));
    if (isCreator) {
      setTimeout(broadcastParticipants, 150);
    } else if (viewerDataConnRef.current?.open) {
      try {
        viewerDataConnRef.current.send({
          type: "update_sharing_state",
          isSharing,
          name: displayName,
        });
      } catch {}
    }
  }, [isSharing, isCreator, displayName, broadcastParticipants]);

  // Quando EU estou compartilhando a tela, envio minha stream (em alta qualidade sem compressão) para todos os participantes da sala
  useEffect(() => {
    if (!peer || !isSharing || !localStream) return;
    const q = QUALITY_CONSTRAINTS[qualityRefState.current];
    const expectedHash = hashPassword(password);

    participants.forEach((p) => {
      if (p.isLocal || !p.id || p.id === peer.id) return;
      const existingCall = outgoingCallsRef.current.get(p.id);
      if (existingCall && existingCall.peerConnection && existingCall.peerConnection.connectionState !== "closed") {
        // Já existe chamada ativa: garante que as tracks atuais estão nela
        enhancePeerConnectionQuality(existingCall.peerConnection, q.maxBitrateKbps, q.frameRate);
        const senders = existingCall.peerConnection.getSenders();
        localStream.getTracks().forEach((track) => {
          const sender = senders.find((s: any) => s.track && s.track.kind === track.kind);
          if (sender) {
            sender.replaceTrack(track).catch(() => {});
          } else {
            try {
              existingCall.peerConnection.addTrack(track, localStream);
            } catch {}
          }
        });
      } else {
        try {
          const call = peer.call(p.id, localStream, {
            metadata: {
              sharerId: peer.id,
              sharerName: displayName,
              passwordHash: expectedHash,
            },
          });
          if (call) {
            outgoingCallsRef.current.set(p.id, call);
            enhancePeerConnectionQuality(call.peerConnection, q.maxBitrateKbps, q.frameRate);
            call.on("close", () => {
              if (outgoingCallsRef.current.get(p.id) === call) {
                outgoingCallsRef.current.delete(p.id);
              }
            });
            call.on("error", () => {
              if (outgoingCallsRef.current.get(p.id) === call) {
                outgoingCallsRef.current.delete(p.id);
              }
            });
          }
        } catch (err) {
          console.warn("Falha ao chamar participante:", p.id, err);
        }
      }
    });
  }, [participants, localStream, isSharing, peer, displayName, password]);

  const stopNativeAudioPipeline = useCallback(async () => {
    try {
      await window.electronAPI?.stopNativeAudio?.();
    } catch {}
    if (nativeAudioCtxRef.current) {
      try {
        await nativeAudioCtxRef.current.close();
      } catch {}
      nativeAudioCtxRef.current = null;
    }
  }, []);

  // Inicia o pipeline C++ Process Loopback (48kHz Float32 Stereo puro via AudioWorklet de baixa latência)
  const buildCleanAudioTrack = useCallback(
    async (mode: AudioMode): Promise<MediaStreamTrack | null> => {
      await stopNativeAudioPipeline();

      if (!window.electronAPI?.startNativeAudio) {
        return null;
      }

      try {
        let windowHandle = 0;
        const srcId = selectedSourceIdRef.current || "";
        if (srcId.startsWith("window:")) {
          const parsed = parseInt(srcId.split(":")[1], 10);
          if (!isNaN(parsed)) windowHandle = parsed;
        }

        const effectiveMode = mode === "window-only" && windowHandle === 0 ? "exclude-discord" : mode;

        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        const audioCtx: AudioContext = new AudioCtx({ sampleRate: 48000, latencyHint: "interactive" });
        nativeAudioCtxRef.current = audioCtx;

        const dest = audioCtx.createMediaStreamDestination();
        dest.channelCount = 2;
        dest.channelCountMode = "explicit";
        dest.channelInterpretation = "speakers";

        let pushSamplesToAudioNode: (samples: Float32Array, channels: number) => void;

        // Tenta usar AudioWorklet (thread de áudio dedicada, zero engasgo de UI) com fallback para ScriptProcessor
        let workletLoaded = false;
        if (audioCtx.audioWorklet) {
          try {
            const blob = new Blob([WORKLET_PROCESSOR_CODE], { type: "application/javascript" });
            const url = URL.createObjectURL(blob);
            await audioCtx.audioWorklet.addModule(url);
            URL.revokeObjectURL(url);
            const workletNode = new AudioWorkletNode(audioCtx, "native-pcm-processor", {
              numberOfInputs: 0,
              numberOfOutputs: 1,
              outputChannelCount: [2],
            });
            workletNode.connect(dest);
            pushSamplesToAudioNode = (samples: Float32Array, channels: number) => {
              workletNode.port.postMessage({ samples, channels });
            };
            workletLoaded = true;
          } catch (err) {
            console.warn("[NativeAudio] AudioWorklet fallback para ScriptProcessor:", err);
          }
        }

        if (!workletLoaded) {
          const capacity = 48000 * 2;
          const ringL = new Float32Array(capacity);
          const ringR = new Float32Array(capacity);
          let writePos = 0;
          let readPos = 0;
          let available = 0;

          const scriptNode = audioCtx.createScriptProcessor(512, 1, 2);
          scriptNode.onaudioprocess = (audioProcessingEvent) => {
            const outputBuffer = audioProcessingEvent.outputBuffer;
            const outL = outputBuffer.getChannelData(0);
            const outR = outputBuffer.numberOfChannels > 1 ? outputBuffer.getChannelData(1) : null;
            const frameCount = outL.length;

            for (let i = 0; i < frameCount; i++) {
              if (available > 0) {
                outL[i] = ringL[readPos];
                if (outR) outR[i] = ringR[readPos];
                readPos = (readPos + 1) % capacity;
                available--;
              } else {
                outL[i] = 0;
                if (outR) outR[i] = 0;
              }
            }
          };

          const osc = audioCtx.createOscillator();
          const silentGain = audioCtx.createGain();
          silentGain.gain.value = 0;
          osc.connect(silentGain);
          silentGain.connect(scriptNode);
          osc.start();
          scriptNode.connect(dest);

          pushSamplesToAudioNode = (samples: Float32Array, channels: number) => {
            const ch = channels || 2;
            const frames = Math.floor(samples.length / ch);
            const maxBufferedFrames = 48000 * 0.18;
            if (available + frames > maxBufferedFrames) {
              const drop = available + frames - Math.floor(48000 * 0.06);
              if (drop > 0 && drop <= available) {
                readPos = (readPos + drop) % capacity;
                available -= drop;
              } else {
                readPos = 0;
                writePos = 0;
                available = 0;
              }
            }

            for (let i = 0; i < frames; i++) {
              const l = samples[i * ch] || 0;
              const r = ch > 1 ? samples[i * ch + 1] || 0 : l;
              ringL[writePos] = l;
              ringR[writePos] = r;
              writePos = (writePos + 1) % capacity;
            }
            available = Math.min(capacity, available + frames);
          };
        }

        if (audioCtx.state === "suspended") {
          await audioCtx.resume();
        }

        window.electronAPI.onNativeAudioChunk((buffer, channels, _sampleRate, bitsPerSample) => {
          if (!buffer || buffer.byteLength === 0) return;

          if (bitsPerSample === 32) {
            const aligned = new Uint8Array(buffer.byteLength);
            aligned.set(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
            const floatSamples = new Float32Array(aligned.buffer);
            pushSamplesToAudioNode(floatSamples, channels);
          } else if (bitsPerSample === 16) {
            const aligned = new Uint8Array(buffer.byteLength);
            aligned.set(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
            const int16 = new Int16Array(aligned.buffer);
            const floatSamples = new Float32Array(int16.length);
            for (let i = 0; i < int16.length; i++) {
              floatSamples[i] = int16[i] / 32768.0;
            }
            pushSamplesToAudioNode(floatSamples, channels);
          }
        });

        const status = await window.electronAPI.startNativeAudio({
          mode: effectiveMode,
          windowHandle,
        });

        console.log("[NativeAudio] Mode:", effectiveMode, "Status:", status);

        if (typeof status === "string" && status.startsWith("OK:")) {
          const track = dest.stream.getAudioTracks()[0];
          if (track && track.applyConstraints) {
            track
              .applyConstraints({
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                channelCount: 2,
                sampleRate: 48000,
              } as any)
              .catch(() => {});
          }
          return track;
        }

        await stopNativeAudioPipeline();
        return null;
      } catch (e) {
        console.warn("Erro no pipeline de áudio nativo:", e);
        await stopNativeAudioPipeline();
        return null;
      }
    },
    [stopNativeAudioPipeline]
  );

  const handleStartShare = async () => {
    setShareError("");
    try {
      const q = QUALITY_CONSTRAINTS[quality];
      let rawStream: MediaStream;

      if (window.electronAPI) {
        rawStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: q.width, max: q.width },
            height: { ideal: q.height, max: q.height },
            frameRate: { ideal: q.frameRate, max: q.frameRate },
          },
          audio: false, // O áudio é capturado 100% pelo módulo C++ nativo sem filtros DSP!
        });
      } else {
        rawStream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: q.width, height: q.height, frameRate: q.frameRate },
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 2,
            sampleRate: 48000,
          } as any,
        });
      }

      const videoTrack = rawStream.getVideoTracks()[0];
      const activeAudioTrack = await buildCleanAudioTrack(audioMode);

      const composedTracks: MediaStreamTrack[] = [videoTrack];
      if (activeAudioTrack) composedTracks.push(activeAudioTrack);
      const finalStream = new MediaStream(composedTracks);

      setLocalStream(finalStream);
      setIsSharing(true);
      setSelectedStreamId((curr) => curr || "local");

      videoTrack.onended = () => {
        handleStopShare();
      };
    } catch (err: any) {
      if (err?.name !== "NotAllowedError") {
        setShareError("Erro ao iniciar: " + (err?.message || "desconhecido"));
      }
    }
  };

  // Alterna o modo de áudio ao vivo com 1 clique (Anti-eco vs Tudo) sem reiniciar a transmissão
  const handleToggleDiscordAudio = async () => {
    const nextMode: AudioMode = audioMode === "exclude-discord" ? "all" : "exclude-discord";
    setAudioMode(nextMode);

    if (isSharing && localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      const newAudioTrack = await buildCleanAudioTrack(nextMode);
      if (videoTrack) {
        const tracks: MediaStreamTrack[] = [videoTrack];
        if (newAudioTrack) tracks.push(newAudioTrack);
        const updatedStream = new MediaStream(tracks);
        setLocalStream(updatedStream);
        replaceTracksForViewers(updatedStream);
      }
    }
  };

  const handleStopShare = useCallback(() => {
    stopNativeAudioPipeline();
    if (fallbackSystemAudioTrackRef.current) {
      try {
        fallbackSystemAudioTrackRef.current.stop();
      } catch {}
      fallbackSystemAudioTrackRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
    }
    setLocalStream(null);
    setIsSharing(false);

    // Fecha chamadas de saída que este participante iniciou
    outgoingCallsRef.current.forEach((call) => {
      try {
        call.close();
      } catch {}
    });
    outgoingCallsRef.current.clear();

    // Se havia chamadas legadas, substitui pela dummyStream
    if (dummyStreamRef.current) {
      replaceTracksForViewers(dummyStreamRef.current);
    }

    const myPeerId = peer?.id || (isCreator ? hostId : "");

    // Notifica todos na sala que nossa transmissão parou
    if (isCreator) {
      dataConnectionsRef.current.forEach((conn) => {
        if (conn && conn.open) {
          try {
            conn.send({ type: "share_stopped", peerId: myPeerId });
          } catch {}
        }
      });
    } else if (viewerDataConnRef.current?.open) {
      try {
        viewerDataConnRef.current.send({ type: "share_stopped", peerId: myPeerId });
        viewerDataConnRef.current.send({ type: "update_sharing_state", isSharing: false });
      } catch {}
    }

    // Desconecta quaisquer gamepads virtuais ativos
    connectedVirtualGamepadsRef.current.forEach((pIdx) => {
      window.electronAPI?.virtualGamepadDisconnect?.(pIdx);
    });
    connectedVirtualGamepadsRef.current.clear();
    setConnectedVirtualGamepadsCount(0);
  }, [stopNativeAudioPipeline, replaceTracksForViewers, peer?.id, isCreator, hostId]);

  // Lista unificada de todas as transmissões ativas na sala (remotas primeiro, depois a local)
  const remoteStreamList = Object.values(remoteStreams);
  const allStreams: StreamItem[] = [
    ...remoteStreamList.map((r) => ({
      id: r.peerId,
      peerId: r.peerId,
      name: r.name,
      stream: r.stream,
      isLocal: false,
    })),
    ...(isSharing && localStream
      ? [
          {
            id: "local",
            peerId: peer?.id || "local",
            name: `${displayName} (Sua tela)`,
            stream: localStream,
            isLocal: true,
          },
        ]
      : []),
  ];

  const focusedStream: StreamItem | null =
    allStreams.find((s) => s.id === selectedStreamId) || allStreams[0] || null;

  // Destino atual dos inputs remotos (quem é dono da tela que estamos assistindo no momento)
  const activeRemoteTargetId =
    focusedStream && !focusedStream.isLocal
      ? focusedStream.peerId
      : remoteStreamList[0]?.peerId || (!isCreator ? hostId : "");

  const activeRemoteTargetRef = useRef(activeRemoteTargetId);
  activeRemoteTargetRef.current = activeRemoteTargetId;

  // Loop de Gamepad (captura controle físico USB/Bluetooth e transmite para o dono da tela assistida)
  useEffect(() => {
    let animFrame: number;
    let lastState: VirtualGamepadState | null = null;
    let wasConnected = false;

    const poll = () => {
      const targetId = activeRemoteTargetRef.current;
      if (targetId && isGamepadPermitted) {
        const gamepads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
        let activePad: Gamepad | null = null;
        for (let i = 0; i < gamepads.length; i++) {
          if (gamepads[i]) {
            activePad = gamepads[i];
            break;
          }
        }

        if (activePad) {
          wasConnected = true;
          const config = loadGamepadConfig();
          const currentSample = sampleGamepad(activePad, config);

          if (isGamepadStateDifferent(lastState, currentSample)) {
            lastState = currentSample;
            sendToPeer(targetId, {
              type: "input_gamepad",
              playerIndex: 0,
              state: currentSample,
            });
          }
        } else if (wasConnected) {
          wasConnected = false;
          lastState = null;
          sendToPeer(targetId, {
            type: "input_gamepad_disconnect",
            playerIndex: 0,
          });
        }
      }

      animFrame = requestAnimationFrame(poll);
    };

    animFrame = requestAnimationFrame(poll);
    return () => {
      cancelAnimationFrame(animFrame);
      if (wasConnected && activeRemoteTargetRef.current) {
        sendToPeer(activeRemoteTargetRef.current, {
          type: "input_gamepad_disconnect",
          playerIndex: 0,
        });
      }
    };
  }, [isGamepadPermitted, sendToPeer]);

  // Calcula coordenadas exatas (0.0 a 1.0) descontando barras pretas do object-fit: contain
  const getNormalizedVideoCoords = (e: React.MouseEvent<HTMLVideoElement>): { x: number; y: number } | null => {
    const video = e.currentTarget;
    const rect = video.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    let renderWidth = rect.width;
    let renderHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (video.videoWidth > 0 && video.videoHeight > 0) {
      const videoRatio = video.videoWidth / video.videoHeight;
      const elemRatio = rect.width / rect.height;
      if (elemRatio > videoRatio) {
        // Barras pretas nas laterais (pillarbox)
        renderWidth = rect.height * videoRatio;
        offsetX = (rect.width - renderWidth) / 2;
      } else {
        // Barras pretas em cima e embaixo (letterbox)
        renderHeight = rect.width / videoRatio;
        offsetY = (rect.height - renderHeight) / 2;
      }
    }

    const x = Math.max(0, Math.min(1, (e.clientX - rect.left - offsetX) / renderWidth));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top - offsetY) / renderHeight));
    return { x, y };
  };

  // Handlers de Mouse e Teclado para enviar ao dono da tela assistida
  const handleVideoMouseMove = (e: React.MouseEvent<HTMLVideoElement>) => {
    if (!isRemoteControlActive || !activeRemoteTargetId) return;
    const now = performance.now();
    if (now - lastMouseMoveSentRef.current < 8) return; // Limita a ~120Hz para não congestionar o DataChannel
    lastMouseMoveSentRef.current = now;

    const coords = getNormalizedVideoCoords(e);
    if (!coords) return;
    sendToPeer(activeRemoteTargetId, {
      type: "input_mouse",
      mouseEvent: { type: "move", x: coords.x, y: coords.y },
    });
  };

  const handleVideoMouseDown = (e: React.MouseEvent<HTMLVideoElement>) => {
    if (!isRemoteControlActive || !activeRemoteTargetId) return;
    e.currentTarget.focus();
    const coords = getNormalizedVideoCoords(e);
    if (coords) {
      sendToPeer(activeRemoteTargetId, {
        type: "input_mouse",
        mouseEvent: { type: "move", x: coords.x, y: coords.y },
      });
    }
    sendToPeer(activeRemoteTargetId, {
      type: "input_mouse",
      mouseEvent: { type: "down", button: e.button },
    });
  };

  const handleVideoMouseUp = (e: React.MouseEvent<HTMLVideoElement>) => {
    if (!isRemoteControlActive || !activeRemoteTargetId) return;
    sendToPeer(activeRemoteTargetId, {
      type: "input_mouse",
      mouseEvent: { type: "up", button: e.button },
    });
  };

  const handleVideoWheel = (e: React.WheelEvent<HTMLVideoElement>) => {
    if (!isRemoteControlActive || !activeRemoteTargetId) return;
    sendToPeer(activeRemoteTargetId, {
      type: "input_mouse",
      mouseEvent: { type: "wheel", deltaY: Math.sign(e.deltaY) },
    });
  };

  const handleVideoKeyDown = (e: React.KeyboardEvent<HTMLVideoElement>) => {
    if (!isRemoteControlActive || !activeRemoteTargetId) return;
    if (e.key === "Escape") {
      setIsRemoteControlActive(false);
      return;
    }
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].includes(e.code)) {
      e.preventDefault();
    }
    sendToPeer(activeRemoteTargetId, {
      type: "input_keyboard",
      keyEvent: { type: "down", vk: e.keyCode || e.which },
    });
  };

  const handleVideoKeyUp = (e: React.KeyboardEvent<HTMLVideoElement>) => {
    if (!isRemoteControlActive || !activeRemoteTargetId) return;
    sendToPeer(activeRemoteTargetId, {
      type: "input_keyboard",
      keyEvent: { type: "up", vk: e.keyCode || e.which },
    });
  };

  useEffect(() => {
    return () => {
      stopNativeAudioPipeline();
    };
  }, [stopNativeAudioPipeline]);

  const handleLeaveRoom = () => {
    handleStopShare();
    if (isCreator) {
      roomRegistry.unregisterHostedRoom();
    }
    onLeave();
  };

  const toggleFullscreen = () => {
    const el = document.querySelector(".screen-wrap") || document.querySelector(".streams-grid");
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen().catch((err) => console.error(err));
    } else {
      document.exitFullscreen();
    }
  };

  const toggleCamera = () => {
    setIsCameraEnabled(!isCameraEnabled);
  };

  const viewerUrl = `${API_URL}?sala=${encodeURIComponent(roomSlug)}`;

  const handleCopyLink = async () => {
    await copyToClipboard(`${cleanRoomName}\n${viewerUrl}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const sharingParticipantsCount = participants.filter((p) => p.isSharing).length;

  const handleAcceptPermission = useCallback(() => {
    if (!pendingRequest) return;
    if (pendingRequest.type === "mouse_keyboard") {
      setAllowRemoteInput(true);
    } else if (pendingRequest.type === "gamepad") {
      setAllowGamepadCoop(true);
      if (window.electronAPI?.virtualGamepadConnect) {
        const slot = getOrAssignGamepadSlot(pendingRequest.peerId);
        if (!connectedVirtualGamepadsRef.current.has(slot)) {
          window.electronAPI.virtualGamepadConnect(slot);
          connectedVirtualGamepadsRef.current.add(slot);
          setConnectedVirtualGamepadsCount(connectedVirtualGamepadsRef.current.size);
        }
      }
    }
    sendToPeer(pendingRequest.peerId, {
      type: "remote_permission_response",
      accepted: true,
      subType: pendingRequest.type,
    });
    setPendingRequest(null);
  }, [pendingRequest, sendToPeer, getOrAssignGamepadSlot]);

  const handleRejectPermission = useCallback(() => {
    if (!pendingRequest) return;
    sendToPeer(pendingRequest.peerId, {
      type: "remote_permission_response",
      accepted: false,
      subType: pendingRequest.type,
    });
    setPendingRequest(null);
  }, [pendingRequest, sendToPeer]);

  return (
    <div className="room-layout">
      {/* Notificação flutuante para aprovar/recusar controle no seu PC */}
      {pendingRequest && (
        <div className="remote-request-toast animate-scale-in">
          <div className="remote-request-header">
            <GamepadIcon size={16} />
            <span>Solicitação de Acesso Remoto</span>
          </div>
          <div className="remote-request-body">
            <strong>{pendingRequest.name}</strong> solicitou acesso para{" "}
            <span style={{ color: "#38bdf8", fontWeight: 600 }}>
              {pendingRequest.type === "gamepad"
                ? "Gamepad Coop (Controle Xbox 360)"
                : "Mouse & Teclado Remoto"}
            </span>
            .
          </div>
          <div className="remote-request-actions">
            <button className="btn btn-xs btn-ghost" onClick={handleRejectPermission}>
              Recusar
            </button>
            <button className="btn btn-xs btn-primary" onClick={handleAcceptPermission}>
              Aceitar
            </button>
          </div>
        </div>
      )}

      {/* Toast de status de solicitação */}
      {requestStatusMsg && (
        <div className="remote-status-toast animate-scale-in">
          {requestStatusMsg}
        </div>
      )}

      {/* Top bar */}
      <header className="room-topbar">
        <div className="room-topbar-left">
          <div className="room-logo-mini">
            <MonitorIcon size={15} />
          </div>
          <div className="room-name-row">
            <code className="room-name-code">{cleanRoomName}</code>
            {sharingParticipantsCount > 0 && (
              <span className="badge badge-live">
                <span className="badge-dot" />
                {sharingParticipantsCount === 1
                  ? "1 tela ao vivo"
                  : `${sharingParticipantsCount} telas ao vivo`}
              </span>
            )}
            <span className="badge" title="Tempo de chamada">
              <ClockIcon /> {formatTime(timeActive)}
            </span>
          </div>
        </div>
        <div className="room-topbar-right">
          {/* Alternador de modo Grade / Palco quando há 2+ transmissões */}
          {allStreams.length > 1 && (
            <button
              className={`btn btn-sm ${isGridView ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setIsGridView((g) => !g)}
              title="Alternar entre tela focada e grade lado a lado"
              style={{ fontSize: "0.8rem" }}
            >
              {isGridView ? "⊡ Focar Tela" : `⊞ Lado a Lado (${allStreams.length})`}
            </button>
          )}

          {/* Menu de Controle Remoto / Gamepad Coop */}
          <div className="remote-menu-wrap" ref={remoteMenuRef}>
            <button
              className={`btn btn-sm ${isRemoteControlActive ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setShowRemoteMenu((o) => !o)}
              title="Controle Remoto e Gamepad Coop"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: "0.82rem",
              }}
            >
              <GamepadIcon size={14} />
              <span>Controle</span>
              {connectedVirtualGamepadsCount > 0 && (
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: "#22c55e",
                    boxShadow: "0 0 6px #22c55e",
                  }}
                  title="Player 2 Conectado"
                />
              )}
              {isRemoteControlActive && (
                <span className="badge badge-success" style={{ fontSize: "0.68rem", padding: "1px 5px" }}>
                  Jogando
                </span>
              )}
            </button>

            {showRemoteMenu && (
              <div className="remote-dropdown animate-scale-in">
                <div className="remote-dropdown-header">
                  <span>🎮 Controle Remoto & Coop</span>
                  <span style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>
                    {displayName}
                  </span>
                </div>

                {/* Se estiver assistindo a tela de outra pessoa, mostra opções para pedir acesso a ela */}
                {activeRemoteTargetId && (
                  <>
                    <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "#38bdf8", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                      Controlar tela assistida ({remoteStreams[activeRemoteTargetId]?.name || "Participante"})
                    </div>
                    <div className="remote-option-card">
                      <div className="remote-option-row">
                        <span className="remote-option-title">
                          <MouseIcon size={13} /> Modo Jogo (Mouse & Teclado)
                        </span>
                        <button
                          className={`btn btn-xs ${isRemoteControlActive ? "btn-danger" : "btn-primary"}`}
                          onClick={() => {
                            if (!isRemoteControlActive) {
                              sendToPeer(activeRemoteTargetId, {
                                type: "request_remote_permission",
                                subType: "mouse_keyboard",
                                name: displayName,
                              });
                              setRequestStatusMsg("Solicitação enviada. Aguardando aprovação...");
                            } else {
                              setIsRemoteControlActive(false);
                            }
                          }}
                        >
                          {isRemoteControlActive ? "Sair" : "Pedir Acesso"}
                        </button>
                      </div>
                      <span className="remote-option-desc">
                        Controla mouse e teclado na tela assistida após autorização. (Pressione ESC para sair).
                      </span>
                    </div>

                    <div className="remote-option-card">
                      <div className="remote-option-row">
                        <span className="remote-option-title">
                          <GamepadIcon size={14} /> Gamepad Coop (Player 2)
                        </span>
                        {isGamepadPermitted ? (
                          <span className="badge badge-success" style={{ fontSize: "0.68rem", padding: "2px 6px" }}>
                            Autorizado
                          </span>
                        ) : (
                          <button
                            className="btn btn-xs btn-primary"
                            onClick={() => {
                              sendToPeer(activeRemoteTargetId, {
                                type: "request_remote_permission",
                                subType: "gamepad",
                                name: displayName,
                              });
                              setRequestStatusMsg("Solicitação de controle enviada. Aguardando aprovação...");
                            }}
                          >
                            Pedir Acesso
                          </button>
                        )}
                      </div>
                      <span className="remote-option-desc">
                        Emula seu joystick USB/Bluetooth como controle de Xbox 360 no PC de quem está transmitindo.
                      </span>
                    </div>

                    <div className="remote-menu-divider" />
                  </>
                )}

                {/* Permissões locais para quando ESTE computador estiver compartilhando tela */}
                <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  No seu PC (quando você compartilha)
                </div>

                <div className="remote-option-card">
                  <div className="remote-option-row">
                    <span className="remote-option-title">
                      <GamepadIcon size={14} /> Gamepad Coop (Xbox 360)
                    </span>
                    <button
                      className={`remote-toggle-btn ${allowGamepadCoop ? "active" : "inactive"}`}
                      onClick={() => {
                        const next = !allowGamepadCoop;
                        setAllowGamepadCoop(next);
                        if (!next) {
                          connectedVirtualGamepadsRef.current.forEach((pIdx) => {
                            window.electronAPI?.virtualGamepadDisconnect?.(pIdx);
                          });
                          connectedVirtualGamepadsRef.current.clear();
                          peerGamepadSlotsRef.current.clear();
                          setConnectedVirtualGamepadsCount(0);
                          participants.forEach((p) => {
                            if (!p.isLocal) {
                              sendToPeer(p.id, {
                                type: "remote_permission_response",
                                accepted: false,
                                revoked: true,
                                subType: "gamepad",
                              });
                            }
                          });
                        }
                      }}
                    >
                      {allowGamepadCoop ? "Ativado" : "Desativado"}
                    </button>
                  </div>
                  <span className="remote-option-desc">
                    Emulação de controle virtual de Xbox 360 no seu sistema para jogos cooperativos locais.
                    {connectedVirtualGamepadsCount > 0 && (
                      <strong style={{ color: "#22c55e", display: "block", marginTop: 2 }}>
                        ● Player 2 Conectado e Ativo
                      </strong>
                    )}
                  </span>
                </div>

                <div className="remote-option-card">
                  <div className="remote-option-row">
                    <span className="remote-option-title">
                      <MouseIcon size={13} /> Mouse & Teclado Remoto
                    </span>
                    <button
                      className={`remote-toggle-btn ${allowRemoteInput ? "active" : "inactive"}`}
                      onClick={() => {
                        const next = !allowRemoteInput;
                        setAllowRemoteInput(next);
                        if (!next) {
                          participants.forEach((p) => {
                            if (!p.isLocal) {
                              sendToPeer(p.id, {
                                type: "remote_permission_response",
                                accepted: false,
                                revoked: true,
                                subType: "mouse_keyboard",
                              });
                            }
                          });
                        }
                      }}
                    >
                      {allowRemoteInput ? "Ativado" : "Desativado"}
                    </button>
                  </div>
                  <span className="remote-option-desc">
                    Permite controle direto por mouse e teclado na sua área de trabalho e jogos.
                  </span>
                </div>

                <div className="remote-help-box">
                  <strong style={{ fontSize: "0.75rem", color: "#38bdf8", display: "block", marginBottom: 3 }}>
                    Como funciona:
                  </strong>
                  <ol style={{ margin: 0, paddingLeft: 16, fontSize: "0.71rem", color: "var(--color-text-secondary)", lineHeight: 1.45 }}>
                    <li>Quando um participante solicitar controle, você poderá aceitar na tela.</li>
                    <li>Ao aceitar, o controle físico dele atuará diretamente como Player 2 no seu jogo.</li>
                  </ol>
                </div>

                <div className="remote-menu-divider" />

                <button
                  className="btn btn-secondary btn-sm"
                  style={{ width: "100%", justifyContent: "center" }}
                  onClick={() => {
                    setShowRemoteMenu(false);
                    setShowGamepadModal(true);
                  }}
                >
                  <GamepadIcon size={14} /> Configurar & Testar Controle
                </button>
              </div>
            )}
          </div>

          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setShowParticipants((o) => !o)}
            title="Participantes"
          >
            <UsersIcon />
            <span className="participants-count">{participants.length}</span>
          </button>
          <button className="btn btn-secondary btn-sm" onClick={handleCopyLink}>
            {copied ? (
              <>
                <CheckIcon /> Copiado!
              </>
            ) : (
              <>
                <LinkIcon /> Link p/ assistir
              </>
            )}
          </button>
          <button className="btn btn-danger btn-sm" onClick={handleLeaveRoom}>
            <LeaveIcon /> Sair
          </button>
        </div>
      </header>

      {/* Content */}
      <div className="room-content">
        <div className="room-video-area">
          {shareError && (
            <div
              style={{
                background: "rgba(248,113,113,0.1)",
                border: "1px solid rgba(248,113,113,0.3)",
                borderRadius: "var(--radius-sm)",
                padding: "10px 16px",
                marginBottom: 8,
                color: "var(--color-danger)",
                fontSize: "0.85rem",
                display: "flex",
                gap: 8,
              }}
            >
              <AlertIcon /> {shareError}
            </div>
          )}

          {allStreams.length === 0 ? (
            <div className="room-empty">
              <div className="room-empty-icon animate-float">
                <MonitorIcon size={44} />
              </div>
              <h2 className="room-empty-title">Nenhuma tela compartilhada</h2>
              <p className="room-empty-sub">
                Qualquer pessoa na sala pode clicar em <strong>Compartilhar Tela</strong> abaixo para transmitir.
                <br />
                Quando mais de alguém compartilhar, você poderá alternar entre as telas ou assistir todas lado a lado!
              </p>
              <p style={{ marginTop: 8, fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
                {connectionStatus}
              </p>
            </div>
          ) : isGridView && allStreams.length > 1 ? (
            /* Modo Grade Lado a Lado (estilo Discord) */
            <div className="streams-grid">
              {allStreams.map((item) => (
                <div
                  key={item.id}
                  className="screen-wrap stream-grid-tile"
                  onDoubleClick={() => {
                    setSelectedStreamId(item.id);
                    setIsGridView(false);
                  }}
                >
                  <StreamVideo
                    stream={item.stream}
                    muted={item.isLocal}
                    volume={volume}
                    className="screen-video"
                  />
                  <div className="screen-label">
                    <MonitorIcon size={11} /> {item.name}
                    <button
                      onClick={() => {
                        setSelectedStreamId(item.id);
                        setIsGridView(false);
                      }}
                      className="stream-action-pill"
                      title="Expandir esta tela"
                    >
                      Focar
                    </button>
                    <button
                      onClick={(e) => {
                        const videoEl = (e.currentTarget.closest(".screen-wrap") as HTMLElement)?.querySelector("video");
                        if (videoEl) {
                          if (document.pictureInPictureElement) document.exitPictureInPicture();
                          else videoEl.requestPictureInPicture().catch(console.error);
                        }
                      }}
                      className="stream-action-pill"
                      title="Tela Flutuante (Janelinha)"
                    >
                      <PiPIcon /> Janelinha
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* Modo Palco Principal + Barra de Miniaturas (estilo Discord) */
            <>
              {focusedStream && (
                <div className="screen-wrap">
                  {!focusedStream.isLocal && isRemoteControlActive && (
                    <div
                      style={{
                        position: "absolute",
                        top: 12,
                        left: "50%",
                        transform: "translateX(-50%)",
                        zIndex: 20,
                        background: "rgba(16, 185, 129, 0.9)",
                        color: "#000",
                        fontWeight: 700,
                        fontSize: "0.78rem",
                        padding: "4px 14px",
                        borderRadius: 20,
                        boxShadow: "0 2px 10px rgba(0,0,0,0.5)",
                        pointerEvents: "none",
                      }}
                    >
                      🎮 Modo Jogo Ativo · Clique no vídeo para jogar · ESC para sair
                    </div>
                  )}
                  <StreamVideo
                    stream={focusedStream.stream}
                    muted={focusedStream.isLocal}
                    volume={volume}
                    className="screen-video"
                    isRemoteControlActive={!focusedStream.isLocal && isRemoteControlActive}
                    videoRefCallback={(el) => {
                      if (!focusedStream.isLocal) {
                        remoteVideoRef.current = el;
                      }
                    }}
                    onMouseMove={!focusedStream.isLocal ? handleVideoMouseMove : undefined}
                    onMouseDown={!focusedStream.isLocal ? handleVideoMouseDown : undefined}
                    onMouseUp={!focusedStream.isLocal ? handleVideoMouseUp : undefined}
                    onWheel={!focusedStream.isLocal ? handleVideoWheel : undefined}
                    onKeyDown={!focusedStream.isLocal ? handleVideoKeyDown : undefined}
                    onKeyUp={!focusedStream.isLocal ? handleVideoKeyUp : undefined}
                  />
                  <div className="screen-label">
                    <MonitorIcon size={11} /> {focusedStream.name}
                    <button
                      onClick={(e) => {
                        const videoEl = (e.currentTarget.closest(".screen-wrap") as HTMLElement)?.querySelector("video");
                        if (videoEl) {
                          if (document.pictureInPictureElement) document.exitPictureInPicture();
                          else videoEl.requestPictureInPicture().catch(console.error);
                        }
                      }}
                      className="stream-action-pill"
                      title="Tela Flutuante (Janelinha)"
                    >
                      <PiPIcon /> Janelinha
                    </button>
                  </div>
                </div>
              )}

              {/* Barra inferior de miniaturas quando há múltiplas telas sendo compartilhadas */}
              {allStreams.length > 1 && (
                <div className="stream-strip">
                  {allStreams.map((item) => {
                    const isActive = focusedStream?.id === item.id;
                    return (
                      <div
                        key={item.id}
                        className={`stream-thumb ${isActive ? "stream-thumb--active" : ""}`}
                        onClick={() => setSelectedStreamId(item.id)}
                        title={`Clique para focar na tela de ${item.name}`}
                      >
                        <StreamVideo
                          stream={item.stream}
                          muted={true}
                          volume={0}
                          className="stream-thumb-video"
                        />
                        <div className="stream-thumb-bar">
                          <span className="stream-thumb-name">{item.name}</span>
                          <span className="stream-thumb-badge">
                            {item.isLocal ? "VOCÊ" : "AO VIVO"}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
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
              {participants.map((p) => {
                const hasStream = p.isLocal ? isSharing : Boolean(remoteStreams[p.id]);
                return (
                  <li
                    key={p.id}
                    className="participant-item"
                    style={{ cursor: hasStream ? "pointer" : "default" }}
                    onClick={() => {
                      if (hasStream) {
                        setSelectedStreamId(p.isLocal ? "local" : p.id);
                        setIsGridView(false);
                      }
                    }}
                    title={hasStream ? `Assistir tela de ${p.name}` : undefined}
                  >
                    <div className="participant-avatar">{(p.name || "?")[0].toUpperCase()}</div>
                    <div className="participant-info">
                      <span className="participant-name">
                        {p.name}
                        {p.isLocal ? " (você)" : ""}
                      </span>
                      {p.isSharing && <span className="participant-sharing">● Transmitindo (ver)</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </aside>
        )}
      </div>

      {/* Controls - Disponíveis para TODOS os participantes da sala */}
      <footer className="room-controls">
        {/* Quality */}
        <div className="quality-wrap" ref={qualityRef}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setShowQuality((o) => !o)}
            disabled={isSharing}
            title={isSharing ? "Pare para mudar a qualidade" : "Qualidade da sua transmissão"}
          >
            <QualityIcon /> {QUALITY_LABELS[quality]}
          </button>
          {showQuality && (
            <div className="quality-menu animate-scale-in">
              {(Object.keys(QUALITY_LABELS) as Quality[]).map((q) => (
                <button
                  key={q}
                  className={`quality-option ${quality === q ? "quality-option--active" : ""}`}
                  onClick={() => {
                    setQuality(q);
                    setShowQuality(false);
                  }}
                >
                  {quality === q && <CheckIcon />}
                  {QUALITY_LABELS[q]}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Botão rápido: Eco Suprimido vs Eco Ignorado */}
        {window.electronAPI && (
          <button
            className={`btn btn-sm ${audioMode === "exclude-discord" ? "btn-secondary" : "btn-warning"}`}
            onClick={handleToggleDiscordAudio}
            title={
              audioMode === "exclude-discord"
                ? "Eco Suprimido: Som do Discord bloqueado na live para evitar eco. Clique para Eco Ignorado se quiser mostrar um vídeo que está no Discord."
                : "Eco Ignorado: Som do Discord liberado na live. Clique para voltar para Eco Suprimido."
            }
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: "0.82rem",
              background: audioMode === "exclude-discord" ? undefined : "rgba(234, 179, 8, 0.18)",
              borderColor: audioMode === "exclude-discord" ? undefined : "rgba(234, 179, 8, 0.45)",
              color: audioMode === "exclude-discord" ? undefined : "#facc15",
            }}
          >
            <VolumeIcon />
            {audioMode === "exclude-discord" ? "Eco Suprimido" : "Eco Ignorado"}
          </button>
        )}

        {/* Share button - Disponível para TODOS na sala */}
        {isSharing ? (
          <button className="btn btn-danger" onClick={handleStopShare}>
            <StopShareIcon /> Parar Transmissão
          </button>
        ) : (
          <button className="btn btn-primary" onClick={handleStartShare}>
            <MonitorIcon size={17} /> Compartilhar Tela
          </button>
        )}

        <button
          className={`btn ${isCameraEnabled ? "btn-secondary" : "btn-ghost"} btn-icon`}
          onClick={toggleCamera}
          title={isCameraEnabled ? "Desativar Câmera" : "Ativar Câmera"}
          style={!isCameraEnabled ? { color: "var(--color-danger)" } : {}}
        >
          {isCameraEnabled ? <CameraIcon size={18} /> : <CameraOffIcon size={18} />}
        </button>

        <button className="btn btn-secondary btn-icon" onClick={toggleFullscreen} title="Tela Cheia">
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
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setVolume(v);
            }}
            className="volume-slider"
            title="Volume das transmissões"
          />
        </div>

        <div className="room-status-right">
          <span className="online-count">
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--color-success)",
                display: "inline-block",
              }}
            />
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
              {desktopSources.map((s) => (
                <div
                  key={s.id}
                  className="source-item"
                  onClick={() => {
                    selectedSourceIdRef.current = s.id;
                    window.electronAPI?.sendDesktopSourceSelected(s.id);
                    setDesktopSources([]);
                  }}
                >
                  <img src={s.thumbnail} alt={s.name} />
                  <span>{s.name}</span>
                </div>
              ))}
            </div>
            <button
              className="btn btn-ghost"
              style={{ marginTop: 16, width: "100%" }}
              onClick={() => {
                selectedSourceIdRef.current = null;
                window.electronAPI?.sendDesktopSourceSelected(null);
                setDesktopSources([]);
              }}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Modal de Configuração do Controle (Coop / Parsec) */}
      <GamepadConfigModal isOpen={showGamepadModal} onClose={() => setShowGamepadModal(false)} />

      <style dangerouslySetInnerHTML={{ __html: roomStyles }} />
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
function MouseIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="2" width="14" height="20" rx="7" />
      <line x1="12" y1="6" x2="12" y2="10" />
    </svg>
  );
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
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px;
  }
  .room-topbar-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .remote-menu-wrap { position: relative; }
  .remote-dropdown {
    position: absolute; top: calc(100% + 8px); right: 0;
    width: 320px; background: #141722;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: var(--radius-md, 12px);
    box-shadow: 0 12px 36px rgba(0,0,0,0.6);
    padding: 12px; display: flex; flex-direction: column; gap: 10px;
    z-index: 100;
  }
  .remote-dropdown-header {
    display: flex; align-items: center; justify-content: space-between;
    font-size: 0.82rem; font-weight: 700; color: #fff;
    padding-bottom: 6px; border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .remote-option-card {
    display: flex; flex-direction: column; gap: 4px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: var(--radius-sm, 8px); padding: 8px 10px;
  }
  .remote-option-row { display: flex; align-items: center; justify-content: space-between; }
  .remote-option-title {
    font-size: 0.8rem; font-weight: 600; color: #f1f5f9;
    display: flex; align-items: center; gap: 6px;
  }
  .remote-option-desc { font-size: 0.72rem; color: var(--color-text-muted); line-height: 1.35; }
  .remote-toggle-btn {
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 0.74rem; font-weight: 600; padding: 4px 12px;
    border-radius: var(--radius-sm, 6px); cursor: pointer;
    transition: all 0.2s ease; user-select: none;
  }
  .remote-toggle-btn.inactive {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.18);
    color: #cbd5e1;
  }
  .remote-toggle-btn.inactive:hover {
    background: rgba(255, 255, 255, 0.14);
    border-color: rgba(255, 255, 255, 0.3);
    color: #fff;
    transform: translateY(-1px);
  }
  .remote-toggle-btn.active {
    background: #00d4b8;
    border: 1px solid #00d4b8;
    color: #0b0f19;
    font-weight: 700;
    box-shadow: 0 0 10px rgba(0, 212, 184, 0.45);
  }
  .remote-toggle-btn.active:hover {
    background: #00ebd0;
    box-shadow: 0 0 14px rgba(0, 212, 184, 0.65);
    transform: translateY(-1px);
  }
  .remote-help-box {
    background: rgba(56, 189, 248, 0.05);
    border: 1px solid rgba(56, 189, 248, 0.18);
    border-radius: var(--radius-sm, 8px);
    padding: 8px 10px;
  }
  .remote-menu-divider { height: 1px; background: rgba(255, 255, 255, 0.06); margin: 2px 0; }
  .remote-request-toast {
    position: absolute; top: 60px; left: 50%; transform: translateX(-50%);
    background: #141722;
    border: 1px solid rgba(0, 212, 184, 0.4);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.8), 0 0 20px rgba(0, 212, 184, 0.15);
    border-radius: var(--radius-md, 12px);
    padding: 14px 18px; z-index: 500;
    min-width: 320px; max-width: 440px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .remote-request-header {
    display: flex; align-items: center; gap: 8px;
    color: #38bdf8; font-size: 0.88rem; font-weight: 700;
  }
  .remote-request-body {
    font-size: 0.8rem; color: var(--color-text-secondary);
    margin: 0; line-height: 1.45;
  }
  .remote-request-actions {
    display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px;
  }
  .remote-status-toast {
    position: absolute; top: 60px; left: 50%; transform: translateX(-50%);
    background: #141722;
    border: 1px solid rgba(255, 255, 255, 0.18);
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.7);
    border-radius: var(--radius-full);
    padding: 8px 20px; z-index: 500;
    font-size: 0.82rem; color: #f1f5f9; font-weight: 500;
    pointer-events: none;
  }
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
  .stream-action-pill {
    margin-left: 6px;
    background: rgba(255,255,255,0.15);
    border: none;
    border-radius: 4px;
    color: #fff;
    cursor: pointer;
    padding: 2px 7px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.72rem;
    font-weight: 600;
    transition: background 0.15s;
  }
  .stream-action-pill:hover {
    background: rgba(255,255,255,0.28);
  }
  .streams-grid {
    width: 100%; flex: 1; min-height: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
    gap: 12px;
  }
  .stream-grid-tile {
    border: 1px solid rgba(255,255,255,0.08);
    transition: border-color 0.2s;
  }
  .stream-grid-tile:hover {
    border-color: var(--color-accent);
  }
  .stream-strip {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 4px 0 0;
    flex-shrink: 0;
    overflow-x: auto;
  }
  .stream-thumb {
    position: relative;
    width: 165px;
    height: 94px;
    border-radius: var(--radius-md, 10px);
    overflow: hidden;
    background: #08090e;
    border: 2px solid rgba(255,255,255,0.12);
    cursor: pointer;
    flex-shrink: 0;
    transition: all 0.18s ease;
  }
  .stream-thumb:hover {
    border-color: rgba(255,255,255,0.35);
    transform: translateY(-2px);
  }
  .stream-thumb--active {
    border-color: var(--color-accent);
    box-shadow: 0 0 14px rgba(0, 212, 184, 0.35);
  }
  .stream-thumb-video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .stream-thumb-bar {
    position: absolute;
    bottom: 0; left: 0; right: 0;
    padding: 3px 7px;
    background: linear-gradient(transparent, rgba(0,0,0,0.88));
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
  }
  .stream-thumb-name {
    font-size: 0.7rem;
    font-weight: 600;
    color: #fff;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .stream-thumb-badge {
    font-size: 0.6rem;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--color-accent);
    color: #090d16;
    flex-shrink: 0;
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
  .room-empty-sub { color: var(--color-text-secondary); max-width: 380px; font-size: 0.88rem; line-height: 1.6; }
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
    .room-name-code { max-width: 140px; }
    .room-controls { flex-wrap: wrap; padding: 10px; gap: 8px; justify-content: space-between; }
    .volume-wrap { display: none; }
    .quality-wrap { flex: 1; }
    .room-status-right { position: static; }
    .room-sidebar { position: absolute; top: 0; right: 0; bottom: 0; z-index: 100; box-shadow: -4px 0 20px rgba(0,0,0,0.5); }
    .screen-label { font-size: 0.65rem; padding: 4px 8px; bottom: 8px; left: 8px; }
    .room-empty { padding: 20px; }
    .room-empty-title { font-size: 1.1rem; }
  }
`;
