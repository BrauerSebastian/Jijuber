const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// User Schema
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['client', 'peluquero'], default: 'client' },
});

const User = mongoose.model('User', userSchema);

// Peluquero Schema
const peluqueroSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  specialty: { type: String, required: true },
  zone: { type: String, required: true },
  services: [{
    name: { type: String, required: true },
    price: { type: Number, required: true },
  }],
  rating: { type: Number, default: 0 },
  reviews: { type: Number, default: 0 },
});

const Peluquero = mongoose.model('Peluquero', peluqueroSchema);

// Appointment Schema
const appointmentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  peluqueroId: { type: mongoose.Schema.Types.ObjectId, ref: 'Peluquero', required: true },
  service: { type: String, required: true },
  date: { type: Date, required: true },
  time: { type: String, required: true },
  modality: { type: String, enum: ['domicilio', 'salon'], required: true },
  address: { type: String },
  status: { type: String, enum: ['pending', 'confirmed', 'completed', 'cancelled'], default: 'pending' },
  total: { type: Number, required: true },
});

const Appointment = mongoose.model('Appointment', appointmentSchema);

// Middleware to verify JWT
const authMiddleware = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'No token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid token' });
  }
};

// Register Endpoint
app.post('/api/register', async (req, res) => {
  const { name, email, phone, password, role } = req.body;

  try {
    // Validate input
    if (!name || !email || !phone || !password) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Email already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const user = new User({
      name,
      email,
      phone,
      password: hashedPassword,
      role: role || 'client',
    });

    await user.save();

    // If peluquero, create peluquero profile
    if (role === 'peluquero') {
      const peluquero = new Peluquero({
        userId: user._id,
        specialty: req.body.specialty || 'General',
        zone: req.body.zone || 'Unknown',
        services: req.body.services || [],
      });
      await peluquero.save();
    }

    res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Login Endpoint
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    // Validate input
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Generate JWT
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({ token, user: { id: user._id, name: user.name, role: user.role } });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Book Appointment Endpoint
app.post('/api/appointments', authMiddleware, async (req, res) => {
  const { peluqueroId, service, date, time, modality, address } = req.body;

  try {
    // Validate input
    if (!peluqueroId || !service || !date || !time || !modality) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    // Check if peluquero exists
    const peluquero = await Peluquero.findById(peluqueroId);
    if (!peluquero) {
      return res.status(404).json({ message: 'Peluquero not found' });
    }

    // Find service price
    const selectedService = peluquero.services.find(s => s.name === service);
    if (!selectedService) {
      return res.status(400).json({ message: 'Service not offered by this peluquero' });
    }

    // Calculate total (add $500 for domicilio)
    const total = modality === 'domicilio' ? selectedService.price + 500 : selectedService.price;

    // Check availability (simplified: ensure no overlapping appointments)
    const existingAppointment = await Appointment.findOne({
      peluqueroId,
      date: new Date(date),
      time,
      status: { $in: ['pending', 'confirmed'] },
    });

    if (existingAppointment) {
      return res.status(400).json({ message: 'Time slot is already booked' });
    }

    // Create appointment
    const appointment = new Appointment({
      userId: req.user.userId,
      peluqueroId,
      service,
      date: new Date(date),
      time,
      modality,
      address: modality === 'domicilio' ? address : null,
      total,
    });

    await appointment.save();

    res.status(201).json({ message: 'Appointment booked successfully', appointment });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Get User Appointments Endpoint
app.get('/api/appointments', authMiddleware, async (req, res) => {
  try {
    const appointments = await Appointment.find({ userId: req.user.userId })
      .populate('peluqueroId', 'specialty zone')
      .sort({ date: -1 });
    res.json(appointments);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Get Peluquero Profile Endpoint
app.get('/api/peluqueros/:id', async (req, res) => {
  try {
    const peluquero = await Peluquero.findById(req.params.id)
      .populate('userId', 'name');
    if (!peluquero) {
      return res.status(404).json({ message: 'Peluquero not found' });
    }
    res.json(peluquero);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Get All Peluqueros Endpoint
app.get('/api/peluqueros', async (req, res) => {
  try {
    const peluqueros = await Peluquero.find()
      .populate('userId', 'name');
    res.json(peluqueros);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));