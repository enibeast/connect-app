import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { 
    origin: process.env.CLIENT_URL || "*", 
    methods: ["GET", "POST"] 
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// MongoDB Connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/connect-app');
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB connection error:', err);
    setTimeout(connectDB, 5000);
  }
};
connectDB();

// ============ MODELS ============

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  displayName: { type: String, required: true },
  avatar: { type: String, default: '' },
  status: { type: String, default: 'offline' },
  socketId: { type: String, default: '' },
  friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});

const MessageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const FriendRequestSchema = new mongoose.Schema({
  from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Message = mongoose.model('Message', MessageSchema);
const FriendRequest = mongoose.model('FriendRequest', FriendRequestSchema);

// ============ AUTH MIDDLEWARE ============

const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    req.userId = decoded.userId;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ============ REST API ROUTES ============

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password, displayName } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const user = new User({ username, email, password: hashedPassword, displayName });
    await user.save();
    
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'your-secret-key');
    res.json({ token, user: { id: user._id, username, displayName, email } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ error: 'User not found' });
    
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid password' });
    
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'your-secret-key');
    res.json({ token, user: { id: user._id, username: user.username, displayName: user.displayName, email: user.email } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/me', authenticate, async (req, res) => {
  const user = await User.findById(req.userId).select('-password');
  res.json(user);
});

app.get('/api/users/search', authenticate, async (req, res) => {
  const { q } = req.query;
  const users = await User.find({
    $and: [
      { _id: { $ne: req.userId } },
      {
        $or: [
          { username: { $regex: q, $options: 'i' } },
          { displayName: { $regex: q, $options: 'i' } }
        ]
      }
    ]
  }).select('username displayName avatar status');
  res.json(users);
});

app.get('/api/friends', authenticate, async (req, res) => {
  const user = await User.findById(req.userId).populate('friends', 'username displayName avatar status socketId');
  res.json(user.friends);
});

app.post('/api/friends/request', authenticate, async (req, res) => {
  const { userId } = req.body;
  
  const existing = await FriendRequest.findOne({
    $or: [
      { from: req.userId, to: userId },
      { from: userId, to: req.userId }
    ]
  });
  
  if (existing) return res.status(400).json({ error: 'Request already exists' });
  
  const request = new FriendRequest({ from: req.userId, to: userId });
  await request.save();
  
  const recipient = await User.findById(userId);
  if (recipient?.socketId) {
    io.to(recipient.socketId).emit('friend-request', {
      id: request._id,
      from: await User.findById(req.userId).select('username displayName avatar')
    });
  }
  
  res.json({ success: true });
});

app.get('/api/friends/requests', authenticate, async (req, res) => {
  const requests = await FriendRequest.find({ to: req.userId, status: 'pending' })
    .populate('from', 'username displayName avatar');
  res.json(requests);
});

app.post('/api/friends/respond', authenticate, async (req, res) => {
  const { requestId, action } = req.body;
  const request = await FriendRequest.findById(requestId);
  
  if (!request || request.to.toString() !== req.userId) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  
  if (action === 'accept') {
    request.status = 'accepted';
    await request.save();
    
    await User.findByIdAndUpdate(req.userId, { $push: { friends: request.from } });
    await User.findByIdAndUpdate(request.from, { $push: { friends: req.userId } });
    
    const sender = await User.findById(request.from);
    if (sender?.socketId) {
      io.to(sender.socketId).emit('friend-accepted', { userId: req.userId });
    }
  } else {
    request.status = 'declined';
    await request.save();
  }
  
  res.json({ success: true });
});

app.get('/api/messages/:friendId', authenticate, async (req, res) => {
  const messages = await Message.find({
    $or: [
      { sender: req.userId, receiver: req.params.friendId },
      { sender: req.params.friendId, receiver: req.userId }
    ]
  }).sort({ createdAt: 1 }).limit(100);
  res.json(messages);
});

app.post('/api/messages/read', authenticate, async (req, res) => {
  const { friendId } = req.body;
  await Message.updateMany(
    { sender: friendId, receiver: req.userId, read: false },
    { read: true }
  );
  res.json({ success: true });
});

// ============ SOCKET.IO ============

const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('authenticate', async (token) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
      const userId = decoded.userId;
      
      await User.findByIdAndUpdate(userId, { status: 'online', socketId: socket.id });
      onlineUsers.set(userId.toString(), socket.id);
      
      socket.userId = userId;
      socket.join(userId.toString());
      
      const user = await User.findById(userId).populate('friends');
      user.friends.forEach(friend => {
        const friendSocket = onlineUsers.get(friend._id.toString());
        if (friendSocket) {
          io.to(friendSocket).emit('user-status', { userId, status: 'online' });
        }
      });
      
      socket.emit('authenticated', { userId });
    } catch (err) {
      socket.emit('auth-error', { error: 'Invalid token' });
    }
  });
  
  socket.on('send-message', async (data) => {
    try {
      const { receiverId, text } = data;
      
      const message = new Message({
        sender: socket.userId,
        receiver: receiverId,
        text
      });
      await message.save();
      
      const receiverSocket = onlineUsers.get(receiverId);
      if (receiverSocket) {
        io.to(receiverSocket).emit('new-message', {
          id: message._id,
          sender: socket.userId,
          text,
          createdAt: message.createdAt
        });
      }
      
      socket.emit('message-sent', { id: message._id, createdAt: message.createdAt });
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });
  
  socket.on('typing', (data) => {
    const receiverSocket = onlineUsers.get(data.receiverId);
    if (receiverSocket) {
      io.to(receiverSocket).emit('typing', { userId: socket.userId });
    }
  });
  
  socket.on('stop-typing', (data) => {
    const receiverSocket = onlineUsers.get(data.receiverId);
    if (receiverSocket) {
      io.to(receiverSocket).emit('stop-typing', { userId: socket.userId });
    }
  });
  
  socket.on('call-offer', (data) => {
    const receiverSocket = onlineUsers.get(data.receiverId);
    if (receiverSocket) {
      io.to(receiverSocket).emit('call-offer', {
        from: socket.userId,
        offer: data.offer
      });
    }
  });
  
  socket.on('call-answer', (data) => {
    const callerSocket = onlineUsers.get(data.callerId);
    if (callerSocket) {
      io.to(callerSocket).emit('call-answer', { answer: data.answer });
    }
  });
  
  socket.on('ice-candidate', (data) => {
    const receiverSocket = onlineUsers.get(data.receiverId);
    if (receiverSocket) {
      io.to(receiverSocket).emit('ice-candidate', {
        from: socket.userId,
        candidate: data.candidate
      });
    }
  });
  
  socket.on('end-call', (data) => {
    const receiverSocket = onlineUsers.get(data.receiverId);
    if (receiverSocket) {
      io.to(receiverSocket).emit('call-ended');
    }
  });
  
  socket.on('disconnect', async () => {
    if (socket.userId) {
      await User.findByIdAndUpdate(socket.userId, { status: 'offline', socketId: '' });
      onlineUsers.delete(socket.userId.toString());
      
      const user = await User.findById(socket.userId).populate('friends');
      user.friends.forEach(friend => {
        const friendSocket = onlineUsers.get(friend._id.toString());
        if (friendSocket) {
          io.to(friendSocket).emit('user-status', { userId: socket.userId, status: 'offline' });
        }
      });
    }
    console.log('User disconnected:', socket.id);
  });
});

app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});