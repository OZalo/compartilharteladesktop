// Nomes de salas: animal + espaço + adjetivo (fácil de ler e digitar)
const ANIMAIS: [string, "m" | "f"][] = [
  ["aguia", "f"], ["alce", "m"], ["andorinha", "f"], ["arara", "f"], ["baleia", "f"],
  ["boto", "m"], ["cabra", "f"], ["camelo", "m"], ["capivara", "f"], ["carneiro", "m"],
  ["castor", "m"], ["cavalo", "m"], ["cervo", "m"], ["cobra", "f"], ["coelho", "m"],
  ["coruja", "f"], ["crocodilo", "m"], ["doninha", "f"], ["ema", "f"], ["falcao", "m"],
  ["flamingo", "m"], ["foca", "f"], ["gamba", "m"], ["ganso", "m"], ["gato", "m"],
  ["gaviao", "m"], ["girafa", "f"], ["golfinho", "m"], ["gorila", "m"], ["guepardo", "m"],
  ["harpia", "f"], ["hiena", "f"], ["hipopotamo", "m"], ["iguana", "f"], ["jabuti", "m"],
  ["jacare", "m"], ["jaguar", "m"], ["javali", "m"], ["lagartixa", "f"], ["lagarto", "m"],
  ["leao", "m"], ["leopardo", "m"], ["lhama", "f"], ["lobo", "m"], ["lontra", "f"],
  ["macaco", "m"], ["marmota", "f"], ["morcego", "m"], ["mula", "f"], ["narval", "m"],
  ["onca", "f"], ["ornitorrinco", "m"], ["ourico", "m"], ["paca", "f"], ["panda", "m"],
  ["pantera", "f"], ["papagaio", "m"], ["pardal", "m"], ["pato", "m"], ["pavao", "m"],
  ["pelicano", "m"], ["perereca", "f"], ["pinguim", "m"], ["piranha", "f"], ["polvo", "m"],
  ["pombo", "m"], ["porco", "m"], ["preguica", "f"], ["puma", "m"], ["quati", "m"],
  ["raposa", "f"], ["rato", "m"], ["rinoceronte", "m"], ["sapo", "m"], ["siri", "m"],
  ["suricato", "m"], ["tamandua", "m"], ["tartaruga", "f"], ["tatu", "m"], ["tigre", "m"],
  ["touro", "m"], ["tubarao", "m"], ["tucano", "m"], ["urso", "m"], ["urubu", "m"],
  ["veado", "m"], ["zebra", "f"], ["zorrilho", "m"],
];

const ADJETIVOS: [string, string][] = [
  ["agil", "agil"], ["alegre", "alegre"], ["alto", "alta"], ["amigo", "amiga"],
  ["astuto", "astuta"], ["atento", "atenta"], ["audaz", "audaz"], ["azul", "azul"],
  ["bacana", "bacana"], ["belo", "bela"], ["bom", "boa"], ["bravo", "brava"],
  ["brilhante", "brilhante"], ["calmo", "calma"], ["colorido", "colorida"], ["corajoso", "corajosa"],
  ["curioso", "curiosa"], ["docil", "docil"], ["dourado", "dourada"], ["elegante", "elegante"],
  ["esperto", "esperta"], ["estelar", "estelar"], ["feliz", "feliz"], ["feroz", "feroz"],
  ["fiel", "fiel"], ["firme", "firme"], ["forte", "forte"], ["frio", "fria"],
  ["furtivo", "furtiva"], ["gentil", "gentil"], ["gigante", "gigante"], ["gracioso", "graciosa"],
  ["habil", "habil"], ["heroico", "heroica"], ["jovem", "jovem"], ["leal", "leal"],
  ["legal", "legal"], ["leve", "leve"], ["ligeiro", "ligeira"], ["limpo", "limpa"],
  ["lindo", "linda"], ["livre", "livre"], ["lunar", "lunar"], ["manso", "mansa"],
  ["mistico", "mistica"], ["nobre", "nobre"], ["noturno", "noturna"], ["novo", "nova"],
  ["ousado", "ousada"], ["pacifico", "pacifica"], ["pequeno", "pequena"], ["polar", "polar"],
  ["prateado", "prateada"], ["quieto", "quieta"], ["radiante", "radiante"], ["rapido", "rapida"],
  ["real", "real"], ["risonho", "risonha"], ["roxo", "roxa"], ["sabio", "sabia"],
  ["selvagem", "selvagem"], ["sereno", "serena"], ["sincero", "sincera"], ["solar", "solar"],
  ["sonolento", "sonolenta"], ["sortudo", "sortuda"], ["suave", "suave"], ["super", "super"],
  ["teimoso", "teimosa"], ["tranquilo", "tranquila"], ["tropical", "tropical"], ["valente", "valente"],
  ["veloz", "veloz"], ["verde", "verde"], ["vibrante", "vibrante"], ["vivaz", "vivaz"],
  ["voador", "voadora"], ["zen", "zen"],
];

export function generateRoomName(): string {
  const [animal, gender] = ANIMAIS[Math.floor(Math.random() * ANIMAIS.length)];
  const [adjM, adjF] = ADJETIVOS[Math.floor(Math.random() * ADJETIVOS.length)];
  const adj = gender === "f" ? adjF : adjM;
  return `${animal} ${adj}`;
}

// Normaliza o nome da sala mantendo espaços simples para exibição/digitação ("pato agil")
export function sanitizeRoomName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);
}

// Converte o nome da sala para slug técnico sem espaços para o PeerJS e URLs ("pato-agil")
export function toRoomSlug(name: string): string {
  return sanitizeRoomName(name).replace(/\s+/g, "-");
}

export function validateDisplayName(name: string): string {
  return name.trim().replace(/[<>'"]/g, "").slice(0, 30);
}

// Hash simples e rápido para validar senha da sala no cliente/P2P
export function hashPassword(password?: string): string {
  if (!password || !password.trim()) return "";
  const str = password.trim();
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

let lastOwnClipboardText = "";

export function getLastOwnClipboardText(): string {
  return lastOwnClipboardText;
}

export async function copyToClipboard(text: string): Promise<void> {
  lastOwnClipboardText = text.trim();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.focus();
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
  }
}

// Extrai o nome de uma sala caso um texto (ex: área de transferência) contenha link do app
export function extractRoomFromText(text: string): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  // Evita disparar se foi o próprio usuário que acabou de copiar o link
  if (lastOwnClipboardText && trimmed === lastOwnClipboardText) {
    return null;
  }
  const urlMatch = trimmed.match(/[?&](?:sala|room)=([^&\s#]+)/i);
  if (urlMatch && urlMatch[1]) {
    try {
      return sanitizeRoomName(decodeURIComponent(urlMatch[1]));
    } catch {
      return sanitizeRoomName(urlMatch[1]);
    }
  }
  const deepMatch = trimmed.match(/compartilhartela:\/\/room\/([^/?\s#]+)/i);
  if (deepMatch && deepMatch[1]) {
    try {
      return sanitizeRoomName(decodeURIComponent(deepMatch[1]));
    } catch {
      return sanitizeRoomName(deepMatch[1]);
    }
  }
  return null;
}

// API URL — aponta para o backend no Vercel
export const API_URL = import.meta.env.VITE_API_URL || "https://compartilhartela.vercel.app";
export const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL || "";
