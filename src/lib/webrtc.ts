import { collab } from './collab'
import { useStore } from '../store'

const STUN = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }

interface PeerData {
  pc: RTCPeerConnection
  makingOffer: boolean
}

const peers = new Map<string, PeerData>()
let localStream: MediaStream | null = null
let subscribers: (() => void)[] = []
let unsubRTC: (() => void) | null = null

export function getLocalStream() { return localStream }
export function getRemoteStreams(): Record<string, MediaStream> {
  const out: Record<string, MediaStream> = {}
  peers.forEach(() => {
    // remote streams are attached via ontrack
  })
  return out
}

function notify() { subscribers.forEach((fn) => fn()) }
export function subscribe(fn: () => void) { subscribers.push(fn); return () => { subscribers = subscribers.filter((f) => f !== fn) } }

function sendSignal(to: string, data: unknown) {
  collab.sendWebRTC(to, data)
}

export async function startCall(): Promise<MediaStream | null> {
  if (localStream) return localStream
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
    notify()

    unsubRTC = collab.onWebRTC((msg) => {
      handleSignal(msg.from, msg.data as RTCSignal)
    })

    setTimeout(() => checkNewUsers(), 500)

    const interval = setInterval(checkNewUsers, 3000)
    const origUnsub = unsubRTC
    unsubRTC = () => { origUnsub(); clearInterval(interval) }

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
  unsubRTC?.()
  unsubRTC = null
  subscribers = []
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

export function isCallActive() { return !!localStream }

function checkNewUsers() {
  if (!localStream) return
  const s = useStore.getState()
  const allUsers = Object.values(s.users).filter((u) => u.id !== s.selfId)

  for (const user of allUsers) {
    if (!peers.has(user.id)) {
      const pc = new RTCPeerConnection(STUN)
      const peer: PeerData = { pc, makingOffer: false }
      peers.set(user.id, peer)

      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream!))

      pc.ontrack = () => notify()

      pc.onicecandidate = (e) => {
        if (e.candidate) sendSignal(user.id, { type: 'ice', candidate: e.candidate })
      }

      pc.onnegotiationneeded = async () => {
        peer.makingOffer = true
        try {
          await pc.setLocalDescription()
          sendSignal(user.id, { type: 'offer', sdp: pc.localDescription })
        } catch {
          /* ignore */
        } finally {
          peer.makingOffer = false
        }
      }
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

interface RTCSignal {
  type: string
  sdp?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
}

async function handleSignal(from: string, data: RTCSignal) {
  let peer = peers.get(from)
  if (!peer) {
    const pc = new RTCPeerConnection(STUN)
    peer = { pc, makingOffer: false }
    peers.set(from, peer)

    if (localStream) {
      const ls = localStream
      localStream.getTracks().forEach((t) => pc.addTrack(t, ls))
    }

    pc.ontrack = () => notify()

    pc.onicecandidate = (e) => {
      if (e.candidate) sendSignal(from, { type: 'ice', candidate: e.candidate })
    }

    pc.onnegotiationneeded = async () => {
      peer!.makingOffer = true
      try {
        await pc.setLocalDescription()
        sendSignal(from, { type: 'offer', sdp: pc.localDescription })
      } catch {
        /* ignore */
      } finally {
        peer!.makingOffer = false
      }
    }
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
