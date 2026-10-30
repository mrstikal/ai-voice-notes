export const GEMINI_INPUT_SAMPLE_RATE = 16_000;
export const GEMINI_OUTPUT_SAMPLE_RATE = 24_000;

export function float32ToPcm16(
  samples: Float32Array<ArrayBufferLike>,
): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(
      index * 2,
      sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff),
      true,
    );
  }

  return bytes;
}

export function pcm16ToFloat32(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const samples = new Float32Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  }

  return samples;
}

export function resamplePcm16(
  bytes: Uint8Array,
  fromRate: number,
  toRate: number,
): Uint8Array {
  if (fromRate === toRate) {
    return new Uint8Array(bytes);
  }

  if (fromRate <= 0 || toRate <= 0) {
    throw new RangeError("Vzorkovací frekvence musí být kladná.");
  }

  const input = pcm16ToFloat32(bytes);
  const ratio = fromRate / toRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Uint8Array(outputLength * 2);
  const view = new DataView(output.buffer);

  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    const value =
      (input[left] ?? 0) * (1 - fraction) + (input[right] ?? 0) * fraction;
    const clamped = Math.max(-1, Math.min(1, value));
    view.setInt16(
      index * 2,
      clamped < 0
        ? Math.round(clamped * 0x8000)
        : Math.round(clamped * 0x7fff),
      true,
    );
  }

  return output;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}
