const homeView = document.getElementById("homeView");
const callView = document.getElementById("callView");
const createNameInput = document.getElementById("createName");
const createCodeInput = document.getElementById("createCode");
const joinNameInput = document.getElementById("joinName");
const joinCodeInput = document.getElementById("joinCode");
const homeError = document.getElementById("homeError");
const localVideo = document.getElementById("localVideo");
const localPlaceholder = document.getElementById("localPlaceholder");
const videoGrid = document.getElementById("videoGrid");
const waitingTile = document.getElementById("waitingTile");
const toast = document.getElementById("toast");

let localStream = null;
let peer = null;
let isHost = false;
let roomId = null;
let displayName = null;
let peers = new Map();
let dataConnections = new Map();
let micEnabled = true;
let cameraEnabled = true;
let toastTimer;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2300);
}
function setError(message) { homeError.textContent = message || ""; }

function peerIdForRoom(code) {
  return `roomwave-${code}`;
}

async function enterRoom(name, code, create = false) {
  setError("");
  displayName = name.trim();
  if (!displayName) {
    setError("Please enter your name first.");
    return;
  }
  roomId = String(code || "").trim();
  if (!roomId) {
    setError("Please enter a room code.");
    return;
  }
  if (!/^[0-9]+$/.test(roomId)) {
    setError("Enter a numeric room code.");
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { facingMode: "user" }
    });
  } catch (err) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      showToast("Camera unavailable - joining with microphone only.");
    } catch (audioErr) {
      setError("Camera and microphone access is needed. Allow access in your browser and try again.");
      return;
    }
  }

  localVideo.srcObject = localStream;
  document.getElementById("localName").textContent = displayName;
  document.querySelector(".avatar").textContent = displayName.charAt(0).toUpperCase();
  updateLocalMediaUI();
  isHost = create;
  startPeer(create);
}

function startPeer(create) {
  if (!window.Peer) {
    setError("The call service could not load. Check your connection and refresh.");
    localStream?.getTracks().forEach(track => track.stop());
    localStream = null;
    return;
  }

  const uniqueId = typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const peerId = create ? peerIdForRoom(roomId) : `roomwave-${roomId}-${uniqueId}`;
  peer = new Peer(peerId, {
    config: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" }
      ]
    }
  });

  peer.on("open", () => {
    homeView.classList.add("hidden");
    callView.classList.remove("hidden");
    document.getElementById("activeRoomCode").textContent = roomId;
    updateCallUrl();

    if (!isHost) {
      joinHost();
    } else {
      document.getElementById("callStatus").innerHTML =
        '<span class="status-dot"></span> Waiting for others to join';
    }
  });

  peer.on("connection", connection => setupDataConnection(connection));

  peer.on("call", call => {
    call.answer(localStream);
    setupMediaCall(call.peer, call.metadata?.name || "Guest", call);
  });

  peer.on("error", err => {
    if (err.type === "unavailable-id") {
      setError("That room code is already in use. Choose another code.");
    } else if (err.type === "peer-unavailable") {
      setError("That room does not exist. Create it first or check the room code.");
    } else {
      setError("Unable to connect to the room. Check your connection and try again.");
    }
    leaveCall(false);
  });
}

function joinHost() {
  const hostId = peerIdForRoom(roomId);
  const connection = peer.connect(hostId, { reliable: true, metadata: { name: displayName } });
  connection.on("open", () => {
    connection.send({ type: "join", name: displayName });
  });
  setupDataConnection(connection);

  const retry = setTimeout(() => {
    if (!peer?.destroyed && peers.size === 0) {
      setError("Could not find that room. Create it first or check the room code.");
      leaveCall(false);
    }
  }, 10000);
  connection.on("close", () => clearTimeout(retry));
  connection.on("open", () => clearTimeout(retry));
}

function setupDataConnection(connection) {
  dataConnections.set(connection.peer, connection);
  connection.on("data", data => handleData(connection.peer, data));
  connection.on("close", () => {
    dataConnections.delete(connection.peer);
    removePeer(connection.peer);
  });
  connection.on("error", () => removePeer(connection.peer));
}

