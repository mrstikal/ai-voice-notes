export const FAKE_SDP_OFFER =
  "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n";

export const FAKE_SDP_ANSWER =
  "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendonly\r\n";

type Listener = (event: { readonly type: string; readonly [key: string]: unknown }) => void;

class FakeEventTarget {
  private readers = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener | null): void {
    if (!listener) {
      return;
    }

    const listeners = this.readers.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.readers.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener | null): void {
    if (!listener) {
      return;
    }

    this.readers.get(type)?.delete(listener);
  }

  protected dispatch(type: string, detail: Record<string, unknown> = {}): void {
    for (const listener of [...(this.readers.get(type) ?? [])]) {
      listener({ type, ...detail });
    }
  }
}

export class FakeDataChannel extends FakeEventTarget {
  readyState: RTCDataChannelState = "connecting";
  readonly sent: string[] = [];

  constructor(readonly label: string) {
    super();
  }

  send(data: string): void {
    if (this.readyState !== "open") {
      throw new Error("Data channel is not open.");
    }

    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === "closed") {
      return;
    }

    this.readyState = "closed";
    this.dispatch("close");
  }

  open(): void {
    if (this.readyState === "open") {
      return;
    }

    this.readyState = "open";
    this.dispatch("open");
  }

  receive(payload: unknown): void {
    this.dispatch("message", { data: JSON.stringify(payload) });
  }
}

export class FakeRTCPeerConnection extends FakeEventTarget {
  static instances: FakeRTCPeerConnection[] = [];

  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  readonly channels: FakeDataChannel[] = [];
  closed = false;

  constructor() {
    super();
    FakeRTCPeerConnection.instances.push(this);
  }

  createDataChannel(label: string): FakeDataChannel {
    const channel = new FakeDataChannel(label);
    this.channels.push(channel);
    return channel;
  }

  addTransceiver(
    _trackOrKind: string,
    init?: { readonly direction?: RTCRtpTransceiverDirection },
  ): Partial<RTCRtpTransceiver> {
    return { direction: init?.direction ?? "sendrecv" };
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: FAKE_SDP_OFFER };
  }

  async setLocalDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.localDescription = {
      type: description.type,
      sdp: description.sdp ?? "",
      toJSON() {
        return { type: description.type, sdp: description.sdp ?? "" };
      },
    };
    this.iceGatheringState = "complete";
    this.dispatch("icegatheringstatechange");
  }

  async setRemoteDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.remoteDescription = {
      type: description.type,
      sdp: description.sdp ?? "",
      toJSON() {
        return { type: description.type, sdp: description.sdp ?? "" };
      },
    };
    this.setConnectionState("connecting");
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.connectionState = "closed";

    for (const channel of this.channels) {
      channel.close();
    }

    this.dispatch("connectionstatechange");
  }

  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.dispatch("connectionstatechange");
  }

  getChannel(label = "oai-events"): FakeDataChannel | null {
    return this.channels.find((channel) => channel.label === label) ?? null;
  }
}

export interface FakeWebRtcHarness {
  readonly instances: FakeRTCPeerConnection[];
  restore(): void;
}

export function installFakeWebRtc(): FakeWebRtcHarness {
  const globalScope = globalThis as {
    RTCPeerConnection?: typeof RTCPeerConnection;
  };
  const previous = globalScope.RTCPeerConnection;
  FakeRTCPeerConnection.instances = [];
  globalScope.RTCPeerConnection =
    FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;

  return {
    instances: FakeRTCPeerConnection.instances,
    restore() {
      if (previous === undefined) {
        delete globalScope.RTCPeerConnection;
      } else {
        globalScope.RTCPeerConnection = previous;
      }
    },
  };
}
