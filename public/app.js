const API_URL = '';
const SOCKET_URL = '';

let currentUser = null;
let token = localStorage.getItem('token');
let socket = null;
let activeTab = 'chats';
let selectedChat = null;
let friends = [];
let requests = [];
let messages = {};
let callTimer = null;
let callSeconds = 0;
let isMuted = false;
let isVideoOff = false;
let localStream = null;
let remoteStream = null;
let peerConnection = null;
let currentCall = null;

const authScreen = document.getElementById('authScreen');
const appScreen = document.getElementById('appScreen');
const contentList = document.getElementById('contentList');

function switchAuthTab(tab) {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');
    
    if (tab === 'login') {
        document.getElementById('loginForm').style.display = 'block';
        document.getElementById('registerForm').style.display = 'none';
    } else {
        document.getElementById('loginForm').style.display = 'none';
        document.getElementById('registerForm').style.display = 'block';
    }
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    
    try {
        const res = await fetch(`${API_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (data.token) {
            token = data.token;
            localStorage.setItem('token', token);
            currentUser = data.user;
            initApp();
        } else {
            alert(data.error || 'Login failed');
        }
    } catch (err) {
        alert('Server error');
    }
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('regUsername').value;
    const email = document.getElementById('regEmail').value;
    const displayName = document.getElementById('regDisplayName').value;
    const password = document.getElementById('regPassword').value;
    
    try {
        const res = await fetch(`${API_URL}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, displayName, password })
        });
        const data = await res.json();
        if (data.token) {
            token = data.token;
            localStorage.setItem('token', token);
            currentUser = data.user;
            initApp();
        } else {
            alert(data.error || 'Registration failed');
        }
    } catch (err) {
        alert('Server error');
    }
});

