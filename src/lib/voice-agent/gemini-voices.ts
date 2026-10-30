export const GEMINI_LIVE_VOICES = [
  { id: "Aoede", description: "lehký" },
  { id: "Puck", description: "veselý" },
  { id: "Charon", description: "informativní" },
  { id: "Kore", description: "pevný" },
  { id: "Fenrir", description: "vzrušený" },
  { id: "Leda", description: "mladistvý" },
  { id: "Orus", description: "pevný" },
  { id: "Zephyr", description: "jasný" },
  { id: "Callirrhoe", description: "uvolněný" },
  { id: "Autonoe", description: "jasný" },
  { id: "Enceladus", description: "dýchavý" },
  { id: "Iapetus", description: "čistý" },
  { id: "Umbriel", description: "uvolněný" },
  { id: "Algieba", description: "hladký" },
  { id: "Despina", description: "hladký" },
  { id: "Erinome", description: "čistý" },
  { id: "Algenib", description: "chraplavý" },
  { id: "Rasalgethi", description: "informativní" },
  { id: "Laomedeia", description: "veselý" },
  { id: "Achernar", description: "měkký" },
  { id: "Alnilam", description: "pevný" },
  { id: "Schedar", description: "vyrovnaný" },
  { id: "Gacrux", description: "zralý" },
  { id: "Pulcherrima", description: "přímý" },
  { id: "Achird", description: "přátelský" },
  { id: "Zubenelgenubi", description: "neformální" },
  { id: "Vindemiatrix", description: "jemný" },
  { id: "Sadachbia", description: "živý" },
  { id: "Sadaltager", description: "znalý" },
  { id: "Sulafat", description: "teplý" },
] as const;

export type GeminiVoice = (typeof GEMINI_LIVE_VOICES)[number]["id"];

export const DEFAULT_GEMINI_VOICE: GeminiVoice = "Aoede";

export function isGeminiVoice(value: unknown): value is GeminiVoice {
  return (
    typeof value === "string" &&
    GEMINI_LIVE_VOICES.some((voice) => voice.id === value)
  );
}
