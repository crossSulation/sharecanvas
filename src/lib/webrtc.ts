import { collab } from './collab'
import { useStore } from '../store'

const STUN = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }

interface PeerData {
  pc: RTCPeerConnection
  makingOffer: boolean
}

interface RTCSignal {
  type: string
  sdp?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
}

const peers = new Map<string, PeerData>()
let localStream: MediaStream | null = null
let subscribers: (() => void)[] = []
let callInterval: ReturnType<typeof setInterval> | null = null
let incomingFrom: string | null = null
let pendingOffer: RTCSessionDescriptionInit | null = null

export function getLocalStream() { return localStream }
export function getRemoteStreams(): Record<string, MediaStream> {
  // remote streams are attached via ontrack
  return {}
}
export function isCallActive() { return !!localStream }
export function getIncomingFrom() { return incomingFrom }

function notify() { subscribers.forEach((fn) => fn()) }
export function subscribe(fn: () => void) {
  subscribers.push(fn)
  return () => { subscribers = subscribers.filter((f) => f !== fn) }
}

function sendSignal(to: string, data: unknown) {
  collab.sendWebRTC(to, data)
}

function makePeer(from: string, stream: MediaStream): PeerData {
  const pc = new RTCPeerConnection(STUN)
  const peer: PeerData = { pc, makingOffer: false }
  peers.set(from, peer)
  pc.ontrack = () => notify()
  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(from, { type: 'ice', candidate: e.candidate })
  }
  pc.onnegotiationneeded = async () => {
    peer.makingOffer = true
    try {
      await pc.setLocalDescription()
      sendSignal(from, { type: 'offer', sdp: pc.localDescription })
    } catch {
      /* ignore */
    } finally {
      peer.makingOffer = false
    }
  }
  stream.getTracks().forEach((t) => pc.addTrack(t, stream))
  return peer
}

export async function startCall(): Promise<MediaStream | null> {
  if (localStream) return localStream
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
    notify()
    callInterval = setInterval(checkNewUsers, 3000)
    setTimeout(() => checkNewUsers(), 500)
    return localStream
  } catch (err) {
    console.error('getUserMedia failed:', err)
    return null
  }
}

export function stopCall() {
  localStream?.getTracks().forEach((t) => t.stop())
  localStream = null
  peers.forEach((p) => p.pc.close())
  peers.clear()
  if (callInterval) {
    clearInterval(callInterval)
    callInterval = null
  }
  notify()
}

export function toggleLocalAudio() {
  const enabled = !(localStream?.getAudioTracks()[0]?.enabled ?? true)
  localStream?.getAudioTracks().forEach((t) => (t.enabled = enabled))
  notify()
  return enabled
}

export function toggleLocalVideo() {
  const enabled = !(localStream?.getVideoTracks()[0]?.enabled ?? true)
  localStream?.getVideoTracks().forEach((t) => (t.enabled = enabled))
  notify()
  return enabled
}

// 接听来电：开启本端媒体流，并用暂存的 offer 完成协商
export async function acceptIncomingCall(): Promise<boolean> {
  const from = incomingFrom
  const offer = pendingOffer
  if (!from || !offer) return false
  incomingFrom = null
  pendingOffer = null
  notify()
  const stream = await startCall()
  if (!stream) return false
  let peer = peers.get(from)
  if (!peer) {
    peer = makePeer(from, stream)
  } else {
    stream.getTracks().forEach((t) => peer!.pc.addTrack(t, stream))
  }
  const { pc } = peer
  try {
    if (pc.signalingState === 'stable' || pc.signalingState === 'have-local-offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(offer))
    }
    await pc.setLocalDescription()
    sendSignal(from, { type: 'answer', sdp: pc.localDescription })
    return true
  } catch (err) {
    console.error('accept call error:', err)
    return false
  }
}

export function declineIncomingCall() {
  const from = incomingFrom
  incomingFrom = null
  pendingOffer = null
  if (from) {
    const peer = peers.get(from)
    if (peer) {
      peer.pc.close()
      peers.delete(from)
    }
  }
  notify()
}

function checkNewUsers() {
  if (!localStream) return
  const s = useStore.getState()
  const allUsers = Object.values(s.users).filter((u) => u.id !== s.selfId)

  for (const user of allUsers) {
    if (!peers.has(user.id)) {
      makePeer(user.id, localStream)
    }
  }

  for (const [id] of peers) {
    if (!allUsers.find((u) => u.id === id)) {
      peers.get(id)?.pc.close()
      peers.delete(id)
      notify()
    }
  }
}

async function handleSignal(from: string, data: RTCSignal) {
  // 本端未开启通话：收到 offer 视为来电，暂存并通知 UI，等待用户接听
  if (!localStream) {
    if (data.type === 'offer' && data.sdp && !incomingFrom) {
      incomingFrom = from
      pendingOffer = data.sdp
      notify()
    }
    return
  }

  let peer = peers.get(from)
  if (!peer) {
    peer = makePeer(from, localStream)
  }
  const { pc } = peer
  try {
    if (data.type === 'offer') {
      if (peer.makingOffer || pc.signalingState !== 'stable') return
      if (data.sdp) await pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
      await pc.setLocalDescription()
      sendSignal(from, { type: 'answer', sdp: pc.localDescription })
    } else if (data.type === 'answer') {
      if (data.sdp) await pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
      notify()
    } else if (data.type === 'ice') {
      if (data.candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)) } catch { /* ignore */ }
      }
    }
  } catch (err) {
    console.error('signal error:', err)
  }
}

// 常驻信令订阅：不依赖本端是否已开启通话，保证其他成员的来电/信令都能收到
collab.onWebRTC((msg) => {
  handleSignal(msg.from, msg.data as RTCSignal)
})
