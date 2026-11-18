import Peer from "peerjs";
import { API_URL, sanitizeRoomName, toRoomSlug } from "./utils";

export interface ActiveRoom {
  name: string;         // ex: "pato agil"
  slug: string;         // ex: "pato-agil"
  hostName: string;     // ex: "renan"
  numParticipants: number;
  hasPassword: boolean;
  passwordHash?: string;
  isSharing?: boolean;
  updatedAt: number;    // Sempŕe no relógio LOCAL desta máquina!
}

type Listener = (rooms: ActiveRoom[]) => void;

const HUB_IDS = ["ct-desktop-lobby-hub-v2-1", "ct-desktop-lobby-hub-v2-2"];
const ROOM_TTL_MS = 14000;
const HEARTBEAT_MS = 4000;

class RoomRegistryService {
  private rooms = new Map<string, ActiveRoom>();
  private listeners = new Set<Listener>();

  private hostedRoom: ActiveRoom | null = null;

  // Hubs que ESTA instância conseguiu assumir (só entra no Map após 'open')
  private hubPeers = new Map<string, Peer>();
  private pendingHubPeers = new Set<string>();
  private hubSubscribers = new Map<string, Set<any>>();
  private connToRoomSlug = new Map<any, string>();

  // Peer cliente para falar com todos os Hubs ativos (inclusive de outros amigos)
  private clientPeer: Peer | null = null;
  private hubConnections = new Map<string, any>();

  private intervalId: any = null;
  private started = false;

  public start() {
    if (this.started || typeof window === "undefined") return;
    this.started = true;

    this.initClientPeer();
    this.tryClaimHubs();
    this.fetchFromHttpApi();

    this.intervalId = setInterval(() => {
      this.pruneExpiredRooms();
      this.tryClaimHubs();
      this.syncWithHubs();
      this.fetchFromHttpApi();
      if (this.hostedRoom) {
        this.hostedRoom.updatedAt = Date.now();
        this.rooms.set(this.hostedRoom.slug, { ...this.hostedRoom });
        this.broadcastToHubSubscribers();
        this.pushHostedRoomToHttpApi();
        this.notifyListeners();
      }
    }, HEARTBEAT_MS);
  }