function handleData(fromId, data) {
  if (isHost && data.type === "join") {
    const existing = [...peers.entries()].map(([id, entry]) => ({
      id,
      name: entry.name
    }));
    const joinConnection = dataConnections.get(fromId);
    joinConnection?.send({ type: "participants", participants: existing });
    broadcastData({ type: "peer-added", id: fromId, name: data.name }, fromId);
    createPeer(fromId, data.name, true);
    dataConnections.forEach((connection, id) => {
      if (id !== fromId) connection.send({ type: "peer-added", id: fromId, name: data.name });
    });
  } else if (data.type === "participants") {
    data.participants.forEach(participant => createPeer(participant.id, participant.name, true));
  } else if (data.type === "peer-added") {
    createPeer(data.id, data.name, true);
  } else if (data.type === "peer-left") {
    removePeer(data.id);
  }
}

function broadcastData(data, excludeId = null) {
  dataConnections.forEach((connection, id) => {
    if (id !== excludeId && connection.open) connection.send(data);
  });
}

function createPeer(peerId, peerName, shouldCall) {
  if (peers.has(peerId) || peerId === peer.id) return peers.get(peerId);
  const entry = { name: peerName, call: null, stream: new MediaStream(), tile: null };
  peers.set(peerId, entry);

  if (shouldCall) {
    const call = peer.call(peerId, localStream, { metadata: { name: displayName } });
    if (call) setupMediaCall(peerId, peerName, call);
  }
  updateParticipantCount();
  return entry;
}

function setupMediaCall(peerId, peerName, call) {
  const entry = peers.get(peerId) || {
    name: peerName,
    call: null,
    stream: new MediaStream(),
    tile: null
  };
  entry.call = call;
  entry.name = peerName;
  peers.set(peerId, entry);

  call.on("stream", stream => {
    entry.stream = stream;
    renderRemoteTile(peerId, entry);
  });
  call.on("close", () => removePeer(peerId));
  call.on("error", () => removePeer(peerId));
  updateParticipantCount();
}

function renderRemoteTile(peerId, entry) {
  let tile = document.getElementById(`peer-${peerId}`);
  if (!tile) {
    tile = document.createElement("div");
    tile.className = "video-tile remote-tile";
    tile.id = `peer-${peerId}`;
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    const placeholder = document.createElement("div");
    placeholder.className = "video-placeholder";
    placeholder.innerHTML = '<div class="avatar"></div><span>Camera is off</span>';
    const label = document.createElement("div");
    label.className = "video-label";
    label.textContent = entry.name;
    tile.append(video, placeholder, label);
    videoGrid.insertBefore(tile, waitingTile);
    entry.tile = tile;
  }
  const video = tile.querySelector("video");
  if (video.srcObject !== entry.stream) video.srcObject = entry.stream;
  const hasVideo = entry.stream.getVideoTracks().some(track =>
    track.enabled && track.readyState === "live"
  );
  tile.querySelector(".video-placeholder").classList.toggle("hidden", hasVideo);
  video.classList.toggle("hidden", !hasVideo);
  tile.querySelector(".avatar").textContent = (entry.name || "G").charAt(0).toUpperCase();
  waitingTile.classList.add("hidden");
  document.getElementById("callStatus").innerHTML =
    '<span class="status-dot"></span> Connected - you are live';
}

function removePeer(peerId) {
  const entry = peers.get(peerId);
  if (!entry) return;
  entry.call?.close();
  entry.tile?.remove();
  peers.delete(peerId);
  dataConnections.get(peerId)?.close();
  dataConnections.delete(peerId);
  updateParticipantCount();
  showToast("Someone left the call.");
  broadcastData({ type: "peer-left", id: peerId });
}

function updateParticipantCount() {
  const count = peers.size + 1;
  document.getElementById("participantCount").textContent =
    `${count} participant${count === 1 ? "" : "s"}`;
  if (!peers.size) {
    waitingTile.classList.remove("hidden");
    document.getElementById("callStatus").innerHTML =
      '<span class="status-dot"></span> Waiting for others to join';
  }
}

