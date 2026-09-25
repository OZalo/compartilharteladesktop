// Nomes de salas: animal + traço + 4 números (igual ao projeto web)
const ANIMAIS = [
  "aguia","alce","andorinha","arara","baleia",
  "boto","bugio","cabra","caimao","camelo","capivara","carneiro","castor","cavalo",
  "cervo","cobra","coruja","cotia","coelho","crocodilo","doninha",
  "dromedario","ema","falcao","flamingo","foca",
  "gamba","ganso","gaviao","gato","golfinho","gorila","guepardo","harpia","hiena","hipopotamo",
  "irara","jabuti","jaguar","jaguatirica","javali","lagartixa","lagarto","lamantim",
  "leao","leopardo","lobo","lontra","polvo","macaco","marmota","marta","mergulhao",
  "morcego","mula","narval","nandu","onca","ornitorrinco","ourico",
  "paca","papagaio","pardal","pato","pelicano","perereca","piranha",
  "pombo","porco","puma","quati","raposa","ratao","rato",
  "rinoceronte","sapo","serelepe","siri","tamandua","tatupeba",
  "tigre","touro","tucano","tubarao","urubu","urso","zebra","zorrilho",
];

export function generateRoomName(): string {
  const animal = ANIMAIS[Math.floor(Math.random() * ANIMAIS.length)];
  const num = String(Math.floor(Math.random() * 9000) + 1000);
  return `${animal}-${num}`;
}

export function sanitizeRoomName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

export function validateDisplayName(name: string): string {
  return name.trim().replace(/[<>'"]/g, "").slice(0, 30);
}

export async function copyToClipboard(text: string): Promise<void> {
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

// API URL — aponta para o backend no Vercel
export const API_URL = import.meta.env.VITE_API_URL || "https://compartilhartela.vercel.app";
export const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL || "";