  public subscribe(listener: Listener): () => void {
    this.start();
    this.listeners.add(listener);
    listener(this.getRooms());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getRooms(): ActiveRoom[] {
    this.pruneExpiredRooms();
    return Array.from(this.rooms.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public registerHostedRoom(room: Omit<ActiveRoom, "slug" | "updatedAt">) {
    this.start();
    const cleanName = sanitizeRoomName(room.name);
    const slug = toRoomSlug(cleanName);
    const active: ActiveRoom = {
      ...room,
      name: cleanName,
      slug,
      updatedAt: Date.now(),
    };
    this.hostedRoom = active;
    this.rooms.set(slug, active);
    this.notifyListeners();
    this.syncWithHubs();
    this.broadcastToHubSubscribers();
    this.pushHostedRoomToHttpApi();
  }

  public unregisterHostedRoom() {
    if (!this.hostedRoom) return;
    const slug = this.hostedRoom.slug;
    this.hostedRoom = null;
    this.rooms.delete(slug);
    this.notifyListeners();

    this.hubConnections.forEach((conn) => {
      if (conn && conn.open) {
        try {
          conn.send({ type: "remove_room", slug });
        } catch {}
      }
    });
    this.broadcastRemoveToHubSubscribers(slug);

    if (API_URL) {
      fetch(`${API_URL}/api/rooms?name=${encodeURIComponent(slug)}`, {
        method: "DELETE",
      }).catch(() => {});
    }
  }

  private initClientPeer() {
    if (this.clientPeer && !this.clientPeer.destroyed) return;
    try {
      const peer = new Peer({ debug: 0 });
      this.clientPeer = peer;

      peer.on("open", () => {
        this.connectToHubs();
      });

      peer.on("disconnected", () => {
        try {
          if (!peer.destroyed) peer.reconnect();
        } catch {}
      });

      peer.on("error", () => {});
    } catch {}
  }

  private connectToHubs() {
    if (!this.clientPeer || this.clientPeer.destroyed || !this.clientPeer.open) return;

    for (const hubId of HUB_IDS) {
      // Se já somos donos confirmados desse hub, não precisa conectar nele via clientPeer
      if (this.hubPeers.has(hubId)) continue;

      const existing = this.hubConnections.get(hubId);
      if (existing && existing.open) continue;

      try {
        const conn = this.clientPeer.connect(hubId, { reliable: true });
        this.hubConnections.set(hubId, conn);

        conn.on("open", () => {
          try {
            conn.send({ type: "get_rooms" });
            if (this.hostedRoom) {
              conn.send({ type: "announce_room", room: this.hostedRoom });
            }
          } catch {}
        });

        conn.on("data", (data: any) => {
          if (!data) return;
          if (data.type === "rooms_list" && Array.isArray(data.rooms)) {
            this.mergeRooms(data.rooms);
          } else if (data.type === "announce_room" && data.room) {
            this.mergeRooms([data.room]);
          } else if (data.type === "remove_room" && data.slug) {
            if (this.hostedRoom?.slug !== data.slug) {
              this.rooms.delete(data.slug);
              this.notifyListeners();
            }
          }
        });

        conn.on("close", () => {
          this.hubConnections.delete(hubId);
        });

        conn.on("error", () => {
          this.hubConnections.delete(hubId);
        });
      } catch {}
    }
  }

  private syncWithHubs() {
    if (!this.clientPeer || this.clientPeer.destroyed) {
      this.initClientPeer();
      return;
    }
    this.connectToHubs();

    this.hubConnections.forEach((conn) => {
      if (conn && conn.open) {
        try {
          if (this.hostedRoom) {
            conn.send({ type: "announce_room", room: this.hostedRoom });
          }
          conn.send({ type: "get_rooms" });
        } catch {}
      }
    });
  }

  private tryClaimHubs() {
    for (const hubId of HUB_IDS) {
      if (this.hubPeers.has(hubId) || this.pendingHubPeers.has(hubId)) continue;
      const existingConn = this.hubConnections.get(hubId);
      if (existingConn && existingConn.open) continue;

      try {
        this.pendingHubPeers.add(hubId);
        const hub = new Peer(hubId, { debug: 0 });
        const subs = new Set<any>();

        hub.on("open", () => {
          this.pendingHubPeers.delete(hubId);
          this.hubPeers.set(hubId, hub);
          this.hubSubscribers.set(hubId, subs);
        });

        hub.on("connection", (conn: any) => {
          subs.add(conn);

          conn.on("open", () => {
            try {
              conn.send({ type: "rooms_list", rooms: this.getRooms() });
            } catch {}
          });

          conn.on("data", (data: any) => {
            if (!data) return;
            if (data.type === "announce_room" && data.room && (data.room.slug || data.room.name)) {
              const room: ActiveRoom = {
                ...data.room,
                name: sanitizeRoomName(data.room.name || data.room.slug),
                slug: toRoomSlug(data.room.slug || data.room.name),
                updatedAt: Date.now(), // Usa o relógio local do Hub!
              };
              this.connToRoomSlug.set(conn, room.slug);
              this.rooms.set(room.slug, room);
              this.notifyListeners();
              this.broadcastToHubSubscribers();
            } else if (data.type === "remove_room" && data.slug) {
              this.connToRoomSlug.delete(conn);
              this.rooms.delete(data.slug);
              this.notifyListeners();
              this.broadcastRemoveToHubSubscribers(data.slug);
            } else if (data.type === "get_rooms") {
              try {
                conn.send({ type: "rooms_list", rooms: this.getRooms() });
              } catch {}
            }
          });

          const handleDisconnect = () => {
            subs.delete(conn);
            const slug = this.connToRoomSlug.get(conn);
            if (slug) {
              this.connToRoomSlug.delete(conn);
              if (this.hostedRoom?.slug !== slug) {
                this.rooms.delete(slug);
                this.notifyListeners();
                this.broadcastRemoveToHubSubscribers(slug);
              }
            }
          };

          conn.on("close", handleDisconnect);
          conn.on("error", handleDisconnect);
        });

        hub.on("error", () => {
          // Outro cliente já possui este hubId; garante que nosso clientPeer conecte nele!
          this.pendingHubPeers.delete(hubId);
          this.hubPeers.delete(hubId);
          this.hubSubscribers.delete(hubId);
          try {
            hub.destroy();
          } catch {}
          this.connectToHubs();
        });

        hub.on("disconnected", () => {
          this.pendingHubPeers.delete(hubId);
          this.hubPeers.delete(hubId);
          this.hubSubscribers.delete(hubId);
          try {
            hub.destroy();
          } catch {}
        });
      } catch {
        this.pendingHubPeers.delete(hubId);
      }
    }
  }

  private broadcastToHubSubscribers() {
    const list = this.getRooms();
    this.hubSubscribers.forEach((subs) => {
      subs.forEach((conn) => {
        if (conn && conn.open) {
          try {
            conn.send({ type: "rooms_list", rooms: list });
          } catch {}
        }
      });
    });
  }

  private broadcastRemoveToHubSubscribers(slug: string) {
    const list = this.getRooms();
    this.hubSubscribers.forEach((subs) => {
      subs.forEach((conn) => {
        if (conn && conn.open) {
          try {
            conn.send({ type: "remove_room", slug });
            conn.send({ type: "rooms_list", rooms: list });
          } catch {}
        }
      });
    });
  }

  // IMPORTANTE: Nunca compara r.updatedAt do remetente com Date.now() local (relógios de PCs diferentes podem divergir!)
  private mergeRooms(incoming: ActiveRoom[]) {
    const localNow = Date.now();
    let changed = false;
    for (const r of incoming) {
      if (!r || (!r.slug && !r.name)) continue;
      const slug = toRoomSlug(r.slug || r.name);
      const name = sanitizeRoomName(r.name || r.slug);
      if (this.hostedRoom && this.hostedRoom.slug === slug) continue;

      const existing = this.rooms.get(slug);
      if (
        !existing ||
        existing.numParticipants !== r.numParticipants ||
        existing.hasPassword !== r.hasPassword ||
        existing.isSharing !== r.isSharing ||
        existing.hostName !== r.hostName
      ) {
        changed = true;
      }
      this.rooms.set(slug, {
        ...r,
        name,
        slug,
        updatedAt: localNow,
      });
    }
    if (changed) {
      this.notifyListeners();
    }
  }

  private pruneExpiredRooms() {
    const now = Date.now();
    let removed = false;
    this.rooms.forEach((room, slug) => {
      if (this.hostedRoom && this.hostedRoom.slug === slug) return;
      if (now - room.updatedAt > ROOM_TTL_MS) {
        this.rooms.delete(slug);
        removed = true;
      }
    });
    if (removed) {
      this.notifyListeners();
    }
  }

  private async pushHostedRoomToHttpApi() {
    if (!this.hostedRoom || !API_URL) return;
    try {
      await fetch(`${API_URL}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.hostedRoom),
      });
    } catch {}
  }

  private async fetchFromHttpApi() {
    if (!API_URL) return;
    try {
      const res = await fetch(`${API_URL}/api/rooms`);
      if (!res.ok) return;
      const data = await res.json();
      if (data && Array.isArray(data.rooms)) {
        this.mergeRooms(data.rooms);
      }
    } catch {}
  }

  private notifyListeners() {
    const snapshot = this.getRooms();
    this.listeners.forEach((cb) => cb(snapshot));
  }
}

export const roomRegistry = new RoomRegistryService();