function updateLocalMediaUI() {
  const hasVideo = localStream?.getVideoTracks().length > 0;
  localPlaceholder.classList.toggle("hidden", !!(hasVideo && cameraEnabled));
  localVideo.classList.toggle("hidden", !(hasVideo && cameraEnabled));
  document.getElementById("micBtn").classList.toggle("off", !micEnabled);
  document.getElementById("micText").textContent = micEnabled ? "Mute" : "Unmute";
  document.getElementById("micBtn").setAttribute(
    "aria-label",
    micEnabled ? "Mute microphone" : "Unmute microphone"
  );
  document.getElementById("cameraBtn").classList.toggle("off", !cameraEnabled);
  document.getElementById("cameraText").textContent =
    cameraEnabled ? "Stop video" : "Start video";
  document.getElementById("cameraBtn").setAttribute(
    "aria-label",
    cameraEnabled ? "Turn camera off" : "Turn camera on"
  );
}

function toggleMic() {
  const tracks = localStream?.getAudioTracks() || [];
  if (!tracks.length) return showToast("No microphone is available in this call.");
  micEnabled = !micEnabled;
  tracks.forEach(track => track.enabled = micEnabled);
  updateLocalMediaUI();
}

function toggleCamera() {
  const tracks = localStream?.getVideoTracks() || [];
  if (!tracks.length) return showToast("No camera is available in this call.");
  cameraEnabled = !cameraEnabled;
  tracks.forEach(track => track.enabled = cameraEnabled);
  updateLocalMediaUI();
}

function getInviteUrl() {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  if (roomId) url.searchParams.set("room", roomId);
  return url.toString();
}

function updateCallUrl() {
  if (!roomId) return;
  history.replaceState(null, "", getInviteUrl());
}

async function copyRoomCode() {
  const invite = getInviteUrl();
  try {
    await navigator.clipboard.writeText(invite);
    showToast("Call link copied!");
  } catch {
    showToast(`Room link: ${invite}`);
  }
}

function leaveCall(showHome = true) {
  peers.forEach(({ call }) => call?.close());
  peers.clear();
  dataConnections.forEach(connection => connection.close());
  dataConnections.clear();
  localStream?.getTracks().forEach(track => track.stop());
  localStream = null;
  peer?.destroy();
  peer = null;
  if (showHome) {
    callView.classList.add("hidden");
    homeView.classList.remove("hidden");
  }
  videoGrid.querySelectorAll(".remote-tile").forEach(tile => tile.remove());
  waitingTile.classList.remove("hidden");
  localVideo.srcObject = null;
  micEnabled = true;
  cameraEnabled = true;
  updateLocalMediaUI();
  setError("");
  const url = new URL(window.location.href);
  url.searchParams.delete("room");
  history.replaceState(null, "", url);
}

document.getElementById("createBtn").addEventListener("click", () =>
  enterRoom(createNameInput.value, createCodeInput.value, true)
);
document.getElementById("joinBtn").addEventListener("click", () =>
  enterRoom(joinNameInput.value, joinCodeInput.value, false)
);
createCodeInput.addEventListener("keydown", event => {
  if (event.key === "Enter") document.getElementById("createBtn").click();
});
joinCodeInput.addEventListener("keydown", event => {
  if (event.key === "Enter") document.getElementById("joinBtn").click();
});
createNameInput.addEventListener("keydown", event => {
  if (event.key === "Enter") createCodeInput.focus();
});
joinNameInput.addEventListener("keydown", event => {
  if (event.key === "Enter") joinCodeInput.focus();
});
createCodeInput.addEventListener("input", () =>
  createCodeInput.value = createCodeInput.value.replace(/[^0-9]/g, "")
);
joinCodeInput.addEventListener("input", () =>
  joinCodeInput.value = joinCodeInput.value.replace(/[^0-9]/g, "")
);
document.getElementById("micBtn").addEventListener("click", toggleMic);
document.getElementById("cameraBtn").addEventListener("click", toggleCamera);
document.getElementById("leaveBtn").addEventListener("click", () => leaveCall());
document.getElementById("copyCodeBtn").addEventListener("click", copyRoomCode);
document.getElementById("copyInviteBtn").addEventListener("click", copyRoomCode);

const inviteRoom = new URL(window.location.href).searchParams.get("room");
if (inviteRoom && /^\d+$/.test(inviteRoom)) {
  joinCodeInput.value = inviteRoom;
  joinNameInput.focus();
}
