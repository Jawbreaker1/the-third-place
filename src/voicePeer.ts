import type { VoiceIceServer, VoicePeerSignal, VoiceSignalForward, VoiceSignalPayload } from "../shared/types";

interface PeerState {
  connection: RTCPeerConnection;
  transceiver: RTCRtpTransceiver;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingRemoteAnswer: boolean;
}

export interface VoicePeerMeshOptions {
  roomId: string;
  localMemberId: string;
  revision: number;
  iceServers: VoiceIceServer[];
  localStream?: MediaStream;
  onSignal: (message: VoiceSignalPayload) => void;
  onRemoteStream: (memberId: string, stream?: MediaStream) => void;
  onConnectionState: (memberId: string, state: RTCPeerConnectionState) => void;
}

/** Small-room WebRTC mesh with deterministic initial offers and glare handling. */
export class VoicePeerMesh {
  private readonly peers = new Map<string, PeerState>();
  private localStream?: MediaStream;
  private revision: number;

  constructor(private readonly options: VoicePeerMeshOptions) {
    this.localStream = options.localStream;
    this.revision = options.revision;
  }

  syncPeers(memberIds: string[], revision = this.revision): void {
    this.revision = revision;
    const wanted = new Set(memberIds.filter((memberId) => memberId && memberId !== this.options.localMemberId));
    for (const memberId of this.peers.keys()) if (!wanted.has(memberId)) this.removePeer(memberId);
    for (const memberId of wanted) if (!this.peers.has(memberId)) this.createPeer(memberId);
  }

  async handleSignal(message: VoiceSignalForward): Promise<void> {
    if (message.roomId !== this.options.roomId || message.toMemberId !== this.options.localMemberId) return;
    this.revision = Math.max(this.revision, message.revision);
    const state = this.peers.get(message.fromMemberId) ?? this.createPeer(message.fromMemberId);
    const connection = state.connection;
    try {
      if (message.signal.type === "offer" || message.signal.type === "answer") {
        const readyForOffer = !state.makingOffer && (connection.signalingState === "stable" || state.settingRemoteAnswer);
        const offerCollision = message.signal.type === "offer" && !readyForOffer;
        const polite = this.options.localMemberId.localeCompare(message.fromMemberId) > 0;
        state.ignoreOffer = !polite && offerCollision;
        if (state.ignoreOffer) return;
        state.settingRemoteAnswer = message.signal.type === "answer";
        await connection.setRemoteDescription({ type: message.signal.type, sdp: message.signal.sdp });
        state.settingRemoteAnswer = false;
        if (message.signal.type === "offer") {
          await connection.setLocalDescription();
          const local = connection.localDescription;
          if (local?.sdp && (local.type === "offer" || local.type === "answer")) {
            this.signal(message.fromMemberId, { type: local.type, sdp: local.sdp });
          }
        }
      } else {
        try {
          await connection.addIceCandidate(message.signal.candidate);
        } catch (error) {
          if (!state.ignoreOffer) throw error;
        }
      }
    } catch (error) {
      state.settingRemoteAnswer = false;
      console.warn("Voice signaling failed", error);
    }
  }

  async setLocalStream(stream?: MediaStream): Promise<void> {
    this.localStream = stream;
    const track = stream?.getAudioTracks()[0] ?? null;
    await Promise.all([...this.peers.values()].map(async ({ transceiver }) => {
      await transceiver.sender.replaceTrack(track);
      const direction: RTCRtpTransceiverDirection = track ? "sendrecv" : "recvonly";
      if (transceiver.direction !== direction) transceiver.direction = direction;
    }));
  }

  setInputEnabled(enabled: boolean): void {
    for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = enabled;
  }

  close(): void {
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
  }

  private createPeer(peerId: string): PeerState {
    const connection = new RTCPeerConnection({ iceServers: this.options.iceServers });
    const audioTrack = this.localStream?.getAudioTracks()[0];
    const transceiver = connection.addTransceiver(audioTrack ?? "audio", {
      direction: audioTrack ? "sendrecv" : "recvonly",
      ...(audioTrack && this.localStream ? { streams: [this.localStream] } : {}),
    });
    const state: PeerState = { connection, transceiver, makingOffer: false, ignoreOffer: false, settingRemoteAnswer: false };
    this.peers.set(peerId, state);
    connection.onicecandidate = ({ candidate }) => this.signal(peerId, { type: "ice", candidate: candidate?.toJSON() ?? null });
    connection.ontrack = ({ track, streams }) => {
      const stream = streams[0] ?? new MediaStream([track]);
      this.options.onRemoteStream(peerId, stream);
      track.onended = () => this.options.onRemoteStream(peerId, undefined);
    };
    connection.onconnectionstatechange = () => {
      this.options.onConnectionState(peerId, connection.connectionState);
      if (connection.connectionState === "failed") connection.restartIce();
    };
    connection.onnegotiationneeded = async () => {
      const ownsInitialOffer = this.options.localMemberId.localeCompare(peerId) < 0;
      if (!ownsInitialOffer && !connection.remoteDescription) return;
      try {
        state.makingOffer = true;
        await connection.setLocalDescription();
        const local = connection.localDescription;
        if (local?.sdp && (local.type === "offer" || local.type === "answer")) {
          this.signal(peerId, { type: local.type, sdp: local.sdp });
        }
      } catch (error) {
        console.warn("Voice offer failed", error);
      } finally {
        state.makingOffer = false;
      }
    };
    return state;
  }

  private signal(memberId: string, signal: VoicePeerSignal): void {
    this.options.onSignal({ roomId: this.options.roomId, toMemberId: memberId, revision: this.revision, signal });
  }

  private removePeer(peerId: string): void {
    const state = this.peers.get(peerId);
    if (!state) return;
    state.connection.onicecandidate = null;
    state.connection.ontrack = null;
    state.connection.onconnectionstatechange = null;
    state.connection.onnegotiationneeded = null;
    state.connection.close();
    this.peers.delete(peerId);
    this.options.onRemoteStream(peerId, undefined);
  }
}