async function initApp() {
    authScreen.style.display = 'none';
    appScreen.style.display = 'flex';
    
    const res = await fetch(`${API_URL}/api/me`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    currentUser = await res.json();
    
    document.getElementById('userName').textContent = currentUser.displayName;
    document.getElementById('userAvatar').textContent = getInitials(currentUser.displayName);
    
    socket = io(SOCKET_URL);
    socket.emit('authenticate', token);
    
    socket.on('authenticated', () => {
        console.log('Socket authenticated');
        loadFriends();
        loadRequests();
    });
    
    socket.on('new-message', (data) => {
        if (!messages[data.sender]) messages[data.sender] = [];
        messages[data.sender].push(data);
        if (selectedChat === data.sender) {
            renderMessage(data, false);
        } else {
            showNotification(`New message from ${getFriendName(data.sender)}`);
        }
        renderList();
    });
    
    socket.on('typing', (data) => {
        if (selectedChat === data.userId) {
            document.getElementById('typingIndicator').classList.add('active');
        }
    });
    
    socket.on('stop-typing', (data) => {
        if (selectedChat === data.userId) {
            document.getElementById('typingIndicator').classList.remove('active');
        }
    });
    
    socket.on('friend-request', (data) => {
        requests.push(data);
        renderList();
        showNotification(`Friend request from ${data.from.displayName}`);
    });
    
    socket.on('friend-accepted', () => {
        loadFriends();
        showNotification('Friend request accepted!');
    });
    
    socket.on('user-status', (data) => {
        const friend = friends.find(f => f._id === data.userId);
        if (friend) {
            friend.status = data.status;
            renderList();
        }
    });
    
    socket.on('call-offer', async (data) => {
        currentCall = { from: data.from, offer: data.offer };
        const friend = friends.find(f => f._id === data.from);
        document.getElementById('incomingAvatar').textContent = getInitials(friend.displayName);
        document.getElementById('incomingName').textContent = friend.displayName;
        document.getElementById('incomingCallModal').classList.add('active');
    });
    
    socket.on('call-answer', async (data) => {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
    });
    
    socket.on('ice-candidate', (data) => {
        if (peerConnection) {
            peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
    });
    
    socket.on('call-ended', () => {
        endCall();
    });
}

function getInitials(name) {
    return name.split(' ').map(n => n[0]).join('').toUpperCase();
}

function getFriendName(id) {
    const friend = friends.find(f => f._id === id);
    return friend ? friend.displayName : 'Unknown';
}

async function loadFriends() {
    const res = await fetch(`${API_URL}/api/friends`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    friends = await res.json();
    renderList();
}

async function loadRequests() {
    const res = await fetch(`${API_URL}/api/friends/requests`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    requests = await res.json();
    if (activeTab === 'requests') renderList();
}

function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');
    renderList();
}

function renderEmpty(message) {
    contentList.innerHTML = `
        <div class="empty-list">
            <i class="fas fa-inbox"></i>
            <p>${message}</p>
        </div>
    `;
}

function renderList() {
    contentList.innerHTML = '';
    
    if (activeTab === 'chats') {
        const chatFriends = friends.filter(f => messages[f._id] && messages[f._id].length > 0);
        if (chatFriends.length === 0) {
            renderEmpty('No conversations yet. Start chatting with a friend!');
            return;
        }
        chatFriends.forEach(friend => {
            const msgs = messages[friend._id] || [];
            const lastMsg = msgs[msgs.length - 1];
            renderChatItem(friend, lastMsg);
        });
    } else if (activeTab === 'friends') {
        if (friends.length === 0) {
            renderEmpty('No friends yet. Click "Add Friend" to get started!');
            return;
        }
        friends.forEach(friend => renderFriendItem(friend));
    } else if (activeTab === 'requests') {
        if (requests.length === 0) {
            renderEmpty('No pending friend requests');
            return;
        }
        requests.forEach(req => renderRequestItem(req));
    }
}

function renderChatItem(friend, lastMsg) {
    const div = document.createElement('div');
    div.className = `list-item ${selectedChat === friend._id ? 'active' : ''}`;
    div.onclick = () => selectChat(friend._id);
    div.innerHTML = `
        <div class="avatar ${friend.status}">${getInitials(friend.displayName)}</div>
        <div class="list-item-info">
            <div class="list-item-title">
                <span>${friend.displayName}</span>
                <span class="time-badge">${lastMsg ? new Date(lastMsg.createdAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : ''}</span>
            </div>
            <div class="list-item-meta">${lastMsg ? lastMsg.text : 'Start chatting'}</div>
        </div>
    `;
    contentList.appendChild(div);
}

function renderFriendItem(friend) {
    const div = document.createElement('div');
    div.className = 'list-item';
    div.innerHTML = `
        <div class="avatar ${friend.status}">${getInitials(friend.displayName)}</div>
        <div class="list-item-info">
            <div class="list-item-title">${friend.displayName}</div>
            <div class="list-item-meta">${friend.status === 'online' ? 'Online' : 'Offline'}</div>
        </div>
        <button class="icon-btn" style="width: 32px; height: 32px;" onclick="event.stopPropagation(); startCall('audio', '${friend._id}')">
            <i class="fas fa-phone" style="font-size: 12px;"></i>
        </button>
    `;
    div.onclick = () => selectChat(friend._id);
    contentList.appendChild(div);
}

function renderRequestItem(req) {
    const div = document.createElement('div');
    div.className = 'list-item';
    div.innerHTML = `
        <div class="avatar">${getInitials(req.from.displayName)}</div>
        <div class="list-item-info">
            <div class="list-item-title">${req.from.displayName}</div>
            <div class="list-item-meta">Wants to be your friend</div>
        </div>
        <div class="request-actions">
            <button class="request-btn accept" onclick="acceptRequest('${req._id}')">Accept</button>
            <button class="request-btn decline" onclick="declineRequest('${req._id}')">Decline</button>
        </div>
    `;
    contentList.appendChild(div);
}

async function selectChat(friendId) {
    selectedChat = friendId;
    const friend = friends.find(f => f._id === friendId);
    
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('chatHeader').style.display = 'flex';
    document.getElementById('messagesArea').style.display = 'flex';
    document.getElementById('inputArea').style.display = 'flex';
    
    document.getElementById('chatAvatar').textContent = getInitials(friend.displayName);
    document.getElementById('chatName').textContent = friend.displayName;
    document.getElementById('chatStatus').textContent = friend.status === 'online' ? 'Online' : 'Offline';
    
    const res = await fetch(`${API_URL}/api/messages/${friendId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const msgs = await res.json();
    messages[friendId] = msgs;
    
    renderMessages(friendId);
    renderList();
    
    await fetch(`${API_URL}/api/messages/read`, {
        method: 'POST',
        headers: { 
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ friendId })
    });
}

function renderMessages(friendId) {
    const area = document.getElementById('messagesArea');
    const indicator = document.getElementById('typingIndicator');
    area.innerHTML = '';
    
    const msgs = messages[friendId] || [];
    msgs.forEach(msg => renderMessage(msg, msg.sender === currentUser._id));
    
    area.appendChild(indicator);
    area.scrollTop = area.scrollHeight;
}

function renderMessage(msg, isSent) {
    const area = document.getElementById('messagesArea');
    const div = document.createElement('div');
    div.className = `message ${isSent ? 'sent' : 'received'}`;
    div.innerHTML = `
        ${msg.text}
        <div class="message-time">${new Date(msg.createdAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</div>
    `;
    area.appendChild(div);
    area.scrollTop = area.scrollHeight;
}

function sendMessage() {
    const input = document.getElementById('messageInput');
    const text = input.value.trim();
    if (!text || !selectedChat) return;
    
    socket.emit('send-message', { receiverId: selectedChat, text });
    
    const tempMsg = {
        text,
        sender: currentUser._id,
        createdAt: new Date().toISOString()
    };
    
    if (!messages[selectedChat]) messages[selectedChat] = [];
    messages[selectedChat].push(tempMsg);
    renderMessage(tempMsg, true);
    renderList();
    
    input.value = '';
    socket.emit('stop-typing', { receiverId: selectedChat });
}

function handleKeyPress(e) {
    if (e.key === 'Enter') sendMessage();
}

let typingTimeout;
function handleTyping() {
    if (!selectedChat) return;
    socket.emit('typing', { receiverId: selectedChat });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        socket.emit('stop-typing', { receiverId: selectedChat });
    }, 2000);
}

function showAddFriend() {
    document.getElementById('modalOverlay').classList.add('active');
    document.getElementById('friendSearch').focus();
}

function closeModal() {
    document.getElementById('modalOverlay').classList.remove('active');
    document.getElementById('friendSearch').value = '';
    document.getElementById('searchResults').innerHTML = '';
}

async function searchUsers() {
    const query = document.getElementById('friendSearch').value;
    if (query.length < 2) {
        document.getElementById('searchResults').innerHTML = '';
        return;
    }
    
    const res = await fetch(`${API_URL}/api/users/search?q=${query}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const users = await res.json();
    
    const resultsDiv = document.getElementById('searchResults');
    resultsDiv.innerHTML = '';
    users.forEach(user => {
        const div = document.createElement('div');
        div.className = 'search-result-item';
        div.innerHTML = `
            <div class="avatar">${getInitials(user.displayName)}</div>
            <div class="list-item-info">
                <div class="list-item-title">${user.displayName}</div>
                <div class="list-item-meta">@${user.username}</div>
            </div>
            <button class="btn btn-primary" style="padding: 6px 12px; font-size: 12px;" onclick="sendFriendRequest('${user._id}')">Add</button>
        `;
        resultsDiv.appendChild(div);
    });
}

async function sendFriendRequest(userId) {
    await fetch(`${API_URL}/api/friends/request`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ userId })
    });
    closeModal();
    showNotification('Friend request sent!');
}

async function acceptRequest(requestId) {
    await fetch(`${API_URL}/api/friends/respond`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ requestId, action: 'accept' })
    });
    requests = requests.filter(r => r._id !== requestId);
    loadFriends();
    renderList();
}

