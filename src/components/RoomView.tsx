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

const QUALITY_CONSTRAINTS: Record<Quality, { width: number; height: number; frameRate: number }> = {
  "720p30":  { width: 1280, height: 720,  frameRate: 30 },
  "1080p30": { width: 1920, height: 1080, frameRate: 30 },
  "1080p60": { width: 1920, height: 1080, frameRate: 60 },
  "1440p60": { width: 2560, height: 1440, frameRate: 60 },
  "2160p60": { width: 3840, height: 2160, frameRate: 60 },
};

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

export default function RoomView({ roomName, displayName, password, isCreator, onLeave }: RoomViewProps) {
  const cleanRoomName = sanitizeRoomName(roomName);
  const roomSlug = toRoomSlug(cleanRoomName);

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

  const [audioMode, setAudioMode] = useState<AudioMode>("exclude-discord");
  const [showAudioMenu, setShowAudioMenu] = useState(false);

  const [volume, setVolume] = useState(1);
  const [isCameraEnabled, setIsCameraEnabled] = useState(false);

  // Parsec / Controle Remoto & Gamepad Coop (Desativado por padrão - anfitrião deve aceitar)
  const [showRemoteMenu, setShowRemoteMenu] = useState(false);
  const [showGamepadModal, setShowGamepadModal] = useState(false);
  const [allowRemoteInput, setAllowRemoteInput] = useState(false); // Desativado por padrão!
  const [allowGamepadCoop, setAllowGamepadCoop] = useState(false); // Desativado por padrão!
  const [connectedVirtualGamepadsCount, setConnectedVirtualGamepadsCount] = useState(0);
  const [isRemoteControlActive, setIsRemoteControlActive] = useState(false); // Viewer: modo jogo
  const [isGamepadPermitted, setIsGamepadPermitted] = useState(false); // Viewer: gamepad autorizado

  // Pedidos de permissão (host recebe, viewer aguarda)
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
  const viewerDataConnRef = useRef<any>(null);

  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
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

  // Substitui tracks em todas as conexões P2P ativas
  const replaceTracksForViewers = useCallback((stream: MediaStream) => {
    mediaCallsRef.current.forEach((call: any) => {
      if (call && call.peerConnection) {
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
    });
  }, []);

  // PeerJS Setup
  useEffect(() => {
    const hostId = `ct-desktop-${roomSlug}-host`;
    const myId = isCreator ? hostId : undefined;
    const expectedHash = hashPassword(password);

    setConnectionStatus("Conectando ao servidor...");
    const newPeer = new Peer(myId as string, { debug: 1 });

    newPeer.on("open", (id) => {
      setConnectionStatus(
        isCreator ? "Sala criada. Aguardando espectadores..." : "Conectado. Chamando anfitrião..."
      );

      const me: Participant = { id, name: displayName, isLocal: true, isSharing: false };
      setParticipants([me]);

      if (!isCreator) {
        const dataConn = newPeer.connect(hostId, {
          metadata: { name: displayName, passwordHash: expectedHash },
        });
        viewerDataConnRef.current = dataConn;

        dataConn.on("data", (data: any) => {
          if (data.type === "auth_error") {
            setShareError(data.message || "Senha incorreta.");
            setTimeout(onLeave, 1200);
            return;
          }
          if (data.type === "sync_participants") {
            const synced = data.participants.map((p: Participant) => ({
              ...p,
              isLocal: p.id === id,
            }));
            setParticipants(synced);
          }
          if (data.type === "share_stopped") {
            setRemoteStream(null);
            setConnectionStatus("O anfitrião parou de compartilhar a tela.");
          }
          if (data.type === "remote_permission_response") {
            if (data.accepted) {
              if (data.subType === "mouse_keyboard") {
                setIsRemoteControlActive(true);
                setTimeout(() => remoteVideoRef.current?.focus(), 100);
                setRequestStatusMsg("✓ Anfitrião aceitou! Modo jogo ativado.");
              } else if (data.subType === "gamepad") {
                setIsGamepadPermitted(true);
                setRequestStatusMsg("✓ Anfitrião aceitou! Seu controle de Xbox (Player 2) está ativo.");
              }
            } else {
              if (data.subType === "mouse_keyboard") {
                setIsRemoteControlActive(false);
              } else if (data.subType === "gamepad") {
                setIsGamepadPermitted(false);
              }
              setRequestStatusMsg("✕ O anfitrião recusou a solicitação de acesso.");
            }
            setTimeout(() => setRequestStatusMsg(""), 4500);
          }
        });

        const call = newPeer.call(hostId, dummyStreamRef.current || new MediaStream(), {
          metadata: { passwordHash: expectedHash },
        });
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
            name: conn.metadata?.name || "Espectador",
            isLocal: false,
            isSharing: false,
          };
          setParticipants((prev) => [...prev.filter((p) => p.id !== conn.peer), newParticipant]);
          setTimeout(broadcastParticipants, 300);

          // Escuta inputs remotos do convidado (Mouse, Teclado, Gamepad Xbox)
          conn.on("data", (data: any) => {
            if (!data || !data.type) return;

            if (data.type === "request_remote_permission") {
              setPendingRequest({
                peerId: conn.peer,
                name: data.name || "Espectador",
                type: data.subType || "mouse_keyboard",
              });
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
                const pIdx = typeof data.playerIndex === "number" ? data.playerIndex : 0;
                if (!connectedVirtualGamepadsRef.current.has(pIdx)) {
                  window.electronAPI.virtualGamepadConnect(pIdx);
                  connectedVirtualGamepadsRef.current.add(pIdx);
                  setConnectedVirtualGamepadsCount(connectedVirtualGamepadsRef.current.size);
                }
                window.electronAPI.virtualGamepadUpdate(pIdx, data.state);
              }
            } else if (data.type === "input_gamepad_disconnect") {
              const pIdx = typeof data.playerIndex === "number" ? data.playerIndex : 0;
              if (connectedVirtualGamepadsRef.current.has(pIdx)) {
                window.electronAPI?.virtualGamepadDisconnect?.(pIdx);
                connectedVirtualGamepadsRef.current.delete(pIdx);
                setConnectedVirtualGamepadsCount(connectedVirtualGamepadsRef.current.size);
              }
            }
          });
        });

        conn.on("close", () => {
          dataConnectionsRef.current.delete(conn.peer);
          setParticipants((prev) => prev.filter((p) => p.id !== conn.peer));
          setTimeout(broadcastParticipants, 300);
        });
      });
    }

    newPeer.on("call", (call: any) => {
      if (isCreator) {
        if (expectedHash && call.metadata?.passwordHash !== expectedHash) {
          call.close();
          return;
        }
        mediaCallsRef.current.add(call);
        call.on("close", () => mediaCallsRef.current.delete(call));
        call.answer(localStreamRef.current || dummyStreamRef.current || new MediaStream());
      } else {
        call.answer();
      }
    });

    newPeer.on("error", (err) => {
      console.error("PeerJS Error:", err);
      setConnectionStatus("Erro: " + err.message);
    });

    setPeer(newPeer);
    return () => {
      mediaCallsRef.current.clear();
      connectedVirtualGamepadsRef.current.forEach((pIdx) => {
        window.electronAPI?.virtualGamepadDisconnect?.(pIdx);
      });
      connectedVirtualGamepadsRef.current.clear();
      newPeer.destroy();
    };
  }, [roomSlug, isCreator, displayName, password, broadcastParticipants, onLeave]);

  // Atualiza a flag isSharing do anfitrião
  useEffect(() => {
    if (isCreator) {
      setParticipants((prev) => prev.map((p) => (p.isLocal ? { ...p, isSharing } : p)));
      setTimeout(broadcastParticipants, 200);
    }
  }, [isSharing, isCreator, broadcastParticipants]);

  // Envia a nova stream para os espectadores
  useEffect(() => {
    if (isCreator && peer && localStream) {
      replaceTracksForViewers(localStream);
    }
  }, [localStream, peer, isCreator, replaceTracksForViewers]);

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

  // Inicia o pipeline C++ Process Loopback (excluindo Discord ou capturando tudo)
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

        const capacity = 48000 * 2;
        const ringL = new Float32Array(capacity);
        const ringR = new Float32Array(capacity);
        let writePos = 0;
        let readPos = 0;
        let available = 0;

        const scriptNode = audioCtx.createScriptProcessor(1024, 1, 2);
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

        const dest = audioCtx.createMediaStreamDestination();
        scriptNode.connect(dest);

        if (audioCtx.state === "suspended") {
          await audioCtx.resume();
        }

        const pushSamplesToRing = (samples: Float32Array, channels: number) => {
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

        window.electronAPI.onNativeAudioChunk((buffer, channels, _sampleRate, bitsPerSample) => {
          if (!buffer || buffer.byteLength === 0) return;

          if (bitsPerSample === 32) {
            const aligned = new Uint8Array(buffer.byteLength);
            aligned.set(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
            const floatSamples = new Float32Array(aligned.buffer);
            pushSamplesToRing(floatSamples, channels);
          } else if (bitsPerSample === 16) {
            const aligned = new Uint8Array(buffer.byteLength);
            aligned.set(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
            const int16 = new Int16Array(aligned.buffer);
            const floatSamples = new Float32Array(int16.length);
            for (let i = 0; i < int16.length; i++) {
              floatSamples[i] = int16[i] / 32768.0;
            }
            pushSamplesToRing(floatSamples, channels);
          }
        });

        const status = await window.electronAPI.startNativeAudio({
          mode: effectiveMode,
          windowHandle,
        });

        console.log("[NativeAudio] Mode:", effectiveMode, "Status:", status);

        if (typeof status === "string" && status.startsWith("OK:")) {
          return dest.stream.getAudioTracks()[0];
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
          video: { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate } },
          audio: false, // O áudio é capturado 100% pelo módulo C++ nativo!
        });
      } else {
        rawStream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: q.width, height: q.height, frameRate: q.frameRate },
          audio: true,
        });
      }

      const videoTrack = rawStream.getVideoTracks()[0];
      const activeAudioTrack = await buildCleanAudioTrack(audioMode);

      const composedTracks: MediaStreamTrack[] = [videoTrack];
      if (activeAudioTrack) composedTracks.push(activeAudioTrack);
      const finalStream = new MediaStream(composedTracks);

      setLocalStream(finalStream);
      setIsSharing(true);

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

    // Substitui as tracks dos espectadores pela dummyStream (canvas preto) para não congelar o último frame
    if (dummyStreamRef.current) {
      replaceTracksForViewers(dummyStreamRef.current);
    }

    // Avisa os espectadores via DataChannel para limpar o player de vídeo e mostrar o estado de espera
    dataConnectionsRef.current.forEach((conn) => {
      if (conn && conn.open) {
        try {
          conn.send({ type: "share_stopped" });
        } catch {}
      }
    });

    // Desconecta quaisquer gamepads virtuais se o anfitrião parar a live
    connectedVirtualGamepadsRef.current.forEach((pIdx) => {
      window.electronAPI?.virtualGamepadDisconnect?.(pIdx);
    });
    connectedVirtualGamepadsRef.current.clear();
    setConnectedVirtualGamepadsCount(0);
  }, [stopNativeAudioPipeline, replaceTracksForViewers]);

  // Loop de Gamepad do espectador (captura controle físico USB/Bluetooth e transmite via DataChannel)
  useEffect(() => {
    if (isCreator) return;

    let animFrame: number;
    let lastState: VirtualGamepadState | null = null;
    let wasConnected = false;

    const poll = () => {
      const gamepads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
      let activePad: Gamepad | null = null;
      for (let i = 0; i < gamepads.length; i++) {
        if (gamepads[i]) {
          activePad = gamepads[i];
          break;
        }
      }

      const conn = viewerDataConnRef.current;
      if (activePad && conn && conn.open) {
        wasConnected = true;
        const config = loadGamepadConfig();
        const currentSample = sampleGamepad(activePad, config);

        if (isGamepadStateDifferent(lastState, currentSample)) {
          lastState = currentSample;
          try {
            conn.send({
              type: "input_gamepad",
              playerIndex: 0,
              state: currentSample,
            });
          } catch {}
        }
      } else if (wasConnected && conn && conn.open) {
        wasConnected = false;
        lastState = null;
        try {
          conn.send({
            type: "input_gamepad_disconnect",
            playerIndex: 0,
          });
        } catch {}
      }

      animFrame = requestAnimationFrame(poll);
    };

    animFrame = requestAnimationFrame(poll);
    return () => {
      cancelAnimationFrame(animFrame);
      if (wasConnected && viewerDataConnRef.current?.open) {
        try {
          viewerDataConnRef.current.send({
            type: "input_gamepad_disconnect",
            playerIndex: 0,
          });
        } catch {}
      }
    };
  }, [isCreator]);

  // Handlers de Mouse e Teclado do espectador para enviar ao anfitrião
  const handleVideoMouseMove = (e: React.MouseEvent<HTMLVideoElement>) => {
    if (!isRemoteControlActive || !viewerDataConnRef.current?.open) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    try {
      viewerDataConnRef.current.send({
        type: "input_mouse",
        mouseEvent: { type: "move", x, y },
      });
    } catch {}
  };

  const handleVideoMouseDown = (e: React.MouseEvent<HTMLVideoElement>) => {
    if (!isRemoteControlActive || !viewerDataConnRef.current?.open) return;
    e.currentTarget.focus();
    try {
      viewerDataConnRef.current.send({
        type: "input_mouse",
        mouseEvent: { type: "down", button: e.button },
      });
    } catch {}
  };

  const handleVideoMouseUp = (e: React.MouseEvent<HTMLVideoElement>) => {
    if (!isRemoteControlActive || !viewerDataConnRef.current?.open) return;
    try {
      viewerDataConnRef.current.send({
        type: "input_mouse",
        mouseEvent: { type: "up", button: e.button },
      });
    } catch {}
  };

  const handleVideoWheel = (e: React.WheelEvent<HTMLVideoElement>) => {
    if (!isRemoteControlActive || !viewerDataConnRef.current?.open) return;
    try {
      viewerDataConnRef.current.send({
        type: "input_mouse",
        mouseEvent: { type: "wheel", deltaY: Math.sign(e.deltaY) },
      });
    } catch {}
  };

  const handleVideoKeyDown = (e: React.KeyboardEvent<HTMLVideoElement>) => {
    if (!isRemoteControlActive || !viewerDataConnRef.current?.open) return;
    if (e.key === "Escape") {
      setIsRemoteControlActive(false);
      return;
    }
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].includes(e.code)) {
      e.preventDefault();
    }
    try {
      viewerDataConnRef.current.send({
        type: "input_keyboard",
        keyEvent: { type: "down", vk: e.keyCode || e.which },
      });
    } catch {}
  };

  const handleVideoKeyUp = (e: React.KeyboardEvent<HTMLVideoElement>) => {
    if (!isRemoteControlActive || !viewerDataConnRef.current?.open) return;
    try {
      viewerDataConnRef.current.send({
        type: "input_keyboard",
        keyEvent: { type: "up", vk: e.keyCode || e.which },
      });
    } catch {}
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
    const el = document.querySelector(".screen-wrap");
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

  const sharingParticipant = participants.find((p) => p.isSharing);

  const handleAcceptPermission = useCallback(() => {
    if (!pendingRequest) return;
    const conn = dataConnectionsRef.current.get(pendingRequest.peerId);
    if (conn && conn.open) {
      conn.send({
        type: "remote_permission_response",
        accepted: true,
        subType: pendingRequest.type,
      });
    }
    if (pendingRequest.type === "mouse_keyboard") {
      setAllowRemoteInput(true);
    } else if (pendingRequest.type === "gamepad") {
      setAllowGamepadCoop(true);
    }
    setPendingRequest(null);
  }, [pendingRequest]);

  const handleRejectPermission = useCallback(() => {
    if (!pendingRequest) return;
    const conn = dataConnectionsRef.current.get(pendingRequest.peerId);
    if (conn && conn.open) {
      conn.send({
        type: "remote_permission_response",
        accepted: false,
        subType: pendingRequest.type,
      });
    }
    setPendingRequest(null);
  }, [pendingRequest]);

  return (
    <div className="room-layout">
      {/* Notificação flutuante para anfitrião aprovar/recusar controle */}
      {isCreator && pendingRequest && (
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

      {/* Toast de status para o espectador */}
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
              {isCreator && connectedVirtualGamepadsCount > 0 && (
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
                    {isCreator ? "Anfitrião" : "Espectador"}
                  </span>
                </div>

                {isCreator ? (
                  <>
                    <div className="remote-option-card">
                      <div className="remote-option-row">
                        <span className="remote-option-title">
                          <GamepadIcon size={14} /> Gamepad Coop (Xbox 360)
                        </span>
                        <button
                          className={`remote-toggle-btn ${allowGamepadCoop ? "active" : "inactive"}`}
                          onClick={() => setAllowGamepadCoop((v) => !v)}
                        >
                          {allowGamepadCoop ? "Ativado" : "Desativado"}
                        </button>
                      </div>
                      <span className="remote-option-desc">
                        Emulação de controle virtual de Xbox 360 no seu sistema para jogos cooperativos locais (Steam, emuladores, etc.).
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
                          onClick={() => setAllowRemoteInput((v) => !v)}
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
                  </>
                ) : (
                  <>
                    <div className="remote-option-card">
                      <div className="remote-option-row">
                        <span className="remote-option-title">
                          <MouseIcon size={13} /> Modo Jogo (Mouse & Teclado)
                        </span>
                        <button
                          className={`btn btn-xs ${isRemoteControlActive ? "btn-danger" : "btn-primary"}`}
                          onClick={() => {
                            if (!isRemoteControlActive) {
                              if (viewerDataConnRef.current && viewerDataConnRef.current.open) {
                                try {
                                  viewerDataConnRef.current.send({
                                    type: "request_remote_permission",
                                    subType: "mouse_keyboard",
                                    name: displayName,
                                  });
                                  setRequestStatusMsg("Solicitação enviada. Aguardando o anfitrião aceitar...");
                                } catch {}
                              }
                            } else {
                              setIsRemoteControlActive(false);
                            }
                          }}
                        >
                          {isRemoteControlActive ? "Sair" : "Pedir Acesso"}
                        </button>
                      </div>
                      <span className="remote-option-desc">
                        Controla mouse e teclado no PC do anfitrião após autorização. (Pressione ESC para sair).
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
                              if (viewerDataConnRef.current && viewerDataConnRef.current.open) {
                                try {
                                  viewerDataConnRef.current.send({
                                    type: "request_remote_permission",
                                    subType: "gamepad",
                                    name: displayName,
                                  });
                                  setRequestStatusMsg("Solicitação de controle enviada. Aguardando o anfitrião aceitar...");
                                } catch {}
                              }
                            }}
                          >
                            Pedir Acesso
                          </button>
                        )}
                      </div>
                      <span className="remote-option-desc">
                        Conecte seu joystick USB/Bluetooth para emular um controle de Xbox 360 no jogo do anfitrião após autorização.
                      </span>
                    </div>

                    <div className="remote-help-box">
                      <strong style={{ fontSize: "0.75rem", color: "#38bdf8", display: "block", marginBottom: 3 }}>
                        Como funciona:
                      </strong>
                      <ol style={{ margin: 0, paddingLeft: 16, fontSize: "0.71rem", color: "var(--color-text-secondary)", lineHeight: 1.45 }}>
                        <li>Conecte seu controle USB/Bluetooth ou use mouse/teclado.</li>
                        <li>Clique em <strong>Pedir Acesso</strong> na opção desejada acima.</li>
                        <li>Aguarde o anfitrião aceitar a solicitação na tela dele.</li>
                      </ol>
                    </div>
                  </>
                )}

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

          {isCreator ? (
            isSharing && localStream ? (
              <div className="screen-wrap">
                <video ref={localVideoRef} autoPlay muted className="screen-video" />
                <div className="screen-label">
                  <MonitorIcon size={11} /> Sua tela (prévia)
                  <button
                    onClick={(e) => {
                      const videoEl = (e.currentTarget.closest(".screen-wrap") as HTMLElement)?.querySelector("video");
                      if (videoEl) {
                        if (document.pictureInPictureElement) document.exitPictureInPicture();
                        else videoEl.requestPictureInPicture().catch(console.error);
                      }
                    }}
                    style={{
                      marginLeft: 6,
                      background: "rgba(255,255,255,0.15)",
                      border: "none",
                      borderRadius: 4,
                      color: "#fff",
                      cursor: "pointer",
                      padding: "2px 6px",
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                    }}
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
                  Clique em <strong>Compartilhar Tela</strong> para iniciar a transmissão.
                  <br />
                  Seus amigos acessam pelo link ou direto pela lista do app.
                </p>
                <p style={{ marginTop: 8, fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
                  {connectionStatus}
                </p>
              </div>
            )
          ) : remoteStream ? (
            <div className="screen-wrap">
              {isRemoteControlActive && (
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
              <video
                ref={remoteVideoRef}
                autoPlay
                className="screen-video"
                tabIndex={0}
                style={{
                  cursor: isRemoteControlActive ? "crosshair" : "default",
                  outline: isRemoteControlActive ? "2px solid var(--color-primary)" : "none",
                }}
                onMouseMove={handleVideoMouseMove}
                onMouseDown={handleVideoMouseDown}
                onMouseUp={handleVideoMouseUp}
                onWheel={handleVideoWheel}
                onContextMenu={(e) => {
                  if (isRemoteControlActive) e.preventDefault();
                }}
                onKeyDown={handleVideoKeyDown}
                onKeyUp={handleVideoKeyUp}
              />
              <div className="screen-label">
                <MonitorIcon size={11} /> Tela do Anfitrião
                <button
                  onClick={(e) => {
                    const videoEl = (e.currentTarget.closest(".screen-wrap") as HTMLElement)?.querySelector("video");
                    if (videoEl) {
                      if (document.pictureInPictureElement) document.exitPictureInPicture();
                      else videoEl.requestPictureInPicture().catch(console.error);
                    }
                  }}
                  style={{
                    marginLeft: 6,
                    background: "rgba(255,255,255,0.15)",
                    border: "none",
                    borderRadius: 4,
                    color: "#fff",
                    cursor: "pointer",
                    padding: "2px 6px",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
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
              <p style={{ marginTop: 8, fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
                {connectionStatus}
              </p>
            </div>
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
              {participants.map((p) => (
                <li key={p.id} className="participant-item">
                  <div className="participant-avatar">{(p.name || "?")[0].toUpperCase()}</div>
                  <div className="participant-info">
                    <span className="participant-name">
                      {p.name}
                      {p.isLocal ? " (você)" : ""}
                    </span>
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
              onClick={() => setShowQuality((o) => !o)}
              disabled={isSharing}
              title={isSharing ? "Pare para mudar a qualidade" : "Qualidade da transmissão"}
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
        )}

        {/* Botão rápido: Eco Suprimido vs Eco Ignorado */}
        {isCreator && window.electronAPI && (
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

        {/* Share button */}
        {isCreator &&
          (isSharing ? (
            <button className="btn btn-danger" onClick={handleStopShare}>
              <StopShareIcon /> Parar Transmissão
            </button>
          ) : (
            <button className="btn btn-primary" onClick={handleStartShare}>
              <MonitorIcon size={17} /> Compartilhar Tela
            </button>
          ))}

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
              if (remoteVideoRef.current) remoteVideoRef.current.volume = v;
            }}
            className="volume-slider"
            title="Volume"
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
