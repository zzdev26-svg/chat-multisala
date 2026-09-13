import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { getSocket } from '../lib/socket.js';
import { playNotificationSound } from '../lib/sound.js';

// Fallback if the ICE-servers request fails for any reason — public STUN
// only. The real (possibly TURN-augmented) list comes from the server per
// call, since whether TURN is included depends on the caller's plan.
const FALLBACK_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// One call ('idle' | 'calling' | 'ringing' | 'in-call') per open DM panel.
// Scoped to the ChatWindow instance's lifetime: closing the panel hangs up.
export function useCall(roomId, enabled) {
  const [status, setStatus] = useState('idle');
  const [callerUsername, setCallerUsername] = useState(null);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [usingTurn, setUsingTurn] = useState(false);
  const [error, setError] = useState('');

  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const pendingCandidatesRef = useRef([]);

  const cleanup = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    pendingCandidatesRef.current = [];
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    setMicOn(true);
    setCameraOn(true);
    setUsingTurn(false);
  }, []);

  async function createPeerConnection() {
    const socket = getSocket();

    // Asked fresh per call: whether TURN is included depends on the plan
    // (see server/src/routes/calls.js) — never cached client-side.
    let iceServers = FALLBACK_ICE_SERVERS;
    try {
      const token = socket?.auth?.token;
      if (token) {
        const res = await api.getIceServers(token);
        if (Array.isArray(res.iceServers) && res.iceServers.length > 0) iceServers = res.iceServers;
        setUsingTurn(!!res.turnAvailable);
      }
    } catch {
      // Keep the STUN-only fallback — a call should still work on most
      // home networks even if this request fails.
    }

    const pc = new RTCPeerConnection({ iceServers });
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket?.emit('call:signal', { roomId, data: { type: 'ice-candidate', candidate: e.candidate } });
      }
    };
    pc.ontrack = (e) => {
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = e.streams[0];
    };
    pcRef.current = pc;
    return pc;
  }

  async function startLocalMedia() {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStreamRef.current = stream;
    if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    return stream;
  }

  const startCall = useCallback(() => {
    setError('');
    setStatus('calling');
    getSocket()?.emit('call:invite', roomId);
  }, [roomId]);

  const cancelCall = useCallback(() => {
    getSocket()?.emit('call:end', roomId);
    cleanup();
    setStatus('idle');
  }, [roomId, cleanup]);

  const acceptCall = useCallback(async () => {
    setError('');
    try {
      await startLocalMedia();
      getSocket()?.emit('call:accept', roomId);
      setStatus('in-call');
    } catch {
      setError('No se pudo acceder a la camara o el microfono.');
      getSocket()?.emit('call:reject', roomId);
      setStatus('idle');
      setCallerUsername(null);
    }
  }, [roomId]);

  const rejectCall = useCallback(() => {
    getSocket()?.emit('call:reject', roomId);
    setStatus('idle');
    setCallerUsername(null);
  }, [roomId]);

  const endCall = useCallback(() => {
    getSocket()?.emit('call:end', roomId);
    cleanup();
    setStatus('idle');
    setCallerUsername(null);
  }, [roomId, cleanup]);

  const toggleMic = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
  }, []);

  const toggleCamera = useCallback(() => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCameraOn(track.enabled);
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const socket = getSocket();
    if (!socket) return undefined;

    function onInvite({ roomId: rid, from }) {
      if (rid !== roomId) return;
      setError('');
      setCallerUsername(from);
      setStatus('ringing');
      playNotificationSound();
    }

    // We placed the call and the other side just accepted — we drive the
    // offer since we're the caller.
    async function onAccept({ roomId: rid }) {
      if (rid !== roomId) return;
      try {
        await startLocalMedia();
        const pc = await createPeerConnection();
        localStreamRef.current.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('call:signal', { roomId, data: { type: 'offer', sdp: offer } });
        setStatus('in-call');
      } catch {
        setError('No se pudo acceder a la camara o el microfono.');
        socket.emit('call:end', roomId);
        cleanup();
        setStatus('idle');
      }
    }

    function onReject({ roomId: rid }) {
      if (rid !== roomId) return;
      cleanup();
      setStatus('idle');
      setCallerUsername(null);
      setError('Llamada rechazada.');
    }

    function onEnd({ roomId: rid }) {
      if (rid !== roomId) return;
      cleanup();
      setStatus('idle');
      setCallerUsername(null);
    }

    async function onSignal({ roomId: rid, data }) {
      if (rid !== roomId) return;
      let pc = pcRef.current;

      if (data.type === 'offer') {
        // We're the callee: local media is already up from acceptCall().
        pc = pc || (await createPeerConnection());
        localStreamRef.current?.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current));
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        for (const candidate of pendingCandidatesRef.current) await pc.addIceCandidate(candidate);
        pendingCandidatesRef.current = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('call:signal', { roomId, data: { type: 'answer', sdp: answer } });
      } else if (data.type === 'answer') {
        if (!pc) return;
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      } else if (data.type === 'ice-candidate') {
        const candidate = new RTCIceCandidate(data.candidate);
        if (pc?.remoteDescription) {
          await pc.addIceCandidate(candidate);
        } else {
          pendingCandidatesRef.current.push(candidate);
        }
      }
    }

    socket.on('call:invite', onInvite);
    socket.on('call:accept', onAccept);
    socket.on('call:reject', onReject);
    socket.on('call:end', onEnd);
    socket.on('call:signal', onSignal);

    return () => {
      socket.off('call:invite', onInvite);
      socket.off('call:accept', onAccept);
      socket.off('call:reject', onReject);
      socket.off('call:end', onEnd);
      socket.off('call:signal', onSignal);
    };
  }, [roomId, enabled, cleanup]);

  // Closing the panel mid-call hangs up instead of leaking the connection.
  useEffect(() => {
    return () => {
      if (pcRef.current || localStreamRef.current) {
        getSocket()?.emit('call:end', roomId);
      }
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  return {
    status,
    callerUsername,
    micOn,
    cameraOn,
    usingTurn,
    error,
    localVideoRef,
    remoteVideoRef,
    startCall,
    cancelCall,
    acceptCall,
    rejectCall,
    endCall,
    toggleMic,
    toggleCamera,
  };
}