async function declineRequest(requestId) {
    await fetch(`${API_URL}/api/friends/respond`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ requestId, action: 'decline' })
    });
    requests = requests.filter(r => r._id !== requestId);
    renderList();
}

const servers = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

async function startCall(type, friendId) {
    const targetId = friendId || selectedChat;
    if (!targetId) return;
    
    const friend = friends.find(f => f._id === targetId);
    currentCall = { to: targetId, type };
    
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: type === 'video'
        });
        
        document.getElementById('localVideo').srcObject = localStream;
        document.getElementById('localVideo').style.display = type === 'video' ? 'block' : 'none';
        
        peerConnection = new RTCPeerConnection(servers);
        
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
        
        peerConnection.ontrack = (event) => {
            remoteStream = event.streams[0];
            document.getElementById('remoteVideo').srcObject = remoteStream;
        };
        
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('ice-candidate', {
                    receiverId: targetId,
                    candidate: event.candidate
                });
            }
        };
        
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        socket.emit('call-offer', {
            receiverId: targetId,
            offer: offer
        });
        
        showCallUI(friend, type);
    } catch (err) {
        alert('Could not access camera/microphone');
    }
}

async function acceptCall() {
    document.getElementById('incomingCallModal').classList.remove('active');
    
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: true
        });
        
        document.getElementById('localVideo').srcObject = localStream;
        
        peerConnection = new RTCPeerConnection(servers);
        
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
        
        peerConnection.ontrack = (event) => {
            remoteStream = event.streams[0];
            document.getElementById('remoteVideo').srcObject = remoteStream;
        };
        
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('ice-candidate', {
                    receiverId: currentCall.from,
                    candidate: event.candidate
                });
            }
        };
        
        await peerConnection.setRemoteDescription(new RTCSessionDescription(currentCall.offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        socket.emit('call-answer', {
            callerId: currentCall.from,
            answer: answer
        });
        
        const friend = friends.find(f => f._id === currentCall.from);
        showCallUI(friend, 'video');
    } catch (err) {
        alert('Could not access camera/microphone');
    }
}

function declineCall() {
    document.getElementById('incomingCallModal').classList.remove('active');
    if (currentCall) {
        socket.emit('end-call', { receiverId: currentCall.from });
    }
    currentCall = null;
}

function showCallUI(friend, type) {
    document.getElementById('callOverlay').classList.add('active');
    document.getElementById('callAvatar').textContent = getInitials(friend.displayName);
    document.getElementById('callStatus').textContent = type === 'video' ? 'Video Call' : 'Voice Call';
    startCallTimer();
}

function startCallTimer() {
    callSeconds = 0;
    callTimer = setInterval(() => {
        callSeconds++;
        const mins = Math.floor(callSeconds / 60).toString().padStart(2, '0');
        const secs = (callSeconds % 60).toString().padStart(2, '0');
        document.getElementById('callTimer').textContent = `${mins}:${secs}`;
    }, 1000);
}

function endCall() {
    document.getElementById('callOverlay').classList.remove('active');
    clearInterval(callTimer);
    callSeconds = 0;
    document.getElementById('callTimer').textContent = '00:00';
    
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    if (currentCall) {
        socket.emit('end-call', { receiverId: currentCall.to || currentCall.from });
    }
    
    currentCall = null;
}

function toggleMute() {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            isMuted = !isMuted;
            document.getElementById('muteIcon').className = isMuted ? 'fas fa-microphone-slash' : 'fas fa-microphone';
        }
    }
}

function toggleVideo() {
    if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            isVideoOff = !isVideoOff;
            document.getElementById('videoIcon').className = isVideoOff ? 'fas fa-video-slash' : 'fas fa-video';
        }
    }
}

function showNotification(message) {
    const div = document.createElement('div');
    div.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: var(--primary);
        color: white;
        padding: 15px 20px;
        border-radius: 10px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        z-index: 2000;
        animation: slideIn 0.3s ease;
    `;
    div.textContent = message;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 3000);
}

function toggleEmoji() {
    const emojis = ['😊', '😂', '❤️', '👍', '🎉', '🔥', '👋', '😎'];
    const input = document.getElementById('messageInput');
    input.value += emojis[Math.floor(Math.random() * emojis.length)];
    input.focus();
}

function handleSearch() {
    const query = document.getElementById('searchInput').value.toLowerCase();
    const items = document.querySelectorAll('.list-item');
    items.forEach(item => {
        const text = item.textContent.toLowerCase();
        item.style.display = text.includes(query) ? 'flex' : 'none';
    });
}

if (token) {
    initApp();
}